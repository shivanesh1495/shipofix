/**
 * Auto-managed Shopify delivery zone for bulk (Excel) rules — SERVER-ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 *
 *  Bulk (Excel) rules live only in Shipofix's database and carry a synthetic
 *  `bulk:<slug>` GID — they never own a Shopify delivery zone. But Shopify
 *  only calls our carrier service (`/api/shipping`) for a destination that
 *  some delivery zone — with our carrier method attached — actually COVERS.
 *
 *  So a store whose only priceable rules are bulk rules would have no zone for
 *  Shopify to attach the carrier to, and checkout would never ask Shipofix for
 *  a rate. The merchant sees "connected" in the app but no rates at checkout.
 *
 *  This module keeps ONE auto-managed zone (named `MANAGED_ZONE_NAME`) in sync
 *  with the union of countries covered by priceable bulk rules that no real
 *  (merchant-created) zone already covers:
 *
 *     • create it when a bulk rule needs a country no real zone covers,
 *     • update its country list as bulk coverage changes,
 *     • delete it once no bulk rule needs it.
 *
 *  The zone is identified purely by its name, so the reconcile is idempotent:
 *  re-running with the same inputs makes no Shopify calls.
 * ─────────────────────────────────────────────────────────────────────────
 */

import prisma from "../db.server";
import { isPriceableLogicType } from "./rate-calculators.js";
import {
  QUERY_CARRIER_SERVICES,
  MUTATION_DELIVERY_PROFILE_UPDATE,
} from "./graphql.js";

/** Name of the single zone this module owns. Visible to the merchant in the
    Shopify shipping admin, so keep it self-explanatory. */
export const MANAGED_ZONE_NAME = "Shipofix Excel coverage";

/** The carrier method we attach so Shopify calls our endpoint for this zone. */
const MANAGED_METHOD_NAME = "Custom Carrier Shipping";

/** True if a zone (by name) is the one this module manages. */
export function isManagedZoneName(name) {
  return name === MANAGED_ZONE_NAME;
}

/* ── Coverage math ────────────────────────────────────────────────────── */

/** Upper-cased country codes already covered by real (non-managed) zones. */
function realCoverage(realZones) {
  const codes = new Set();
  for (const z of realZones) {
    for (const c of z.countries || []) {
      if (!c.restOfWorld && c.countryCode) {
        codes.add(String(c.countryCode).toUpperCase());
      }
    }
  }
  return codes;
}

/**
 * Country codes a managed zone must cover: every explicit country a priceable
 * bulk rule targets, minus any a real zone already triggers us for.
 *
 * Rest-of-world bulk coverage is deliberately NOT auto-zoned here — a ROW zone
 * broadly captures every other country and is a separate, higher-risk decision
 * a merchant should make explicitly. Explicit countries only.
 */
function desiredBulkCountries(priceableBulkRules, alreadyCovered) {
  const wanted = new Set();
  for (const rule of priceableBulkRules) {
    let countries;
    try {
      countries = JSON.parse(rule.countries || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(countries)) continue;
    for (const c of countries) {
      if (c.restOfWorld || c.countryCode === "*" || c.countryCode === "ROW") {
        continue;
      }
      const code = String(c.countryCode || "").toUpperCase();
      if (!code || alreadyCovered.has(code)) continue;
      wanted.add(code);
    }
  }
  return wanted;
}

/* ── Shopify helpers ──────────────────────────────────────────────────── */

async function resolveCarrierServiceId(admin, carrierServiceId) {
  if (carrierServiceId) return carrierServiceId;
  try {
    const csQuery = await admin.graphql(QUERY_CARRIER_SERVICES);
    const csJson = await csQuery.json();
    const services =
      csJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
    return (services.find((s) => s.active) || services[0])?.id || null;
  } catch {
    return null;
  }
}

function methodDefinitionInput(carrierServiceId) {
  return {
    name: MANAGED_METHOD_NAME,
    active: true,
    participant: { carrierServiceId, adaptToNewServices: true },
  };
}

function collectUserErrors(json) {
  return json?.data?.deliveryProfileUpdate?.userErrors || [];
}

/* ── Public: reconcile ────────────────────────────────────────────────── */

/**
 * Bring the auto-managed coverage zone in line with the shop's priceable bulk
 * rules. Safe to call on every loader run — it no-ops when nothing changed.
 *
 * @param {object}  params
 * @param {object}  params.admin            Shopify Admin GraphQL client
 * @param {string}  params.shopDomain
 * @param {string|null} params.profileId    Delivery profile GID
 * @param {string|null} params.locationGroupId
 * @param {Array}   params.zones            ALL unique zones (incl. managed)
 * @param {string|null} [params.carrierServiceId]
 * @returns {Promise<{changed: boolean, action?: string, errors?: Array}>}
 */
export async function reconcileBulkCoverageZone({
  admin,
  shopDomain,
  profileId,
  locationGroupId,
  zones,
  carrierServiceId = null,
}) {
  if (!admin || !profileId || !locationGroupId) return { changed: false };

  const managedZone = zones.find((z) => isManagedZoneName(z.name)) || null;
  const realZones = zones.filter((z) => !isManagedZoneName(z.name));

  const bulkRules = await prisma.zoneRule.findMany({
    where: { shop: shopDomain, source: "bulk" },
  });
  const priceableBulk = bulkRules.filter((r) =>
    isPriceableLogicType(r.logicType),
  );

  const alreadyCovered = realCoverage(realZones);
  const wanted = desiredBulkCountries(priceableBulk, alreadyCovered);

  /* ── Nothing to cover → tear the managed zone down if it exists. ── */
  if (wanted.size === 0) {
    if (!managedZone) return { changed: false };
    const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
      variables: {
        profileId,
        profile: { zonesToDelete: [managedZone.id] },
      },
    });
    const errors = collectUserErrors(await res.json());
    return { changed: errors.length === 0, action: "deleted", errors };
  }

  /* Whole-country coverage: the carrier callback still does province-level
     pricing and returns empty for any province a rule doesn't cover, so a
     whole-country zone never quotes more than the rule allows. */
  const countries = [...wanted].map((code) => ({
    code,
    includeAllProvinces: true,
    provinces: [],
  }));

  /* ── Already exists → keep its country list (and method) in sync. ── */
  if (managedZone) {
    const current = new Set(
      (managedZone.countries || [])
        .filter((c) => !c.restOfWorld && c.countryCode)
        .map((c) => String(c.countryCode).toUpperCase()),
    );
    const sameCountries =
      current.size === wanted.size && [...wanted].every((c) => current.has(c));
    const needsMethod = !managedZone.hasMethodDefinition;

    /* Steady state — nothing to do. Return BEFORE the carrier-service lookup
       so a no-op page load costs zero extra Shopify calls. */
    if (sameCountries && !needsMethod) return { changed: false };

    const zoneUpdate = { id: managedZone.id, name: MANAGED_ZONE_NAME, countries };
    if (needsMethod) {
      const csId = await resolveCarrierServiceId(admin, carrierServiceId);
      if (csId) zoneUpdate.methodDefinitionsToCreate = [methodDefinitionInput(csId)];
    }

    const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
      variables: {
        profileId,
        profile: {
          locationGroupsToUpdate: [
            { id: locationGroupId, zonesToUpdate: [zoneUpdate] },
          ],
        },
      },
    });
    const errors = collectUserErrors(await res.json());
    return { changed: errors.length === 0, action: "updated", errors };
  }

  /* ── Doesn't exist → create it with the carrier method attached. ── */
  const csId = await resolveCarrierServiceId(admin, carrierServiceId);
  const zoneToCreate = { name: MANAGED_ZONE_NAME, countries };
  if (csId) {
    zoneToCreate.methodDefinitionsToCreate = [methodDefinitionInput(csId)];
  }

  const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
    variables: {
      profileId,
      profile: {
        locationGroupsToUpdate: [
          { id: locationGroupId, zonesToCreate: [zoneToCreate] },
        ],
      },
    },
  });
  const errors = collectUserErrors(await res.json());
  return { changed: errors.length === 0, action: "created", errors };
}
