import { useCallback, useEffect, useMemo, useState } from "react";
import { useActionData, useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureCarrierService } from "../lib/carrier.server.js";
import {
  QUERY_CARRIER_SERVICES,
  QUERY_DELIVERY_ZONES,
  MUTATION_DELIVERY_PROFILE_UPDATE,
  MUTATION_DELETE_CARRIER,
} from "../lib/graphql.js";

/* ── Components ── */
import ZoneSidebar from "../components/ZoneSidebar";
import LogicEditor from "../components/LogicEditor";
import RulesOverview from "../components/RulesOverview";
import ZoneModal from "../components/ZoneModal";
import BulkEdit from "../components/BulkEdit";

/* ───────────────────────────── Loader ──────────────────────────────── */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

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

  // Deduplicate zones from all profiles, track method definitions
  const zoneMap = new Map();
  const zonesWithoutMethods = []; // zones missing carrier service method
  profiles.forEach(({ node: profile }) => {
    profile.profileLocationGroups.forEach((group) => {
      group.locationGroupZones.edges.forEach(({ node: zoneNode }) => {
        const z = zoneNode.zone;
        const methodCount =
          zoneNode.methodDefinitions?.edges?.length || 0;
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
          if (methodCount === 0) {
            zonesWithoutMethods.push(z.id);
          }
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
      const services =
        csJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];
      const activeService = services.find((s) => s.active);
      carrierServiceId = activeService?.id || services[0]?.id || null;
      console.log(`[AUTO-FIX] Carrier service ID: ${carrierServiceId}, active: ${!!activeService}`);
    } catch (_e) {
      console.error("[AUTO-FIX] Failed to query carrier services:", _e);
    }

    if (carrierServiceId) {
      // Fix each zone individually so one failure doesn't block others
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
          if (fixErrors.length > 0) {
            console.error(`[AUTO-FIX] Zone ${zoneId} errors:`, JSON.stringify(fixErrors));
          } else {
            console.log(`[AUTO-FIX] ✅ Attached carrier service to zone ${zoneId}`);
            const z = zoneMap.get(zoneId);
            if (z) z.hasMethodDefinition = true;
          }
        } catch (fixErr) {
          console.error(`[AUTO-FIX] Zone ${zoneId} exception:`, fixErr.message);
        }
      }
    }
  }

  const uniqueZones = Array.from(zoneMap.values());

  // Sync DB
  const savedRules = await prisma.zoneRule.findMany({
    where: { shop: shopDomain },
  });
  const rulesByGid = new Map(savedRules.map((r) => [r.deliveryZoneGid, r]));
  const activeZoneGids = new Set(uniqueZones.map((z) => z.id));

  // Update metadata for existing zones
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

  // Clean up orphaned rules (zones deleted from Shopify but still in DB)
  const orphans = savedRules.filter((r) => !activeZoneGids.has(r.deliveryZoneGid));
  if (orphans.length > 0) {
    console.log(
      `Cleaning up ${orphans.length} orphaned zone rule(s): ${orphans.map((r) => `${r.name}(${r.deliveryZoneGid})`).join(", ")}`,
    );
    orphans.forEach((r) =>
      syncs.push(prisma.zoneRule.delete({ where: { id: r.id } })),
    );
  }

  if (syncs.length > 0) await prisma.$transaction(syncs);

  /* Bulk-edit ruleset — separate storage, populated only by Excel upload.
     Attached so the Rules Overview can show whichever set is active.
     The `prisma.bulkEditRule` guard keeps the page alive when the Prisma
     client hasn't been regenerated yet after the schema added the model. */
  const bulkRules = prisma.bulkEditRule
    ? await prisma.bulkEditRule.findMany({ where: { shop: shopDomain } })
    : [];
  const bulkRulesByGid = new Map(bulkRules.map((r) => [r.deliveryZoneGid, r]));

  const combined = uniqueZones.map((z) => ({
    ...z,
    rule: rulesByGid.get(z.id) || null,
    bulkRule: bulkRulesByGid.get(z.id) || null,
  }));

  /* App-level settings (single source of truth for app-managed features) */
  const appSetting = await prisma.appSetting.findUnique({
    where: { shop: shopDomain },
  });
  const bulkEditEnabled = appSetting ? appSetting.bulkEditEnabled : true;

  /* Metadata for the last Bulk Edit file the vendor uploaded — used by the
     Bulk Edit panel to show download/delete affordances. The file bytes
     themselves are streamed by the resource route (intent=last).
     Guarded the same way as bulkEditRule above. */
  const lastUploadRow = prisma.bulkEditUpload
    ? await prisma.bulkEditUpload.findUnique({
        where: { shop: shopDomain },
        select: { filename: true, size: true, uploadedAt: true },
      })
    : null;
  const lastBulkUpload = lastUploadRow
    ? {
        filename: lastUploadRow.filename,
        size: lastUploadRow.size,
        uploadedAt: lastUploadRow.uploadedAt.toISOString(),
      }
    : null;

  return {
    zones: combined,
    /* Bulk rules are independent of Shopify zones — Rules Overview renders
       them directly in bulk mode (one rule = many country/province rows). */
    bulkRules,
    carrierStatus,
    shopCountry,
    profileId,
    locationGroupId,
    bulkEditEnabled,
    lastBulkUpload,
    shippingUrl: `https://${shopDomain}/admin/settings/shipping`,
  };
};

/* ───────────────────────────── Action ──────────────────────────────── */

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  /* ── Save Rule ── */
  if (intent === "save_rule") {
    const gid = formData.get("deliveryZoneGid");
    const name = formData.get("name");
    const countries = formData.get("countries");
    const logicType = formData.get("logicType");
    const rulesJson = formData.get("rulesJson");
    const currency = formData.get("currency") || "USD";

    await prisma.zoneRule.upsert({
      where: {
        shop_deliveryZoneGid: { shop: shopDomain, deliveryZoneGid: gid },
      },
      update: { name, countries, logicType, rulesJson, currency },
      create: {
        shop: shopDomain,
        deliveryZoneGid: gid,
        name,
        countries,
        logicType,
        rulesJson,
        currency,
      },
    });

    return { success: true, message: `Logic saved for ${name}` };
  }

  /* ── Delete Rule ── */
  if (intent === "delete_rule") {
    const id = formData.get("id");
    await prisma.zoneRule.delete({ where: { id } });
    return { success: true, message: "Rule removed" };
  }

  /* ── Toggle Bulk Edit (app setting) ── */
  if (intent === "toggle_bulk_edit") {
    const enabled = formData.get("enabled") === "true";
    await prisma.appSetting.upsert({
      where: { shop: shopDomain },
      update: { bulkEditEnabled: enabled },
      create: { shop: shopDomain, bulkEditEnabled: enabled },
    });
    return {
      success: true,
      message: `Bulk Edit ${enabled ? "enabled" : "disabled"}.`,
    };
  }

  /* ── Cleanup Carrier Services ── */
  if (intent === "cleanup_carrier_services") {
    const ids = JSON.parse(formData.get("ids") || "[]");
    for (const id of ids) {
      await admin.graphql(MUTATION_DELETE_CARRIER, { variables: { id } });
    }
    return { success: true, message: `Cleaned up ${ids.length} duplicate(s).` };
  }

  /* ── Create Zone ── */
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

    /* Build zone input — attach carrier service method definition if available */
    const zoneInput = { name: zoneName, countries: countriesInput };
    if (carrierServiceId) {
      zoneInput.methodDefinitionsToCreate = [
        {
          name: "Custom Carrier Shipping",
          active: true,
          participant: {
            carrierServiceId,
            adaptToNewServices: true,
          },
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

    return {
      success: true,
      message: `Zone "${zoneName}" created successfully!`,
    };
  }

  /* ── Update Zone ── */
  if (intent === "update_zone") {
    const profileId = formData.get("profileId");
    const locationGroupId = formData.get("locationGroupId");
    const zoneId = formData.get("zoneId");
    const zoneName = formData.get("zoneName");
    const countryCodes = JSON.parse(formData.get("countryCodes") || "{}");

    if (!profileId || !locationGroupId || !zoneId) {
      return { success: false, error: "Missing required IDs." };
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
      console.error("SHOPIFY API ERRORS:", JSON.stringify(errors, null, 2));
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    return {
      success: true,
      message: `Zone "${zoneName}" updated successfully!`,
    };
  }

  /* ── Delete Zone ── */
  if (intent === "delete_zone") {
    const profileId = formData.get("profileId");
    const locationGroupId = formData.get("locationGroupId");
    const zoneId = formData.get("zoneId");

    if (!profileId || !locationGroupId || !zoneId) {
      return { success: false, error: "Missing required IDs." };
    }

    const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
      variables: {
        profileId,
        profile: { zonesToDelete: [zoneId] },
      },
    });

    const resJson = await res.json();
    const errors = resJson?.data?.deliveryProfileUpdate?.userErrors || [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    try {
      await prisma.zoneRule.deleteMany({
        where: { shop: shopDomain, deliveryZoneGid: zoneId },
      });
    } catch (_e) {
      /* ignore if no rule exists */
    }

    return { success: true, message: `Zone deleted successfully!` };
  }

  return { success: false, error: "Unknown intent" };
};

/* ──────────────────────────── Component ─────────────────────────────── */

export default function ShippingDashboard() {
  const {
    zones,
    bulkRules,
    carrierStatus,
    profileId,
    locationGroupId,
    bulkEditEnabled,
    lastBulkUpload,
  } = useLoaderData();
  const actionData = useActionData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedZoneId, setSelectedZoneId] = useState(zones[0]?.id || "");

  // Logic Editor State
  const [logicType, setLogicType] = useState("STANDARD_TIER");
  const [currency, setCurrency] = useState("USD");
  const [rules, setRules] = useState({});

  // Table State
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [sortOrder, setSortOrder] = useState("NAME_ASC");

  // Zone Modal State
  const [zoneModalMode, setZoneModalMode] = useState(null);
  const [modalZoneName, setModalZoneName] = useState("");
  const [modalSelectedRegions, setModalSelectedRegions] = useState({});
  const [expandedCountries, setExpandedCountries] = useState(new Set());
  const [editingZoneId, setEditingZoneId] = useState(null);
  const [countrySearch, setCountrySearch] = useState("");
  const [deletingZoneId, setDeletingZoneId] = useState(null);

  // Toast
  const [toastMsg, setToastMsg] = useState(null);

  const activeZone = useMemo(
    () => zones.find((z) => z.id === selectedZoneId),
    [zones, selectedZoneId],
  );

  // Sync editor state when active zone changes
  useEffect(() => {
    if (activeZone?.rule) {
      setLogicType(activeZone.rule.logicType);
      setCurrency(activeZone.rule.currency);
      setRules(JSON.parse(activeZone.rule.rulesJson || "{}"));
    } else {
      /* Unsaved zone starts in "Shopify default" — picking any other model
         from the dropdown will switch logicType to that value and reveal
         the price fields. Defaulting to STANDARD_TIER here used to leave
         the dropdown stuck on DEFAULT because the editor displayed the
         saved-rule branch instead of local state. */
      setLogicType("DEFAULT");
      setCurrency("USD");
      setRules({});
    }
  }, [activeZone]);

  /* Toast lifetime scaled to message length — short confirmations
     auto-dismiss quickly, longer errors stay on screen long enough to
     actually read. Errors never disappear in under 8s. */
  const toastDuration = (msg, isError) => {
    const base = isError ? 8000 : 4000;
    const perChar = isError ? 60 : 35;
    return Math.min(20000, base + String(msg || "").length * perChar);
  };

  // Feedback from fetcher — revalidate in-place instead of full page reload
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
  }, [fetcher.data]);

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
  }, [actionData]);

  /* ── Zone Modal Handlers ── */
  const openCreateModal = useCallback(() => {
    setZoneModalMode("create");
    setModalZoneName("");
    setModalSelectedRegions({});
    setExpandedCountries(new Set());
    setEditingZoneId(null);
    setCountrySearch("");
    shopify.modal.show("zone-modal");
  }, []);

  const openEditModal = useCallback((zone) => {
    setZoneModalMode("edit");
    setModalZoneName(zone.name);
    const initialRegions = {};
    zone.countries.forEach((c) => {
      if (c.provinces && c.provinces.length > 0) {
        initialRegions[c.countryCode] = {
          checked: false,
          indeterminate: true,
          provinces: c.provinces.map((p) => p.code),
        };
      } else {
        initialRegions[c.countryCode] = {
          checked: true,
          indeterminate: false,
          provinces: [],
        };
      }
    });
    setModalSelectedRegions(initialRegions);
    setExpandedCountries(new Set());
    setEditingZoneId(zone.id);
    setCountrySearch("");
    shopify.modal.show("zone-modal");
  }, []);

  const handleZoneModalSave = useCallback(() => {
    const body = new FormData();
    body.set("profileId", profileId);
    body.set("locationGroupId", locationGroupId);
    body.set("zoneName", modalZoneName);
    body.set("countryCodes", JSON.stringify(modalSelectedRegions));

    if (zoneModalMode === "create") {
      body.set("intent", "create_zone");
    } else {
      body.set("intent", "update_zone");
      body.set("zoneId", editingZoneId);
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
  ]);

  const handleDeleteZone = useCallback((zoneId) => {
    setDeletingZoneId(zoneId);
    shopify.modal.show("delete-zone-modal");
  }, []);

  const confirmDeleteZone = useCallback(() => {
    if (!deletingZoneId) return;
    const body = new FormData();
    body.set("intent", "delete_zone");
    body.set("profileId", profileId);
    body.set("locationGroupId", locationGroupId);
    body.set("zoneId", deletingZoneId);
    fetcher.submit(body, { method: "POST" });
    shopify.modal.hide("delete-zone-modal");
    setDeletingZoneId(null);
  }, [deletingZoneId, fetcher, profileId, locationGroupId]);

  /* ── Rule Handlers ── */
  const handleSave = () => {
    if (!activeZone) return;
    const body = new FormData();
    body.set("intent", "save_rule");
    body.set("deliveryZoneGid", activeZone.id);
    body.set("name", activeZone.name);
    body.set("countries", JSON.stringify(activeZone.countries));
    body.set("logicType", logicType);
    body.set("currency", currency);
    body.set("rulesJson", JSON.stringify(rules));
    fetcher.submit(body, { method: "POST" });
  };

  const handleDeleteRule = (id) => {
    const body = new FormData();
    body.set("intent", "delete_rule");
    body.set("id", id);
    fetcher.submit(body, { method: "POST" });
  };

  const tabs = [
    {
      id: "config",
      content: "Set up rates",
      accessibilityLabel: "Set shipping rates for one zone at a time",
    },
    {
      id: "overview",
      content: "All rates",
      accessibilityLabel: "See every zone and its current rate at a glance",
    },
    {
      id: "bulk",
      content: "Bulk edit (Excel)",
      accessibilityLabel: "Download a spreadsheet, edit many zones, upload",
    },
  ];

  const tabDescriptions = [
    "Pick a zone on the left, choose how you want to charge for it, and save.",
    "A single table of every zone, its pricing model and how much it charges. Use this to spot-check or jump back to editing.",
    "Edit many zones at once by downloading the template, filling it in, and uploading. Best for large catalogues.",
  ];

  const handleToggleBulkEdit = (next) => {
    const body = new FormData();
    body.set("intent", "toggle_bulk_edit");
    body.set("enabled", next ? "true" : "false");
    fetcher.submit(body, { method: "POST" });
  };

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

          {/* ── Status Banners ── */}
          {carrierStatus.message && (
            <Banner
              tone={carrierStatus.state === "success" ? "success" : "info"}
            >
              {carrierStatus.message}
            </Banner>
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
                    JSON.stringify(
                      carrierStatus.staleServices.map((s) => s.id),
                    ),
                  );
                  fetcher.submit(body, { method: "POST" });
                },
                loading:
                  fetcher.state === "submitting" &&
                  fetcher.formData?.get("intent") ===
                    "cleanup_carrier_services",
              }}
            >
              <p>
                These can cause your customers to see duplicate shipping
                options at checkout. Clicking <b>Clean up</b> removes the old
                ones safely — your current rates are not affected.
              </p>
            </Banner>
          )}

          {/* ── Main Content ── */}
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            <Box paddingBlockStart="300" paddingInlineStart="400" paddingInlineEnd="400">
              <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
                <Text tone="subdued" variant="bodySm">
                  {tabDescriptions[selectedTab]}
                </Text>
                {/* Bulk Edit has its own inline "View documentation" buttons
                    and a dedicated guide modal, so hiding the global Help
                    guide here keeps the toolbar from looking redundant. */}
                {selectedTab !== 2 && (
                  <Button
                    icon={InfoIcon}
                    onClick={() => shopify.modal.show("docs-modal")}
                    accessibilityLabel="Open help guide"
                  >
                    Help guide
                  </Button>
                )}
              </InlineStack>
            </Box>
            <Box paddingBlockStart="400">
              {/* When Bulk Edit owns rule editing, lock the other tabs to
                  read-only so the two paths don't fight each other. Rules
                  stay in the DB — they just become editable again when Bulk
                  Edit is turned off. */}
              {bulkEditEnabled && selectedTab !== 2 && (
                <Box paddingBlockEnd="300">
                  <Banner
                    tone="info"
                    title="You're using the Excel spreadsheet right now"
                  >
                    <p>
                      Customers are seeing the rates you uploaded in the{" "}
                      <b>Bulk edit</b> tab. The zone-by-zone settings on this
                      page are saved but switched off until you turn Bulk edit
                      off again — nothing here is lost.
                    </p>
                  </Banner>
                </Box>
              )}
              {selectedTab === 0 ? (
                <div
                  className="config-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "384px 1fr",
                    gap: "24px",
                    alignItems: "start",
                  }}
                >
                  <ZoneSidebar
                    zones={zones}
                    selectedZoneId={selectedZoneId}
                    onSelectZone={setSelectedZoneId}
                    onCreateZone={openCreateModal}
                    disabled={bulkEditEnabled}
                  />

                  <LogicEditor
                    activeZone={activeZone}
                    logicType={logicType}
                    setLogicType={setLogicType}
                    currency={currency}
                    setCurrency={setCurrency}
                    rules={rules}
                    setRules={setRules}
                    onSave={handleSave}
                    onDeleteRule={handleDeleteRule}
                    onEditRegions={openEditModal}
                    onDeleteZone={handleDeleteZone}
                    onCreateZone={openCreateModal}
                    isSaving={fetcher.state === "submitting"}
                    disabled={bulkEditEnabled}
                  />
                </div>
              ) : selectedTab === 1 ? (
                <RulesOverview
                  zones={zones}
                  bulkRules={bulkRules}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  filterType={filterType}
                  setFilterType={setFilterType}
                  sortOrder={sortOrder}
                  setSortOrder={setSortOrder}
                  onEditZone={(id) => {
                    setSelectedZoneId(id);
                    setSelectedTab(0);
                  }}
                  onDeleteRule={handleDeleteRule}
                  disabled={bulkEditEnabled}
                  bulkMode={bulkEditEnabled}
                />
              ) : (
                <BulkEdit
                  enabled={bulkEditEnabled}
                  lastUpload={lastBulkUpload}
                  onToast={(m) => {
                    setToastMsg(m);
                    revalidator.revalidate();
                    setTimeout(
                      () => setToastMsg(null),
                      toastDuration(m, String(m || "").startsWith("Error")),
                    );
                  }}
                  onApplied={() => setSelectedTab(1)}
                  onToggleEnabled={handleToggleBulkEdit}
                  toggling={
                    fetcher.state === "submitting" &&
                    fetcher.formData?.get("intent") === "toggle_bulk_edit"
                  }
                />
              )}
            </Box>
          </Tabs>
        </BlockStack>
      </div>

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
        deletingZoneId={deletingZoneId}
        setDeletingZoneId={setDeletingZoneId}
        onConfirmDelete={confirmDeleteZone}
      />

      {/* ── Documentation Modal ── */}
      <ui-modal id="docs-modal" variant="max">
        <div className="shipofix-docs">
          <div className="shipofix-docs-hero">
            <h1>Shipofix help guide</h1>
            <p>
              A plain-English walk-through of how Shipofix decides what to
              charge for shipping. Skim the section you need, or read it
              top-to-bottom the first time.
            </p>
          </div>

          <nav className="shipofix-docs-toc" aria-label="Help guide sections">
            <div className="shipofix-docs-toc-label">Jump to</div>
            <div className="shipofix-docs-toc-links">
              <a href="#docs-quickstart">Quick start</a>
              <a href="#docs-zones">What is a zone?</a>
              <a href="#docs-models">The 6 pricing models</a>
              <a href="#docs-bulk">Bulk edit (Excel)</a>
              <a href="#docs-currency">Currency</a>
              <a href="#docs-connection">Checkout connection</a>
              <a href="#docs-faq">FAQ</a>
            </div>
          </nav>

          {/* ── Quick start ── */}
          <section id="docs-quickstart" className="shipofix-docs-section">
            <h2>Quick start · 4 steps</h2>
            <ol className="shipofix-docs-steps">
              <li>
                <b>Pick a zone</b> from the list on the left of the{" "}
                <i>Set up rates</i> tab. A zone is just a group of countries
                that share the same shipping price.
              </li>
              <li>
                <b>Choose a pricing model</b> from the dropdown — flat rate,
                weight tiers, percent of cart, and so on.
              </li>
              <li>
                <b>Type your price</b> in the fields that appear. The currency
                you pick is shown next to every price box.
              </li>
              <li>
                <b>Click &ldquo;Save shipping rate&rdquo;.</b> Customers see
                the new price at checkout straight away.
              </li>
            </ol>
            <div className="shipofix-docs-tip">
              <b>Tip:</b> Want to edit lots of zones at once? Use the{" "}
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
                <b>Add a new zone</b> — click the &ldquo;Add new zone&rdquo;
                button in the left panel and tick the countries.
              </li>
              <li>
                <b>Change countries</b> — open a zone and click{" "}
                &ldquo;Change countries&rdquo; in the top right.
              </li>
              <li>
                <b>Delete a zone</b> — click &ldquo;Delete zone&rdquo;. The
                zone is removed from your store&apos;s shipping settings.
              </li>
              <li>
                <b>Use Shopify&apos;s own rates instead</b> — change the
                pricing model dropdown to &ldquo;Shopify default&rdquo;. Your
                zone is kept, but Shopify decides the price.
              </li>
            </ul>
          </section>

          {/* ── Pricing models ── */}
          <section id="docs-models" className="shipofix-docs-section">
            <h2>The 6 pricing models</h2>
            <p>
              Each zone uses one of these. Pick the one that matches how you
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
          </section>

          {/* ── Bulk edit ── */}
          <section id="docs-bulk" className="shipofix-docs-section">
            <h2>Bulk edit (Excel)</h2>
            <p>
              If you have lots of zones, editing one at a time is slow. The{" "}
              <i>Bulk edit (Excel)</i> tab lets you:
            </p>
            <ol className="shipofix-docs-steps">
              <li>Download a spreadsheet with every country and zone pre-filled.</li>
              <li>Fill in the rule <b>Name</b>, <b>Pricing model</b>, <b>Currency</b> and <b>Price</b> on the rows you care about.</li>
              <li>Upload the file. Shipofix replaces every bulk-edit rule with what you uploaded.</li>
            </ol>
            <div className="shipofix-docs-tip">
              While bulk edit is on, the zone-by-zone settings in{" "}
              <i>Set up rates</i> are paused — but kept safe. Turn bulk edit
              off any time and they take over again.
            </div>
            <p>
              The Bulk edit tab has its own detailed walkthrough (button:{" "}
              <i>View documentation</i>) with examples and a country/zone
              code lookup.
            </p>
          </section>

          {/* ── Currency ── */}
          <section id="docs-currency" className="shipofix-docs-section">
            <h2>Currency</h2>
            <p>
              Each zone has its own currency. Pick it from the dropdown when
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
              charge. Shipofix looks up the right zone, applies the rate
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
                in kg. We do the conversion for you, so type your bands in kg.
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
              <h3>What if a country isn&apos;t in any zone?</h3>
              <p>
                Customers from that country won&apos;t see a Shipofix rate.
                Add the country to an existing zone, or create a{" "}
                <b>Rest of world</b> zone to catch everything else.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>Will my saved rates disappear if I turn bulk edit on?</h3>
              <p>
                No. Your zone-by-zone rates are kept exactly as they are.
                Turning bulk edit off brings them back instantly.
              </p>
            </div>
            <div className="shipofix-docs-faq">
              <h3>How do I let Shopify handle a zone instead?</h3>
              <p>
                Change the pricing-model dropdown to <b>Shopify default</b>.
                Shipofix steps aside for that zone and Shopify quotes its own
                rate.
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
