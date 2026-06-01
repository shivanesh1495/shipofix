import { useCallback, useEffect, useState } from "react";
import { redirect, useActionData, useFetcher, useLoaderData, useLocation, useRevalidator } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  ensureCarrierService,
  getCallbackUrl,
  CARRIER_SERVICE_NAME,
} from "../lib/carrier.server.js";
import { getEntitledPlan } from "../lib/billing.server.js";
import {
  reconcileBulkCoverageZone,
  isManagedZoneName,
} from "../lib/coverage.server.js";
import {
  FREE_ZONE_LIMIT,
  PLANS,
  canBulkEdit,
  canCreateAnotherZone,
} from "../lib/plan.js";
import {
  QUERY_CARRIER_SERVICES,
  QUERY_DELIVERY_ZONES,
  MUTATION_DELIVERY_PROFILE_UPDATE,
  MUTATION_DELETE_CARRIER,
  MUTATION_UPDATE_CARRIER,
} from "../lib/graphql.js";

/* ── Components ── */
import RulesOverview from "../components/RulesOverview";
import ZoneModal from "../components/ZoneModal";
import EditRuleModal from "../components/EditRuleModal";
import BulkEdit from "../components/BulkEdit";

/* ───────────────────────────── Loader ──────────────────────────────── */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  /* Gate the dashboard behind plan selection — first-time visitors land on
     the picker, returning visitors with a saved plan skip straight here.
     Preserve the embedded ?shop=&host=&embedded= query string on the
     redirect; without them the iframe loses Shopify context and the
     framework bounces to /auth/login. */
  /* getEntitledPlan == getShopPlan when billing is off. When billing is on it
     downgrades a paid tier to Free unless a Razorpay subscription is active,
     so an unpaid shop can never reach the paid dashboard features. */
  const plan = await getEntitledPlan(shopDomain);
  if (!plan) {
    const search = new URL(request.url).search;
    throw redirect(`/app/subscription${search}`);
  }

  const carrierStatus = await ensureCarrierService(admin);

  // Fetch zones from Shopify
  const zoneQuery = await admin.graphql(QUERY_DELIVERY_ZONES);
  const zoneJson = await zoneQuery.json();
  const shopCountry = zoneJson?.data?.shop?.billingAddress?.countryCodeV2;
  const profiles = zoneJson?.data?.deliveryProfiles?.edges || [];

  const generalProfile =
    profiles.find((p) => p.node.default)?.node || profiles[0]?.node;
  const profileId = generalProfile?.id || null;
  const locationGroupId =
    generalProfile?.profileLocationGroups?.[0]?.locationGroup?.id || null;

  /* Deduplicate zones from all profiles, track method definitions so we can
     auto-attach the carrier service to any newly-created zone that doesn't
     yet have a method (without this Shopify never calls our endpoint). */
  const zoneMap = new Map();
  const zonesWithoutMethods = [];
  profiles.forEach(({ node: profile }) => {
    profile.profileLocationGroups.forEach((group) => {
      group.locationGroupZones.edges.forEach(({ node: zoneNode }) => {
        const z = zoneNode.zone;
        const methodCount = zoneNode.methodDefinitions?.edges?.length || 0;
        if (!zoneMap.has(z.id)) {
          const countries = z.countries.map((c) => ({
            countryCode: c.code.countryCode,
            name: c.name,
            restOfWorld: !!c.code.restOfWorld,
            provinces: c.provinces || [],
          }));
          zoneMap.set(z.id, {
            id: z.id,
            name: z.name,
            profileName: profile.name,
            countries,
            isDomestic: countries.some((c) => c.countryCode === shopCountry),
            hasMethodDefinition: methodCount > 0,
          });
          /* The auto-managed bulk-coverage zone owns its own method and is
             reconciled separately — never treat it as a stray zone to patch. */
          if (methodCount === 0 && !isManagedZoneName(z.name))
            zonesWithoutMethods.push(z.id);
        }
      });
    });
  });

  /* ── Auto-fix: attach carrier service to zones without method definitions ── */
  if (zonesWithoutMethods.length > 0 && profileId && locationGroupId) {
    let carrierServiceId = null;
    try {
      const csQuery = await admin.graphql(QUERY_CARRIER_SERVICES);
      const csJson = await csQuery.json();
      const services = csJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
      const activeService = services.find((s) => s.active);
      carrierServiceId = activeService?.id || services[0]?.id || null;
    } catch (_e) {
      console.error("[AUTO-FIX] Failed to query carrier services:", _e);
    }

    if (carrierServiceId) {
      for (const zoneId of zonesWithoutMethods) {
        try {
          const fixRes = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
            variables: {
              profileId,
              profile: {
                locationGroupsToUpdate: [
                  {
                    id: locationGroupId,
                    zonesToUpdate: [
                      {
                        id: zoneId,
                        methodDefinitionsToCreate: [
                          {
                            name: "Custom Carrier Shipping",
                            active: true,
                            participant: {
                              carrierServiceId,
                              adaptToNewServices: true,
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          });
          const fixJson = await fixRes.json();
          const fixErrors = fixJson?.data?.deliveryProfileUpdate?.userErrors || [];
          if (fixErrors.length === 0) {
            const z = zoneMap.get(zoneId);
            if (z) z.hasMethodDefinition = true;
          }
        } catch (fixErr) {
          console.error(`[AUTO-FIX] Zone ${zoneId} exception:`, fixErr.message);
        }
      }
    }
  }

  /* ── Auto-cleanup: remove native (flat-rate) methods from Shipofix zones ──
     When a zone has BOTH our carrier method AND a native Shopify method
     (e.g. "Standard: Free"), customers see both options at checkout and
     can pick the free native rate, bypassing the configured Shipofix rate.

     Detection strategy (two layers so neither alone can miss):
       PRIMARY  — rateProvider.__typename from the GraphQL query.
                  "DeliveryParticipant"  → carrier-backed (keep)
                  "DeliveryRateDefinition" → native flat/price rate (delete)
       FALLBACK — if rateProvider is null/unavailable (some API versions):
                  method name === "Custom Carrier Shipping" → keep (it's ours)
                  any other name → delete (native or unknown method)

     Only runs when carrier is active; never touches the auto-managed
     bulk-coverage zone. */
  if (carrierStatus.state === "success" && profileId && locationGroupId) {
    /* Decide whether a method definition belongs to Shipofix's carrier.
       Returns true  → our method, keep it.
       Returns false → native or unknown method, delete it. */
    const isOurCarrierMethod = (m) => {
      const tp = m.rateProvider?.__typename;
      if (tp === "DeliveryParticipant") return true;      // primary: API confirmed carrier
      if (tp === "DeliveryRateDefinition") return false;  // primary: API confirmed native
      // Fallback: rateProvider not returned — use the name we always assign
      return m.name === "Custom Carrier Shipping";
    };

    const zonesToPurgeNative = [];
    profiles.forEach(({ node: profile }) => {
      profile.profileLocationGroups.forEach((group) => {
        group.locationGroupZones.edges.forEach(({ node: zoneNode }) => {
          const z = zoneNode.zone;
          if (isManagedZoneName(z.name)) return;
          const methods = zoneNode.methodDefinitions?.edges?.map((e) => e.node) || [];
          if (methods.length === 0) return;

          const hasCarrier = methods.some(isOurCarrierMethod);
          const nativeIds = methods
            .filter((m) => !isOurCarrierMethod(m))
            .map((m) => m.id);

          if (hasCarrier && nativeIds.length > 0) {
            console.log(
              `[AUTO-CLEANUP] Zone "${z.name}": found ${nativeIds.length} competing method(s) alongside Shipofix carrier — will remove them so only Shipofix rates show at checkout.`,
            );
            zonesToPurgeNative.push({ zoneId: z.id, zoneName: z.name, nativeIds });
          }
        });
      });
    });

    for (const { zoneId, zoneName, nativeIds } of zonesToPurgeNative) {
      try {
        const purgeRes = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
          variables: {
            profileId,
            profile: {
              locationGroupsToUpdate: [
                {
                  id: locationGroupId,
                  zonesToUpdate: [
                    { id: zoneId, methodDefinitionsToDelete: nativeIds },
                  ],
                },
              ],
            },
          },
        });
        const purgeJson = await purgeRes.json();
        const purgeErrors = purgeJson?.data?.deliveryProfileUpdate?.userErrors || [];
        if (purgeErrors.length === 0) {
          console.log(
            `[AUTO-CLEANUP] Removed ${nativeIds.length} competing method(s) from zone "${zoneName}" — only Shipofix rates will now appear at checkout for this zone.`,
          );
        } else {
          console.error(`[AUTO-CLEANUP] Zone "${zoneName}" purge errors:`, purgeErrors);
        }
      } catch (purgeErr) {
        console.error(`[AUTO-CLEANUP] Zone "${zoneName}" exception:`, purgeErr.message);
      }
    }
  }

  const uniqueZones = Array.from(zoneMap.values());

  /* The auto-managed bulk-coverage zone exists only to make Shopify call our
     carrier for Excel rules — it's never a merchant-editable rule, so keep it
     out of the rules table, placeholder creation, and the UI zone list. */
  const realZones = uniqueZones.filter((z) => !isManagedZoneName(z.name));

  /* ── Sync zone-wise rules (source='shopify') with the live Shopify zone
     list. We update the rule's name/countries when the underlying Shopify
     zone changes, and clean up orphaned rules whose zone was deleted. ── */
  const shopifyRules = await prisma.zoneRule.findMany({
    where: { shop: shopDomain, source: "shopify" },
  });
  const rulesByGid = new Map(shopifyRules.map((r) => [r.deliveryZoneGid, r]));
  const activeZoneGids = new Set(uniqueZones.map((z) => z.id));

  const syncs = uniqueZones
    .map((z) => {
      const existing = rulesByGid.get(z.id);
      const countriesStr = JSON.stringify(z.countries);
      if (
        existing &&
        (existing.name !== z.name || existing.countries !== countriesStr)
      ) {
        return prisma.zoneRule.update({
          where: { id: existing.id },
          data: { name: z.name, countries: countriesStr },
        });
      }
      return null;
    })
    .filter(Boolean);

  const orphans = shopifyRules.filter((r) => !activeZoneGids.has(r.deliveryZoneGid));
  if (orphans.length > 0) {
    console.log(
      `Cleaning up ${orphans.length} orphaned zone rule(s): ${orphans.map((r) => `${r.name}(${r.deliveryZoneGid})`).join(", ")}`,
    );
    orphans.forEach((r) =>
      syncs.push(prisma.zoneRule.delete({ where: { id: r.id } })),
    );
  }
  if (syncs.length > 0) await prisma.$transaction(syncs);

  /* Auto-create placeholder rules for any Shopify zone that doesn't have a
     ZoneRule yet — so a zone the vendor created via "Add new zone" shows up
     in the All rates table even before they've picked a pricing model. */
  const missingZones = realZones.filter((z) => !rulesByGid.has(z.id));
  if (missingZones.length > 0) {
    for (const z of missingZones) {
      try {
        await prisma.zoneRule.create({
          data: {
            shop: shopDomain,
            deliveryZoneGid: z.id,
            name: z.name,
            countries: JSON.stringify(z.countries),
            logicType: "DEFAULT",
            currency: "USD",
            rulesJson: "{}",
            source: "shopify",
          },
        });
      } catch (_e) {
        /* unique constraint failure means another request raced us — fine */
      }
    }
  }

  /* ── Auto-managed coverage for bulk (Excel) rules ──
     Bulk rules carry a synthetic GID and own no Shopify zone, so Shopify never
     calls our carrier for them unless some zone covers their countries. Keep a
     single managed zone in sync with the bulk rules' coverage so Excel-only
     setups actually quote at checkout. Only while connected — a disconnected
     shop deliberately hands shipping back to Shopify, so we touch nothing. */
  if (carrierStatus.state === "success" && profileId && locationGroupId) {
    try {
      await reconcileBulkCoverageZone({
        admin,
        shopDomain,
        profileId,
        locationGroupId,
        zones: uniqueZones,
      });
    } catch (e) {
      console.error("[COVERAGE] reconcile failed:", e?.message);
    }
  }

  /* Fresh read after sync — single source of truth for the UI. */
  const allRules = await prisma.zoneRule.findMany({
    where: { shop: shopDomain },
    orderBy: { updatedAt: "desc" },
  });

  return {
    rules: allRules,
    zones: realZones,
    carrierStatus,
    shopCountry,
    profileId,
    locationGroupId,
    shippingUrl: `https://${shopDomain}/admin/settings/shipping`,
    plan,
    zoneCount: realZones.length,
  };
};

/* ───────────────────────────── Action ──────────────────────────────── */

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  /* ── Save / update a rule (zone-wise OR bulk-source) ── */
  if (intent === "save_rule") {
    const id = formData.get("id");
    const nameTrimmed = String(formData.get("name") || "").trim();
    const logicType = String(formData.get("logicType") || "").trim();
    const rulesJsonRaw = String(formData.get("rulesJson") || "{}");
    const currency = String(formData.get("currency") || "USD").trim().toUpperCase() || "USD";

    if (!id) return { success: false, error: "Missing rule id." };

    const existing = await prisma.zoneRule.findFirst({
      where: { id, shop: shopDomain },
    });
    if (!existing) return { success: false, error: "Rule not found." };

    /* Validate name — only bulk rules can be renamed here. Zone-wise rule
       names are owned by the Shopify delivery zone and synced by the loader
       on every page load, so any rename submitted here would be silently
       reverted. We keep the existing name for shopify-source rules so the
       Edit modal can't accidentally corrupt it. */
    if (existing.source === "bulk" && !nameTrimmed) {
      return { success: false, error: "Rule name can't be empty." };
    }

    /* Validate logicType — must be a known type or DEFAULT. */
    const VALID_LOGIC_TYPES = new Set([
      "DEFAULT", "STANDARD_TIER", "WEIGHT_RANGE", "PRICE_RANGE",
      "WEIGHT_MULTIPLIER", "WEIGHT_RANGE_PER_KG", "PRICE_MULTIPLIER", "ITEM_MULTIPLIER",
    ]);
    if (!VALID_LOGIC_TYPES.has(logicType)) {
      return { success: false, error: `Unknown pricing model "${logicType}".` };
    }

    /* Validate rulesJson is parseable JSON. */
    try {
      JSON.parse(rulesJsonRaw);
    } catch {
      return { success: false, error: "Pricing data is malformed — please re-enter the rate values." };
    }

    /* For zone-wise rules: name is owned by Shopify; use the stored name.
       For bulk rules: allow the merchant-supplied name. */
    const nameToSave = existing.source === "bulk" ? nameTrimmed : existing.name;

    await prisma.zoneRule.update({
      where: { id },
      data: { name: nameToSave, logicType, rulesJson: rulesJsonRaw, currency },
    });

    return { success: true, message: `"${nameToSave}" saved.` };
  }

  /* ── Delete a rule ──
     For zone-wise rules we delete BOTH the Shopify delivery zone AND the
     ZoneRule row. For bulk rules we only delete the ZoneRule row (the
     Shopify zones aren't owned by the bulk rule). */
  if (intent === "delete_rule") {
    const id = formData.get("id");
    if (!id) return { success: false, error: "Missing rule id." };

    const rule = await prisma.zoneRule.findFirst({
      where: { id, shop: shopDomain },
    });
    if (!rule) return { success: false, error: "Rule not found." };

    /* Guard: never let the shop drop to zero rules. With no rules the carrier
       service still answers checkout requests but matches nothing, so Shopify
       gets empty rates and customers can't pick a shipping option. Point the
       merchant at Disconnect, which deactivates the carrier service so the
       store falls back to Shopify's native rates instead. */
    const totalRules = await prisma.zoneRule.count({ where: { shop: shopDomain } });
    if (totalRules <= 1) {
      return {
        success: false,
        error:
          "You can't delete the last rule — checkout would have no rates to return. Use \"Disconnect Shipofix\" to hand shipping back to Shopify's native rates.",
      };
    }

    if (rule.source === "shopify") {
      const profileId = formData.get("profileId");
      const locationGroupId = formData.get("locationGroupId");
      if (profileId && locationGroupId) {
        const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
          variables: {
            profileId,
            profile: {
              locationGroupsToUpdate: [
                {
                  id: locationGroupId,
                  zonesToDelete: [rule.deliveryZoneGid],
                },
              ],
            },
          },
        });
        const resJson = await res.json();
        const errors = resJson?.data?.deliveryProfileUpdate?.userErrors || [];
        if (errors.length > 0) {
          return { success: false, error: errors.map((e) => e.message).join(", ") };
        }
      }
    }

    await prisma.zoneRule.delete({ where: { id } });
    return { success: true, message: `"${rule.name}" deleted.` };
  }

  /* ── Bulk-delete multiple rules ── */
  if (intent === "delete_bulk") {
    const ids = JSON.parse(formData.get("ids") || "[]");
    if (ids.length === 0) return { success: false, error: "No rules selected." };

    const dbRules = await prisma.zoneRule.findMany({
      where: { id: { in: ids }, shop: shopDomain },
    });

    /* Guard BEFORE any Shopify mutation: a selection that covers every
       remaining rule would empty the ruleset, leaving checkout with no rates
       to return (and, for zone-wise rules, irreversibly deleting the store's
       Shopify delivery zones). Block it and point at Disconnect, which cleanly
       hands shipping back to Shopify's native rates. */
    const totalRules = await prisma.zoneRule.count({ where: { shop: shopDomain } });
    if (dbRules.length >= totalRules) {
      return {
        success: false,
        error:
          "You can't delete every rule at once — checkout would have no rates to return. Keep at least one rule, or use \"Disconnect Shipofix\" to hand shipping back to Shopify's native rates.",
      };
    }

    const shopifyGids = dbRules
      .filter((r) => r.source === "shopify" && r.deliveryZoneGid)
      .map((r) => r.deliveryZoneGid);

    if (shopifyGids.length > 0) {
      const profileId = formData.get("profileId");
      const locationGroupId = formData.get("locationGroupId");
      if (profileId && locationGroupId) {
        const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
          variables: {
            profileId,
            profile: {
              locationGroupsToUpdate: [
                {
                  id: locationGroupId,
                  zonesToDelete: shopifyGids,
                },
              ],
            },
          },
        });
        const resJson = await res.json();
        const errors = resJson?.data?.deliveryProfileUpdate?.userErrors || [];
        if (errors.length > 0) {
          return { success: false, error: errors.map((e) => e.message).join(", ") };
        }
      }
    }

    await prisma.zoneRule.deleteMany({ where: { id: { in: ids } } });
    return {
      success: true,
      message: `${dbRules.length} rule${dbRules.length === 1 ? "" : "s"} deleted.`,
    };
  }

  /* ── Disconnect Shipofix ──
     Deliberate teardown / escape hatch from the delete guards. Rather than
     deleting rules (destructive, and zone-wise rules own real Shopify zones),
     we deactivate the carrier service. Shopify then stops calling our endpoint
     and falls back to the store's native shipping rates — the consistent
     "Shipofix is off" state. Rules stay in the DB so reconnecting restores
     everything. */
  if (intent === "disconnect") {
    const callbackUrl = getCallbackUrl();
    const queryResponse = await admin.graphql(QUERY_CARRIER_SERVICES);
    const queryJson = await queryResponse.json();
    const services =
      queryJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
    const ours =
      services.find((s) => callbackUrl && s.callbackUrl === callbackUrl) ||
      services.find((s) => s.name === CARRIER_SERVICE_NAME);

    /* Carrier not found → already disconnected. Treat as success so the
       Disconnect button never gets stuck — the end state (no active carrier)
       is exactly what the user asked for. */
    if (!ours) {
      return {
        success: true,
        message:
          "Shipofix is already disconnected — your store is using Shopify's native shipping rates.",
      };
    }

    /* Already inactive — nothing to do. */
    if (!ours.active) {
      return {
        success: true,
        message:
          "Shipofix is already disconnected — your store is using Shopify's native shipping rates.",
      };
    }

    const res = await admin.graphql(MUTATION_UPDATE_CARRIER, {
      variables: { input: { id: ours.id, active: false } },
    });
    const resJson = await res.json();
    const errors = resJson?.data?.carrierServiceUpdate?.userErrors || [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    return {
      success: true,
      message:
        "Shipofix disconnected — your store now uses Shopify's native shipping rates. Reconnect any time from this page.",
    };
  }

  /* ── Reconnect Shipofix ── reactivate the carrier service so Shopify
     resumes calling our endpoint for live rates. If the service was deleted
     from Shopify admin entirely, ensureCarrierService recreates it. */
  if (intent === "reconnect") {
    const callbackUrl = getCallbackUrl();
    const queryResponse = await admin.graphql(QUERY_CARRIER_SERVICES);
    const queryJson = await queryResponse.json();
    const services =
      queryJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
    const ours =
      services.find((s) => callbackUrl && s.callbackUrl === callbackUrl) ||
      services.find((s) => s.name === CARRIER_SERVICE_NAME);

    /* Carrier was deleted entirely from Shopify admin — recreate it so the
       merchant doesn't have to refresh or re-install to get back online. */
    if (!ours) {
      const freshStatus = await ensureCarrierService(admin);
      if (freshStatus.state === "success") {
        return {
          success: true,
          message: "Shipofix reconnected — your configured rates are live at checkout again.",
        };
      }
      return {
        success: false,
        error: freshStatus.message || "Could not recreate the carrier service. Please refresh the page.",
      };
    }

    const res = await admin.graphql(MUTATION_UPDATE_CARRIER, {
      variables: { input: { id: ours.id, active: true } },
    });
    const resJson = await res.json();
    const errors = resJson?.data?.carrierServiceUpdate?.userErrors || [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    return {
      success: true,
      message: "Shipofix reconnected — your configured rates are live at checkout again.",
    };
  }

  /* ── Cleanup stale carrier services left behind by previous installs ── */
  if (intent === "cleanup_carrier_services") {
    const ids = JSON.parse(formData.get("ids") || "[]");
    for (const id of ids) {
      await admin.graphql(MUTATION_DELETE_CARRIER, { variables: { id } });
    }
    return { success: true, message: `Cleaned up ${ids.length} duplicate(s).` };
  }

  /* ── Create a new Shopify delivery zone (+ pre-create the ZoneRule row) ── */
  if (intent === "create_zone") {
    const profileId = formData.get("profileId");
    const locationGroupId = formData.get("locationGroupId");
    const zoneName = formData.get("zoneName");
    const countryCodes = JSON.parse(formData.get("countryCodes") || "{}");

    if (
      !profileId ||
      !locationGroupId ||
      !zoneName ||
      Object.keys(countryCodes).length === 0
    ) {
      return {
        success: false,
        error: "Please provide a zone name and at least one country.",
      };
    }

    /* Plan-tier gate — block Free shops who already hit FREE_ZONE_LIMIT.
       The UI hides the button at the cap, this is the server-side guard.
       getEntitledPlan ensures a lapsed/unpaid "advanced" shop is treated as
       Free here when billing is on. */
    const plan = await getEntitledPlan(shopDomain);
    if (plan === PLANS.FREE) {
      const existingZoneCount = await prisma.zoneRule.count({
        where: { shop: shopDomain, source: "shopify" },
      });
      if (!canCreateAnotherZone(plan, existingZoneCount)) {
        return {
          success: false,
          error: `The Free plan is limited to ${FREE_ZONE_LIMIT} shipping zones. Upgrade to Advanced or Premium for unlimited zones.`,
        };
      }
    }

    const countriesInput = Object.entries(countryCodes).map(([code, data]) => ({
      code,
      includeAllProvinces: !data.indeterminate,
      provinces: data.indeterminate
        ? data.provinces.map((p) => ({ code: p }))
        : [],
    }));

    /* Look up the active carrier service to attach it as a shipping method */
    let carrierServiceId = null;
    try {
      const csQuery = await admin.graphql(QUERY_CARRIER_SERVICES);
      const csJson = await csQuery.json();
      const services =
        csJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
      const activeService = services.find((s) => s.active);
      carrierServiceId = activeService?.id || services[0]?.id || null;
    } catch (_e) {
      console.error("Failed to query carrier services:", _e);
    }

    const zoneInput = { name: zoneName, countries: countriesInput };
    if (carrierServiceId) {
      zoneInput.methodDefinitionsToCreate = [
        {
          name: "Custom Carrier Shipping",
          active: true,
          participant: { carrierServiceId, adaptToNewServices: true },
        },
      ];
    }

    const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
      variables: {
        profileId,
        profile: {
          locationGroupsToUpdate: [
            {
              id: locationGroupId,
              zonesToCreate: [zoneInput],
            },
          ],
        },
      },
    });

    const resJson = await res.json();
    const errors = resJson?.data?.deliveryProfileUpdate?.userErrors || [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    /* Placeholder ZoneRule is created on the NEXT loader run when we see the
       new Shopify zone — we don't have its GID here yet. */
    return {
      success: true,
      message: `Zone "${zoneName}" created. Pick a pricing model from the Edit button to set rates.`,
    };
  }

  /* ── Update a bulk (Excel) rule's coverage only — no Shopify zone exists
       to mutate, so we just rewrite the ZoneRule.countries JSON. The user
       sees the change immediately; the next re-upload will overwrite it. ── */
  if (intent === "update_rule_coverage") {
    const id = formData.get("id");
    const countryCodes = JSON.parse(formData.get("countryCodes") || "{}");
    if (!id) return { success: false, error: "Missing rule id." };

    const rule = await prisma.zoneRule.findFirst({
      where: { id, shop: shopDomain },
    });
    if (!rule) return { success: false, error: "Rule not found." };

    /* Convert the {code: {checked, indeterminate, provinces}} map into the
       same {countryCode, name, restOfWorld, provinces[]} shape we already
       persist for zone-wise rules — keeps coverage rendering consistent. */
    const countriesArr = Object.entries(countryCodes).map(([code, data]) => {
      const provinces = data.indeterminate
        ? (data.provinces || []).map((p) => ({ code: p }))
        : [];
      return {
        countryCode: code,
        restOfWorld: code === "*" || code === "ROW",
        provinces,
      };
    });

    if (countriesArr.length === 0) {
      return { success: false, error: "Pick at least one country." };
    }

    /* Prune per-destination overrides that no longer match the new coverage,
       otherwise the View modal keeps showing stale rows (e.g. all 13 CA
       provinces) for a country whose coverage was just narrowed. We only
       touch the overrides array; the base rate and other fields are kept. */
    let nextRulesJson = rule.rulesJson;
    try {
      const parsed = JSON.parse(rule.rulesJson || "{}");
      if (Array.isArray(parsed.overrides)) {
        const coverageByCountry = new Map();
        for (const c of countriesArr) {
          if (!c.countryCode) continue;
          coverageByCountry.set(
            c.countryCode,
            new Set((c.provinces || []).map((p) => p.code)),
          );
        }
        parsed.overrides = parsed.overrides.filter((o) => {
          if (!coverageByCountry.has(o.countryCode)) return false;
          const provs = coverageByCountry.get(o.countryCode);
          /* Empty provinces set = whole country covered → keep any override */
          if (provs.size === 0) return true;
          return o.province ? provs.has(o.province) : true;
        });
        nextRulesJson = JSON.stringify(parsed);
      }
    } catch {
      /* leave rulesJson untouched if it isn't parseable */
    }

    await prisma.zoneRule.update({
      where: { id },
      data: { countries: JSON.stringify(countriesArr), rulesJson: nextRulesJson },
    });

    return { success: true, message: `"${rule.name}" coverage updated.` };
  }

  /* ── Update a Shopify zone's countries (called from "Change countries") ── */
  if (intent === "update_zone") {
    const profileId = formData.get("profileId");
    const locationGroupId = formData.get("locationGroupId");
    const zoneId = formData.get("zoneId");
    const zoneName = formData.get("zoneName");
    const countryCodes = JSON.parse(formData.get("countryCodes") || "{}");

    if (!profileId || !locationGroupId || !zoneId) {
      return { success: false, error: "Missing required IDs." };
    }

    if (Object.keys(countryCodes).length === 0) {
      return { success: false, error: "Please select at least one country." };
    }

    const countriesInput = Object.entries(countryCodes).map(([code, data]) => ({
      code,
      includeAllProvinces: !data.indeterminate,
      provinces: data.indeterminate
        ? data.provinces.map((p) => ({ code: p }))
        : [],
    }));

    const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
      variables: {
        profileId,
        profile: {
          locationGroupsToUpdate: [
            {
              id: locationGroupId,
              zonesToUpdate: [
                { id: zoneId, name: zoneName, countries: countriesInput },
              ],
            },
          ],
        },
      },
    });

    const resJson = await res.json();
    const errors = resJson?.data?.deliveryProfileUpdate?.userErrors || [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true, message: `Zone "${zoneName}" updated.` };
  }

  return { success: false, error: "Unknown intent" };
};

/* ──────────────────────────── Component ─────────────────────────────── */

export default function ShippingDashboard() {
  const {
    rules,
    zones,
    carrierStatus,
    shopCountry,
    profileId,
    locationGroupId,
    plan,
    zoneCount,
  } = useLoaderData();
  const bulkEditEnabled = canBulkEdit(plan);
  const atZoneCap = !canCreateAnotherZone(plan, zoneCount);
  /* Carry the embedded ?shop=&host= query string onto in-app navigations so
     the Shopify iframe keeps its auth context. */
  const location = useLocation();
  const subscriptionHref = `/app/subscription${location.search}`;
  const actionData = useActionData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [selectedTab, setSelectedTab] = useState(0);

  // Table filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [sortOrder, setSortOrder] = useState("NAME_ASC");
  const [filterZoneType, setFilterZoneType] = useState("ALL");

  // ZoneModal state (create new zone OR change countries on an existing rule)
  const [zoneModalMode, setZoneModalMode] = useState(null);
  const [modalZoneName, setModalZoneName] = useState("");
  const [modalSelectedRegions, setModalSelectedRegions] = useState({});
  const [expandedCountries, setExpandedCountries] = useState(new Set());
  const [editingZoneId, setEditingZoneId] = useState(null);
  const [editingBulkRuleId, setEditingBulkRuleId] = useState(null);
  const [countrySearch, setCountrySearch] = useState("");

  // EditRuleModal state
  const [editingRule, setEditingRule] = useState(null);

  // Toast
  const [toastMsg, setToastMsg] = useState(null);

  /* Toast lifetime scaled to message length — short confirmations
     auto-dismiss quickly, longer errors stay on screen long enough to
     actually read. Errors never disappear in under 8s. */
  const toastDuration = (msg, isError) => {
    const base = isError ? 8000 : 4000;
    const perChar = isError ? 60 : 35;
    return Math.min(20000, base + String(msg || "").length * perChar);
  };

  // Feedback from fetcher
  useEffect(() => {
    if (fetcher.data?.message) {
      setToastMsg(fetcher.data.message);
      revalidator.revalidate();
      setTimeout(() => setToastMsg(null), toastDuration(fetcher.data.message, false));
    }
    if (fetcher.data?.error) {
      const m = `Error: ${fetcher.data.error}`;
      setToastMsg(m);
      setTimeout(() => setToastMsg(null), toastDuration(m, true));
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (actionData?.message) {
      setToastMsg(actionData.message);
      setTimeout(() => setToastMsg(null), toastDuration(actionData.message, false));
    }
    if (actionData?.error) {
      const m = `Error: ${actionData.error}`;
      setToastMsg(m);
      setTimeout(() => setToastMsg(null), toastDuration(m, true));
    }
  }, [actionData]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── ZoneModal handlers ── */
  const openCreateModal = useCallback(() => {
    setZoneModalMode("create");
    setModalZoneName("");
    setModalSelectedRegions({});
    setExpandedCountries(new Set());
    setEditingZoneId(null);
    setCountrySearch("");
    shopify.modal.show("zone-modal");
  }, []);

  /* "Change countries" from the Edit Rule modal opens this modal seeded
     with the rule's current coverage. Works for both zone-wise rules
     (mutates the Shopify zone) and bulk rules (just rewrites the ZoneRule
     row — no Shopify zone exists for these). */
  const openChangeCountries = useCallback((rule) => {
    /* Build the seed regions map from whichever source carries the rule's
       current coverage. Zone-wise rules pull from the live Shopify zone so
       we always reflect the latest server state; bulk rules pull from the
       ZoneRule.countries JSON since they have no Shopify zone. */
    let seedCountries = [];
    let seedName = rule.name || "";
    const isBulkRule = rule.source === "bulk";

    if (isBulkRule) {
      try {
        seedCountries = JSON.parse(rule.countries || "[]");
      } catch {
        seedCountries = [];
      }
    } else {
      const z = zones.find((zo) => zo.id === rule.deliveryZoneGid);
      if (!z) return;
      seedCountries = z.countries;
      seedName = z.name;
    }

    setZoneModalMode(isBulkRule ? "edit-bulk" : "edit");
    setModalZoneName(seedName);
    const initialRegions = {};
    seedCountries.forEach((c) => {
      if (!c.countryCode && !c.restOfWorld) return;
      const code = c.restOfWorld ? "*" : c.countryCode;
      if (c.provinces && c.provinces.length > 0) {
        initialRegions[code] = {
          checked: false,
          indeterminate: true,
          provinces: c.provinces.map((p) => p.code),
        };
      } else {
        initialRegions[code] = {
          checked: true,
          indeterminate: false,
          provinces: [],
        };
      }
    });
    setModalSelectedRegions(initialRegions);
    setExpandedCountries(new Set());
    setEditingZoneId(isBulkRule ? null : rule.deliveryZoneGid);
    setEditingBulkRuleId(isBulkRule ? rule.id : null);
    setCountrySearch("");
    /* Close the EditRule modal first so the two modals don't stack. */
    setEditingRule(null);
    shopify.modal.show("zone-modal");
  }, [zones]);

  const handleZoneModalSave = useCallback(() => {
    const body = new FormData();
    body.set("countryCodes", JSON.stringify(modalSelectedRegions));

    if (zoneModalMode === "edit-bulk") {
      /* Bulk rules don't own a Shopify zone — we only rewrite ZoneRule.countries */
      body.set("intent", "update_rule_coverage");
      body.set("id", editingBulkRuleId);
    } else {
      body.set("profileId", profileId);
      body.set("locationGroupId", locationGroupId);
      body.set("zoneName", modalZoneName);
      if (zoneModalMode === "create") {
        body.set("intent", "create_zone");
      } else {
        body.set("intent", "update_zone");
        body.set("zoneId", editingZoneId);
      }
    }

    fetcher.submit(body, { method: "POST" });
    shopify.modal.hide("zone-modal");
  }, [
    fetcher,
    profileId,
    locationGroupId,
    modalZoneName,
    modalSelectedRegions,
    zoneModalMode,
    editingZoneId,
    editingBulkRuleId,
  ]);

  /* ── Rule handlers ── */
  const handleEditRule = useCallback((rule) => {
    setEditingRule(rule);
  }, []);

  const handleSaveRule = useCallback(
    ({ rule, name, currency, logicType, rules }) => {
      const body = new FormData();
      body.set("intent", "save_rule");
      body.set("id", rule.id);
      body.set("name", name);
      body.set("currency", currency);
      body.set("logicType", logicType);
      body.set("rulesJson", JSON.stringify(rules));
      fetcher.submit(body, { method: "POST" });
      setEditingRule(null);
    },
    [fetcher],
  );

  const handleDeleteRule = useCallback(
    (rule) => {
      const body = new FormData();
      body.set("intent", "delete_rule");
      body.set("id", rule.id);
      if (rule.source === "shopify") {
        body.set("profileId", profileId);
        body.set("locationGroupId", locationGroupId);
      }
      fetcher.submit(body, { method: "POST" });
    },
    [fetcher, profileId, locationGroupId],
  );

  const handleBulkDeleteRules = useCallback(
    (ids) => {
      const body = new FormData();
      body.set("intent", "delete_bulk");
      body.set("ids", JSON.stringify(ids));
      body.set("profileId", profileId);
      body.set("locationGroupId", locationGroupId);
      fetcher.submit(body, { method: "POST" });
    },
    [fetcher, profileId, locationGroupId],
  );

  const handleDisconnect = useCallback(() => {
    const body = new FormData();
    body.set("intent", "disconnect");
    fetcher.submit(body, { method: "POST" });
  }, [fetcher]);

  const handleReconnect = useCallback(() => {
    const body = new FormData();
    body.set("intent", "reconnect");
    fetcher.submit(body, { method: "POST" });
  }, [fetcher]);

  /* Bulk Edit tab is Premium-only — hide entirely for Free/Advanced shops so
     there's no path into the page even by URL guessing (the bulk-edit route
     also rejects upload server-side as a defense-in-depth). */
  const tabs = bulkEditEnabled
    ? [
        {
          id: "overview",
          content: "All rates",
          accessibilityLabel: "See every rule and its current rate at a glance",
        },
        {
          id: "bulk",
          content: "Bulk edit (Excel)",
          accessibilityLabel: "Download a spreadsheet, edit many rules, upload",
        },
      ]
    : [
        {
          id: "overview",
          content: "All rates",
          accessibilityLabel: "See every rule and its current rate at a glance",
        },
      ];

  const tabDescriptions = bulkEditEnabled
    ? [
        "A single table of every shipping rule, its pricing model and how much it charges. Use the Edit button on any row to change the rate, currency, or — for zone-wise rules — which countries it covers.",
        "Edit many rules at once by downloading the template, filling it in, and uploading. Best for large catalogues.",
      ]
    : [
        "A single table of every shipping rule, its pricing model and how much it charges. Use the Edit button on any row to change the rate, currency, or — for zone-wise rules — which countries it covers.",
      ];

  /* If the user downgrades while parked on the Bulk Edit tab, snap them back
     to All rates so they're not stuck on a tab that no longer renders. */
  useEffect(() => {
    if (!bulkEditEnabled && selectedTab > 0) setSelectedTab(0);
  }, [bulkEditEnabled, selectedTab]);

  /* ───────────────────────── Render ─────────────────────────────────── */

  return (
    <Page>
      <div className="animate-fade-in">
        <BlockStack gap="500">
          {/* ── Header ── */}
          <div className="brand-strip">
            <div className="brand-strip-left">
              <div className="brand-logo-wrap">
                <img src="/logo.svg" alt="Shipofix" className="brand-logo" />
              </div>
              <div>
                <div className="brand-title">shipofix</div>
                <div className="brand-subtitle">
                  Set what your customers pay for shipping, country by country.
                </div>
              </div>
            </div>
          </div>

          {/* ── Plan strip ── current tier + link to picker for upgrade/downgrade. */}
          <div className="plan-strip">
            <div className="plan-strip-left">
              <Text variant="bodyMd" fontWeight="semibold">Plan</Text>
              <Badge tone={plan === PLANS.PREMIUM ? "success" : plan === PLANS.ADVANCED ? "info" : undefined}>
                {plan === PLANS.PREMIUM ? "Premium" : plan === PLANS.ADVANCED ? "Advanced" : "Free"}
              </Badge>
              <Text tone="subdued" variant="bodySm">
                {plan === PLANS.FREE
                  ? `${zoneCount} of ${FREE_ZONE_LIMIT} zones used · bulk Excel disabled`
                  : plan === PLANS.ADVANCED
                    ? "Unlimited zones · bulk Excel disabled"
                    : "Unlimited zones · bulk Excel enabled"}
              </Text>
            </div>
            <Button variant="plain" url={subscriptionHref}>
              Change plan
            </Button>
          </div>

          {/* Zone-cap nudge for Free shops sitting at the limit. */}
          {plan === PLANS.FREE && atZoneCap && (
            <Banner
              tone="warning"
              title={`Free plan zone limit reached (${FREE_ZONE_LIMIT} zones)`}
              action={{ content: "Upgrade plan", url: subscriptionHref }}
            >
              <p>
                You&apos;re using all {FREE_ZONE_LIMIT} zones included with the Free
                plan. Upgrade to Advanced or Premium to add more.
              </p>
            </Banner>
          )}

          {/* ── Connection status bar — single line ──
             Connected: green dot + message + Disconnect button.
             Disconnected: amber dot + message + Reconnect button.
             Info/warning states: no action button. */}
          {carrierStatus.message && (
            <div
              className="carrier-status-bar"
              data-state={
                carrierStatus.state === "success"
                  ? "success"
                  : carrierStatus.state === "disconnected"
                    ? "disconnected"
                    : "info"
              }
            >
              <div className="carrier-status-dot" />
              <span className="carrier-status-msg">{carrierStatus.message}</span>
              {carrierStatus.state === "success" && (
                <Button
                  size="slim"
                  onClick={handleDisconnect}
                  loading={
                    fetcher.state !== "idle" &&
                    fetcher.formData?.get("intent") === "disconnect"
                  }
                >
                  Disconnect
                </Button>
              )}
              {carrierStatus.state === "disconnected" && (
                <Button
                  size="slim"
                  onClick={handleReconnect}
                  loading={
                    fetcher.state !== "idle" &&
                    fetcher.formData?.get("intent") === "reconnect"
                  }
                >
                  Reconnect
                </Button>
              )}
            </div>
          )}

          {carrierStatus.staleServices?.length > 0 && (
            <Banner
              tone="warning"
              title={`We found ${carrierStatus.staleServices.length} leftover shipping connection${carrierStatus.staleServices.length === 1 ? "" : "s"} from a previous install`}
              action={{
                content: "Clean up",
                onAction: () => {
                  const body = new FormData();
                  body.set("intent", "cleanup_carrier_services");
                  body.set(
                    "ids",
                    JSON.stringify(carrierStatus.staleServices.map((s) => s.id)),
                  );
                  fetcher.submit(body, { method: "POST" });
                },
                loading:
                  fetcher.state === "submitting" &&
                  fetcher.formData?.get("intent") === "cleanup_carrier_services",
              }}
            >
              <p>
                These can cause your customers to see duplicate shipping
                options at checkout. Clicking <b>Clean up</b> removes the old
                ones safely — your current rates are not affected.
              </p>
            </Banner>
          )}

          {/* ── Main content ── */}
          <BlockStack gap="400">
            {/* Navbar: tab pills on the left, Help guide on the right */}
            <div className="page-tabbar">
              <div className="page-tabbar-tabs">
                <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} />
              </div>
              {selectedTab !== 1 && (
                <Button
                  icon={InfoIcon}
                  onClick={() => shopify.modal.show("docs-modal")}
                  accessibilityLabel="Open help guide"
                >
                  Help guide
                </Button>
              )}
            </div>

            <div className="page-tab-caption">
              <Text tone="subdued" variant="bodySm">
                {tabDescriptions[selectedTab]}
              </Text>
            </div>

            <Box>
              {selectedTab === 0 ? (
                <RulesOverview
                  rules={rules}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  filterType={filterType}
                  setFilterType={setFilterType}
                  sortOrder={sortOrder}
                  setSortOrder={setSortOrder}
                  filterZoneType={filterZoneType}
                  setFilterZoneType={setFilterZoneType}
                  shopCountry={shopCountry}
                  onEditRule={handleEditRule}
                  onDeleteRule={handleDeleteRule}
                  onBulkDelete={handleBulkDeleteRules}
                  onAddZone={openCreateModal}
                  addZoneDisabled={atZoneCap}
                  addZoneDisabledReason={
                    atZoneCap
                      ? `Free plan limit reached (${FREE_ZONE_LIMIT} zones). Upgrade to add more.`
                      : null
                  }
                  isDeleting={
                    fetcher.state === "submitting" &&
                    fetcher.formData?.get("intent") === "delete_rule"
                  }
                  isBulkDeleting={
                    fetcher.state === "submitting" &&
                    fetcher.formData?.get("intent") === "delete_bulk"
                  }
                />
              ) : (
                <BulkEdit
                  onToast={(m) => {
                    setToastMsg(m);
                    revalidator.revalidate();
                    setTimeout(
                      () => setToastMsg(null),
                      toastDuration(m, String(m || "").startsWith("Error")),
                    );
                  }}
                  onApplied={() => setSelectedTab(0)}
                />
              )}
            </Box>
          </BlockStack>
        </BlockStack>
      </div>

      {/* Zone create / change-countries modal */}
      <ZoneModal
        zoneModalMode={zoneModalMode}
        modalZoneName={modalZoneName}
        setModalZoneName={setModalZoneName}
        modalSelectedRegions={modalSelectedRegions}
        setModalSelectedRegions={setModalSelectedRegions}
        expandedCountries={expandedCountries}
        setExpandedCountries={setExpandedCountries}
        countrySearch={countrySearch}
        setCountrySearch={setCountrySearch}
        onSave={handleZoneModalSave}
        deletingZoneId={null}
        setDeletingZoneId={() => {}}
        onConfirmDelete={() => {}}
      />

      {/* Edit Rule modal — pricing model, currency, rate. Opens from the
          Edit button on each row of the All rates table. */}
      <EditRuleModal
        open={!!editingRule}
        rule={editingRule}
        onClose={() => setEditingRule(null)}
        onSave={handleSaveRule}
        onChangeCountries={openChangeCountries}
        isSaving={
          fetcher.state === "submitting" &&
          fetcher.formData?.get("intent") === "save_rule"
        }
      />

      {/* ── Documentation Modal ── */}
      <ui-modal id="docs-modal" variant="max">
        <div className="shipofix-docs">
          <div className="shipofix-docs-hero">
            <h1>Shipofix help guide</h1>
            <p>
              A plain-English walk-through of how Shipofix decides what to
              charge for shipping. Skim the section you need, or read it
              top-to-bottom the first time you set things up.
            </p>
          </div>

          <nav className="shipofix-docs-toc" aria-label="Help guide sections">
            <div className="shipofix-docs-toc-label">Jump to</div>
            <div className="shipofix-docs-toc-links">
              <a href="#docs-quickstart">Quick start</a>
              <a href="#docs-zones">What is a zone?</a>
              <a href="#docs-tour">All rates · interface tour</a>
              <a href="#docs-models">The 7 pricing models</a>
              <a href="#docs-delete">Editing &amp; deleting rules</a>
              <a href="#docs-bulk">Bulk edit (Excel)</a>
              <a href="#docs-currency">Currency</a>
              <a href="#docs-connection">Checkout connection</a>
              <a href="#docs-faq">FAQ</a>
            </div>
          </nav>

          {/* ── Quick start ── */}
          <section id="docs-quickstart" className="shipofix-docs-section">
            <h2>Quick start · 3 steps</h2>
            <ol className="shipofix-docs-steps">
              <li>
                <b>Click &ldquo;Add new zone&rdquo;</b> at the top-right of
                the All rates table. Give the zone a name, tick the countries
                (and provinces, if needed), and click <i>Create</i>.
              </li>
              <li>
                <b>Click Edit</b> on the row that just appeared. Pick a
                pricing model — flat rate, weight tiers, percent of cart, and
                so on — then type your price.
              </li>
              <li>
                <b>Click &ldquo;Save shipping rate&rdquo;.</b> Customers see
                the new price at checkout straight away.
              </li>
            </ol>
            <div className="shipofix-docs-tip">
              <b>Tip:</b> Need to edit lots of rules at once? Use the{" "}
              <i>Bulk edit (Excel)</i> tab — see below.
            </div>
          </section>

          {/* ── Zones ── */}
          <section id="docs-zones" className="shipofix-docs-section">
            <h2>What is a zone?</h2>
            <p>
              A zone groups together countries (and, if you want, individual
              states or provinces) that share the same shipping price. For
              example you might have a <b>Domestic</b> zone for your own
              country, a <b>Neighbours</b> zone for nearby countries, and a{" "}
              <b>Rest of world</b> zone for everything else.
            </p>
            <ul className="shipofix-docs-bullets">
              <li>
                <b>Add a new zone</b> — click <i>Add new zone</i> at the top
                right of the All rates table and tick the countries.
              </li>
              <li>
                <b>Change countries</b> — open a rule with Edit, then click{" "}
                &ldquo;Change countries&rdquo;.
              </li>
              <li>
                <b>Delete a rule</b> — click <i>Delete</i> on the row. The
                rule (and, for zone-wise rules, the underlying Shopify
                delivery zone) is removed.
              </li>
              <li>
                <b>Use Shopify&apos;s own rates instead</b> — change the
                pricing model dropdown to &ldquo;Shopify default&rdquo;. The
                rule stays in place, but Shopify decides the price.
              </li>
            </ul>
          </section>

          {/* ── All rates interface tour ── */}
          <section id="docs-tour" className="shipofix-docs-section">
            <h2>All rates · interface tour</h2>
            <p>
              The <i>All rates</i> tab is where you spend most of your time.
              Here&apos;s what each piece does:
            </p>
            <ul className="shipofix-docs-bullets">
              <li>
                <b>Stats strip</b> — the bar at the top shows your total
                rule count, how many are zone-wise vs. uploaded from Excel,
                and how many match your current filters.
              </li>
              <li>
                <b>Search</b> — type any rule name, country, or zone name.
                The table filters as you type.
              </li>
              <li>
                <b>Pricing-model filter</b> — narrow the table to only
                flat-rate rules, weight-tier rules, etc.
              </li>
              <li>
                <b>Sort</b> — flip between A → Z and Z → A by rule name.
              </li>
              <li>
                <b>Row actions</b> — every row has <i>View</i> (read-only
                details), <i>Edit</i> (change the price or coverage), and{" "}
                <i>Delete</i>.
              </li>
              <li>
                <b>Multiple delete</b> — click <i>Multiple delete</i> to
                reveal checkboxes, tick the rules you want gone, then{" "}
                <i>Delete selected</i>.
              </li>
            </ul>
          </section>

          {/* ── Pricing models ── */}
          <section id="docs-models" className="shipofix-docs-section">
            <h2>The 7 pricing models</h2>
            <p>
              Each rule uses one of these. Pick the one that matches how you
              normally quote shipping.
            </p>
            <div className="shipofix-docs-model">
              <h3>1 · Flat rate</h3>
              <p>One price for every order to this zone, no matter what.</p>
              <p className="shipofix-docs-example">Example: every order to the UK pays £6.</p>
            </div>
            <div className="shipofix-docs-model">
              <h3>2 · Weight tiers</h3>
              <p>
                Different price for different weight bands. You set the bands
                yourself — leave the top band&apos;s &ldquo;Up to&rdquo; blank
                so it catches anything heavier.
              </p>
              <p className="shipofix-docs-example">
                Example: 0–5 kg → 50 · 5–10 kg → 80 · 10 kg and up → 120.
              </p>
            </div>
            <div className="shipofix-docs-model">
              <h3>3 · Order-value tiers</h3>
              <p>
                Different price for different cart totals. Great for
                free-shipping thresholds.
              </p>
              <p className="shipofix-docs-example">
                Example: 0–999 → 99 · 1,000–4,999 → 49 · 5,000 and up → 0
                (free).
              </p>
            </div>
            <div className="shipofix-docs-model">
              <h3>4 · Per kilogram</h3>
              <p>We multiply the parcel weight (in kg) by your rate.</p>
              <p className="shipofix-docs-example">
                Example: rate 20 · a 3.5 kg cart charges 70.
              </p>
            </div>
            <div className="shipofix-docs-model">
              <h3>5 · Percentage of cart</h3>
              <p>
                Charge a fraction of the cart subtotal. Type the percent as a
                decimal: <code>0.1</code> means 10%.
              </p>
              <p className="shipofix-docs-example">
                Example: rate 0.1 · 800 cart → 80.
              </p>
            </div>
            <div className="shipofix-docs-model">
              <h3>6 · Per item</h3>
              <p>Multiply the number of items in the cart by your rate.</p>
              <p className="shipofix-docs-example">
                Example: rate 15 · 4 items → 60.
              </p>
            </div>
            <div className="shipofix-docs-model">
              <h3>7 · Weight tiers × per-kg rate</h3>
              <p>
                A combination of <b>weight tiers</b> and <b>per kilogram</b>.
                You set weight bands, but each band holds a{" "}
                <i>per-kg rate</i> instead of a flat amount. The cart&apos;s
                weight is multiplied by the matching band&apos;s rate. Leave
                the top band&apos;s &ldquo;Up to&rdquo; blank so it catches
                anything heavier.
              </p>
              <p className="shipofix-docs-example">
                Example: 0–5 kg → 20/kg · 5–10 kg → 15/kg · 10 kg and up →
                10/kg. A 7 kg cart hits the 5–10 band: 7 × 15 = 105.
              </p>
            </div>
          </section>

          {/* ── Editing & deleting rules ── */}
          <section id="docs-delete" className="shipofix-docs-section">
            <h2>Editing &amp; deleting rules</h2>
            <p>
              Every rule has the same three actions on the right side of its
              row: <b>View</b>, <b>Edit</b>, and <b>Delete</b>. Use them as
              follows:
            </p>
            <ul className="shipofix-docs-bullets">
              <li>
                <b>View</b> — opens a read-only summary of the rule&apos;s
                pricing model, rate, and country/province coverage. Nothing
                you do here can save changes.
              </li>
              <li>
                <b>Edit</b> — opens the editor. Change the price, switch
                pricing models, tweak bands, or click{" "}
                <i>Change countries</i> to adjust coverage. Click{" "}
                <i>Save shipping rate</i> when you&apos;re done.
              </li>
              <li>
                <b>Delete</b> — removes the rule after a confirmation prompt.
                For zone-wise rules, the underlying Shopify delivery zone is
                also removed; bulk (Excel) rules are removed from the stored
                spreadsheet too.
              </li>
            </ul>
            <p>
              <b>To clean up many rules at once</b>, click{" "}
              <i>Multiple delete</i> at the top of the table. Checkboxes
              appear on every row — tick the rules you want gone (or use
              the header checkbox to select all visible rules) and click{" "}
              <i>Delete selected (N)</i>. A confirmation dialog will list how
              many rules are about to be removed.
            </p>
            <div className="shipofix-docs-tip">
              <b>Heads up:</b> Deletes are permanent. For Excel-uploaded
              rules you can re-upload the file later to bring them back;
              zone-wise rules have to be re-created by hand.
            </div>
          </section>

          {/* ── Bulk edit ── */}
          <section id="docs-bulk" className="shipofix-docs-section">
            <h2>Bulk edit (Excel)</h2>
            <p>
              If you have lots of rules, editing one at a time is slow. The{" "}
              <i>Bulk edit (Excel)</i> tab lets you manage everything from a
              single spreadsheet.
            </p>
            <ol className="shipofix-docs-steps">
              <li>
                <b>Download the template</b> — click <i>Download .xlsx</i>{" "}
                on Step 1. The workbook ships with four sheets:{" "}
                <b>Bulk Edit</b> (coverage + logic), <b>Rate Bands</b> (slabs
                for weight or order-value tiers), <b>All Regions</b> (read-only
                reference), and <b>Instructions</b>.
              </li>
              <li>
                <b>Fill in only the rows you need</b> — give each rule a{" "}
                <b>Name</b>, tick at least one country/zone, pick a{" "}
                <b>Pricing model</b>, and set a <b>Currency</b> and{" "}
                <b>Price</b>. Rows sharing a Name merge into one rule whose
                coverage is the union of their country/zone cells.
              </li>
              <li>
                <b>Upload the file</b> — Shipofix replaces every
                previously-uploaded rule with what you uploaded. Your
                zone-wise rules (created via <i>Add new zone</i>) are never
                touched.
              </li>
            </ol>
            <div className="shipofix-docs-tip">
              Excel-uploaded rules live alongside zone-wise rules — both
              appear in the All rates table (marked with an <b>Excel</b>{" "}
              badge) and both apply at checkout.
            </div>
          </section>

          {/* ── Currency ── */}
          <section id="docs-currency" className="shipofix-docs-section">
            <h2>Currency</h2>
            <p>
              Each rule has its own currency. Pick it from the dropdown when
              setting up the price — the currency symbol shows next to every
              price box so you never mix them up. Shopify converts the price
              for your customer at checkout if their currency is different.
            </p>
          </section>

          {/* ── Connection ── */}
          <section id="docs-connection" className="shipofix-docs-section">
            <h2>How Shipofix talks to your checkout</h2>
            <p>
              When a customer reaches checkout, Shopify asks Shipofix what to
              charge. Shipofix looks up the right rule, applies the rate
              you&apos;ve set, and sends the answer back. You don&apos;t need
              to do anything — this happens automatically.
            </p>
            <p>
              If you ever see a yellow banner saying we found{" "}
              <b>leftover shipping connections</b>, click <b>Clean up</b>.
              It just removes old links so customers don&apos;t see duplicate
              shipping options — none of your rates are touched.
            </p>
          </section>

          {/* ── FAQ ── */}
          <section id="docs-faq" className="shipofix-docs-section">
            <h2>Frequently asked questions</h2>
            <div className="shipofix-docs-faq">
              <h3>Why is my weight number in kilograms, not grams?</h3>
              <p>
                Shopify stores product weights in grams, but most stores think
                in kg. We do the conversion for you — type your bands in kg.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>I typed &ldquo;10&rdquo; for 10% and it charged 1000%. What happened?</h3>
              <p>
                The percentage model expects a decimal — type <code>0.1</code>{" "}
                for 10%, not <code>10</code>. The field warns you if it spots
                a number that looks too big.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>What if a country isn&apos;t in any rule?</h3>
              <p>
                Customers from that country won&apos;t see a Shipofix rate.
                Add the country to an existing rule, or create a{" "}
                <b>Rest of world</b> zone to catch everything else.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>How do I let Shopify handle a zone instead?</h3>
              <p>
                Change the pricing-model dropdown to <b>Shopify default</b>.
                Shipofix steps aside for that rule and Shopify quotes its own
                rate.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>Can I delete several rules in one go?</h3>
              <p>
                Yes — click <b>Multiple delete</b> at the top of the All
                rates table, tick the rules you want to remove (or use the
                header checkbox to select all visible rules), and click{" "}
                <b>Delete selected</b>. You&apos;ll get a confirmation
                prompt before anything is removed.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>What&apos;s the difference between zone-wise and Excel rules?</h3>
              <p>
                <b>Zone-wise rules</b> are created one at a time with the{" "}
                <i>Add new zone</i> button and own their underlying Shopify
                delivery zone. <b>Excel rules</b> are created in bulk by
                uploading a spreadsheet, marked with an <b>Excel</b> badge in
                the table, and replaced wholesale when you re-upload the
                file. Both kinds apply at checkout and can be edited
                row-by-row.
              </p>
            </div>
          </section>

          <div className="shipofix-docs-footnote">
            Need a hand? Reach out to support — we&apos;re happy to help you
            set things up.
          </div>
        </div>
        <ui-title-bar title="Help guide">
          <button variant="primary" onClick={() => shopify.modal.hide("docs-modal")}>Close</button>
        </ui-title-bar>
      </ui-modal>

      {/* ── Toast ── */}
      {toastMsg && (
        <div className="toast-container">
          <Banner
            tone={toastMsg.startsWith("Error") ? "critical" : "success"}
            onDismiss={() => setToastMsg(null)}
          >
            {toastMsg}
          </Banner>
        </div>
      )}
    </Page>
  );
}
