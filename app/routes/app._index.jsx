import { useCallback, useEffect, useMemo, useState } from "react";
import { useActionData, useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
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
    const currency = formData.get("currency") || "INR";

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
  const [currency, setCurrency] = useState("INR");
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
      setLogicType("STANDARD_TIER");
      setCurrency("INR");
      setRules({});
    }
  }, [activeZone]);

  // Feedback from fetcher — revalidate in-place instead of full page reload
  useEffect(() => {
    if (fetcher.data?.message) {
      setToastMsg(fetcher.data.message);
      revalidator.revalidate();
      setTimeout(() => setToastMsg(null), 4000);
    }
    if (fetcher.data?.error) {
      setToastMsg(`Error: ${fetcher.data.error}`);
      setTimeout(() => setToastMsg(null), 6000);
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (actionData?.message) {
      setToastMsg(actionData.message);
      setTimeout(() => setToastMsg(null), 4000);
    }
    if (actionData?.error) {
      setToastMsg(`Error: ${actionData.error}`);
      setTimeout(() => setToastMsg(null), 6000);
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
      content: "Configuration Logic",
      accessibilityLabel: "Configure rules",
    },
    {
      id: "overview",
      content: "Rules Overview",
      accessibilityLabel: "View all rules",
    },
    {
      id: "bulk",
      content: "Bulk Edit",
      accessibilityLabel: "Bulk edit via Excel template",
    },
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingBottom: "4px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <img src="/logo.svg" alt="Shipofix Logo" style={{ width: "48px", height: "48px", borderRadius: "12px", boxShadow: "var(--shadow-sm)" }} />
              <div>
                <div className="brand-title">shipofix</div>
                <div className="brand-subtitle">
                  Dynamic shipping rate engine · Zone-based configuration
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "4px" }}>
              <Button
                icon={InfoIcon}
                variant="tertiary"
                onClick={() => shopify.modal.show("docs-modal")}
                accessibilityLabel="App documentation"
              />
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
              title={`${carrierStatus.staleServices.length} duplicate shipping engine(s) detected`}
              action={{
                content: "Fix and Deduplicate",
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
                Clean up old registrations to avoid duplicate rates at checkout.
              </p>
            </Banner>
          )}

          {/* ── Main Content ── */}
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            <Box paddingBlockStart="400">
              {/* When Bulk Edit owns rule editing, lock the other tabs to
                  read-only so the two paths don't fight each other. Rules
                  stay in the DB — they just become editable again when Bulk
                  Edit is turned off. */}
              {bulkEditEnabled && selectedTab !== 2 && (
                <Box paddingBlockEnd="300">
                  <Banner
                    tone="info"
                    title="Bulk Edit is active — zone-wise rules are paused"
                  >
                    <p>
                      The Excel ruleset is what checkout uses right now. Your
                      zone-wise rules below are preserved exactly as they are
                      and will take over again the moment Bulk Edit is turned
                      off (from the Bulk Edit tab).
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
                    setTimeout(() => setToastMsg(null), 4000);
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
        <div style={{ padding: "32px 40px", fontFamily: "var(--font-sans)", maxHeight: "80vh", overflowY: "auto" }}>
          <div style={{ marginBottom: "28px" }}>
            <h1 style={{ fontSize: "1.8rem", fontWeight: 800, marginBottom: "6px" }}>shipofix Documentation</h1>
            <p style={{ color: "#737373", fontSize: "1rem" }}>Complete guide to configuring your shipping rates</p>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Overview</h2>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "20px" }}>
            shipofix is a custom Carrier Service app for Shopify that lets you define dynamic shipping rates
            per zone. It registers as a shipping rate provider and calculates rates at checkout based on cart
            weight, total price, or item count.
          </p>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>How It Works</h2>
          <ol style={{ fontSize: "1rem", color: "#525252", lineHeight: 2, paddingLeft: "24px", marginBottom: "20px" }}>
            <li>Create or select a <strong>Shipping Zone</strong> from the sidebar.</li>
            <li>Choose a <strong>Logic Type</strong> for that zone.</li>
            <li>Configure the rate parameters and select your <strong>Currency</strong>.</li>
            <li>Click <strong>Save Rule</strong> — the rate will be applied at checkout automatically.</li>
          </ol>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "16px" }}>Logic Types</h2>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>1. Standard Flat Tier</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              A fixed shipping charge regardless of cart contents. Enter a flat rate amount and every order
              shipping to this zone will use that rate.
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>2. Weight Based (Category)</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              Define weight ranges (slabs) with different rates. For example: 0–5 kg = ₹50, 5–10 kg = ₹80.
              The app matches the cart's total weight (converted from grams to kg) against your ranges.
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>3. Price Based (Category)</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              Define order value ranges with different rates. For example: ₹0–₹500 = ₹40, ₹500–₹2000 = ₹25.
              The app matches the cart's total price against your ranges.
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>4. Per KG Dynamic</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              Charges a rate per kilogram of cart weight.<br />
              <strong>Formula:</strong> Total Weight (kg) × Rate per KG = Shipping Cost
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>5. Per Price Dynamic</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              Charges a percentage of the cart's total value.<br />
              <strong>Formula:</strong> Cart Total × Percentage = Shipping Cost<br />
              Example: 0.1 means 10% of order value.
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "6px" }}>6. Per Item Dynamic</h3>
            <p style={{ fontSize: "0.95rem", color: "#525252", lineHeight: 1.7 }}>
              Charges a fixed amount per item in the cart.<br />
              <strong>Formula:</strong> Total Items × Rate per Item = Shipping Cost
            </p>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Zone Management</h2>
          <ul style={{ fontSize: "1rem", color: "#525252", lineHeight: 2, paddingLeft: "24px", marginBottom: "20px" }}>
            <li><strong>Create Zone</strong> — Click "+" or "Add new zone" to create a new shipping zone with countries.</li>
            <li><strong>Edit Regions</strong> — Add or remove countries/provinces from an existing zone.</li>
            <li><strong>Delete Zone</strong> — Removes the zone from Shopify's delivery profile.</li>
            <li><strong>Shopify Default</strong> — Setting logic to "Shopify Default" removes the custom rule and lets Shopify handle rates natively.</li>
          </ul>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Rules Overview Tab</h2>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "20px" }}>
            The "Rules Overview" tab shows a summary table of all zones with their logic type, scope (domestic/international),
            and last updated date. Use the search bar and filters to find specific zones. Click "Edit" to jump to configuration, 
            or "Reset" to remove a custom rule.
          </p>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Currency</h2>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "20px" }}>
            Select the currency for your shipping rates from the dropdown. All 150+ ISO 4217 currencies are supported.
            The currency code is shown as the prefix in rate input fields.
          </p>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Carrier Service</h2>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "16px" }}>
            The app automatically registers a Carrier Service with Shopify. When a customer checks out,
            Shopify sends the cart data to this app's <code style={{ background: "#F5F5F5", padding: "3px 8px", borderRadius: "4px", fontSize: "0.9rem" }}>/api/shipping</code> endpoint.
            The app calculates the rate based on the matching zone's rules and returns it to checkout.
          </p>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "20px" }}>
            If you see a "duplicate shipping engine" warning banner, click "Fix and Deduplicate" to clean up
            old carrier service registrations.
          </p>

          <hr style={{ border: "none", borderTop: "1px solid #E5E5E5", margin: "24px 0" }} />

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "10px" }}>Weight Conversion</h2>
          <p style={{ fontSize: "1rem", color: "#525252", lineHeight: 1.7, marginBottom: "20px" }}>
            Shopify sends product weights in grams. The app automatically converts grams → kilograms
            (divides by 1000) before applying weight-based calculations.
          </p>

          <div style={{ padding: "18px 20px", background: "#F5F5F5", borderRadius: "12px", marginTop: "12px" }}>
            <p style={{ fontSize: "0.95rem", color: "#737373", margin: 0 }}>
              Need help? Contact the developer or check the app source code for technical details.
            </p>
          </div>
        </div>
        <ui-title-bar title="Documentation">
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
