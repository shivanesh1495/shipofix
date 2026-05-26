import { useCallback, useEffect, useState } from "react";
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
import RulesOverview from "../components/RulesOverview";
import ZoneModal from "../components/ZoneModal";
import EditRuleModal from "../components/EditRuleModal";
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
          if (methodCount === 0) zonesWithoutMethods.push(z.id);
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

  const uniqueZones = Array.from(zoneMap.values());

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
  const missingZones = uniqueZones.filter((z) => !rulesByGid.has(z.id));
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

  /* Fresh read after sync — single source of truth for the UI. */
  const allRules = await prisma.zoneRule.findMany({
    where: { shop: shopDomain },
    orderBy: { updatedAt: "desc" },
  });

  return {
    rules: allRules,
    zones: uniqueZones,
    carrierStatus,
    shopCountry,
    profileId,
    locationGroupId,
    shippingUrl: `https://${shopDomain}/admin/settings/shipping`,
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
    const name = formData.get("name");
    const logicType = formData.get("logicType");
    const rulesJson = formData.get("rulesJson");
    const currency = formData.get("currency") || "USD";

    if (!id) return { success: false, error: "Missing rule id." };

    const existing = await prisma.zoneRule.findFirst({
      where: { id, shop: shopDomain },
    });
    if (!existing) return { success: false, error: "Rule not found." };

    await prisma.zoneRule.update({
      where: { id },
      data: { name, logicType, rulesJson, currency },
    });

    return { success: true, message: `"${name}" saved.` };
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

    if (rule.source === "shopify") {
      const profileId = formData.get("profileId");
      const locationGroupId = formData.get("locationGroupId");
      if (profileId && locationGroupId) {
        const res = await admin.graphql(MUTATION_DELIVERY_PROFILE_UPDATE, {
          variables: {
            profileId,
            profile: { zonesToDelete: [rule.deliveryZoneGid] },
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
    profileId,
    locationGroupId,
  } = useLoaderData();
  const actionData = useActionData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [selectedTab, setSelectedTab] = useState(0);

  // Table filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [sortOrder, setSortOrder] = useState("NAME_ASC");

  // ZoneModal state (create new zone OR change countries on an existing rule)
  const [zoneModalMode, setZoneModalMode] = useState(null);
  const [modalZoneName, setModalZoneName] = useState("");
  const [modalSelectedRegions, setModalSelectedRegions] = useState({});
  const [expandedCountries, setExpandedCountries] = useState(new Set());
  const [editingZoneId, setEditingZoneId] = useState(null);
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
     with the rule's current coverage. Only valid for zone-wise rules — the
     bulk path is blocked at the EditRuleModal level. */
  const openChangeCountries = useCallback((rule) => {
    /* Find the underlying Shopify zone (zone-wise rule's deliveryZoneGid
       matches a real Shopify zone GID). */
    const z = zones.find((zo) => zo.id === rule.deliveryZoneGid);
    if (!z) return;

    setZoneModalMode("edit");
    setModalZoneName(z.name);
    const initialRegions = {};
    z.countries.forEach((c) => {
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
    setEditingZoneId(z.id);
    setCountrySearch("");
    /* Close the EditRule modal first so the two modals don't stack. */
    setEditingRule(null);
    shopify.modal.show("zone-modal");
  }, [zones]);

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

  const tabs = [
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
  ];

  const tabDescriptions = [
    "A single table of every shipping rule, its pricing model and how much it charges. Use the Edit button on any row to change the rate, currency, or — for zone-wise rules — which countries it covers.",
    "Edit many rules at once by downloading the template, filling it in, and uploading. Best for large catalogues.",
  ];

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

          {/* ── Status banners ── */}
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
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            <Box paddingBlockStart="300" paddingInlineStart="400" paddingInlineEnd="400">
              <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
                <Text tone="subdued" variant="bodySm">
                  {tabDescriptions[selectedTab]}
                </Text>
                {/* Bulk Edit has its own inline "View documentation" buttons
                    and a dedicated guide modal, so hiding the global Help
                    guide on that tab keeps the toolbar from looking redundant. */}
                {selectedTab !== 1 && (
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
              {selectedTab === 0 ? (
                <RulesOverview
                  rules={rules}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  filterType={filterType}
                  setFilterType={setFilterType}
                  sortOrder={sortOrder}
                  setSortOrder={setSortOrder}
                  onEditRule={handleEditRule}
                  onDeleteRule={handleDeleteRule}
                  onAddZone={openCreateModal}
                  isDeleting={
                    fetcher.state === "submitting" &&
                    fetcher.formData?.get("intent") === "delete_rule"
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
          </Tabs>
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
            <h2>Quick start · 3 steps</h2>
            <ol className="shipofix-docs-steps">
              <li>
                <b>Click &ldquo;+ Add new zone&rdquo;</b> on the All rates
                tab. Give the zone a name, tick the countries (and provinces,
                if needed), and click <i>Create</i>.
              </li>
              <li>
                <b>Click Edit</b> on the row that appeared. Pick a pricing
                model from the dropdown — flat rate, weight tiers, percent
                of cart, and so on. Type your price.
              </li>
              <li>
                <b>Click &ldquo;Save shipping rate&rdquo;.</b> Customers see
                the new price at checkout straight away.
              </li>
            </ol>
            <div className="shipofix-docs-tip">
              <b>Tip:</b> Want to edit lots of rules at once? Use the{" "}
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
                <b>Add a new zone</b> — click the &ldquo;+ Add new zone&rdquo;
                button at the top right of the All rates table and tick the
                countries.
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

          {/* ── Pricing models ── */}
          <section id="docs-models" className="shipofix-docs-section">
            <h2>The 6 pricing models</h2>
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
          </section>

          {/* ── Bulk edit ── */}
          <section id="docs-bulk" className="shipofix-docs-section">
            <h2>Bulk edit (Excel)</h2>
            <p>
              If you have lots of rules, editing one at a time is slow. The{" "}
              <i>Bulk edit (Excel)</i> tab lets you:
            </p>
            <ol className="shipofix-docs-steps">
              <li>Download a spreadsheet with every country pre-filled.</li>
              <li>Fill in the rule <b>Name</b>, <b>Pricing model</b>, <b>Currency</b> and <b>Price</b> on the rows you care about.</li>
              <li>Upload the file. Shipofix replaces every previously-uploaded rule with what you uploaded.</li>
            </ol>
            <div className="shipofix-docs-tip">
              Excel-uploaded rules live alongside zone-wise rules — both show
              up in the All rates table and both apply at checkout. Re-uploading
              the file only touches rules that came from Excel; your
              zone-wise rules are never overwritten.
            </div>
            <p>
              The Bulk edit tab has its own detailed walkthrough (button:{" "}
              <i>View documentation</i>) with examples and a country / zone
              code lookup.
            </p>
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
