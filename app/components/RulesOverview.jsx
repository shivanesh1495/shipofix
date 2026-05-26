/**
 * RulesOverview — unified table of every shipping rule for the shop.
 *
 * One row per rule. Each row exposes View / Edit / Delete actions. The
 * parent owns the Edit / Delete modals; this component just emits events.
 *
 * Rules come from two sources but live in one ZoneRule table:
 *   • source = 'shopify' → vendor created the zone via "Add new zone" and
 *     attached a pricing model. Editing can also change country coverage
 *     (via the ZoneModal opened from the Edit modal).
 *   • source = 'bulk'    → rule was created by the Excel upload. Country
 *     coverage is owned by the spreadsheet; only the pricing model fields
 *     are editable inline.
 */

import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  Icon,
  InlineStack,
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, SearchIcon } from "@shopify/polaris-icons";
import { useMemo, useState } from "react";

const LOGIC_TYPES = [
  { label: "Flat rate", value: "STANDARD_TIER" },
  { label: "Weight tiers", value: "WEIGHT_RANGE" },
  { label: "Order-value tiers", value: "PRICE_RANGE" },
  { label: "Per kilogram", value: "WEIGHT_MULTIPLIER" },
  { label: "% of cart", value: "PRICE_MULTIPLIER" },
  { label: "Per item", value: "ITEM_MULTIPLIER" },
];

const LOGIC_SHORT_NAME = Object.fromEntries(
  LOGIC_TYPES.map((t) => [t.value, t.label]),
);

/* Vendor-friendly summary for the Coverage column. Mirrors what the user
   will see in the View modal but compressed onto a single line. */
function summarizeCoverage(rule) {
  let parsed = [];
  try {
    parsed = JSON.parse(rule.countries || "[]");
  } catch {
    parsed = [];
  }
  if (parsed.length === 0) return "—";

  const fmt = (c) => {
    if (c.restOfWorld) return "Rest of World";
    if (!c.countryCode) return c.name || "";
    return c.name ? `${c.name} (${c.countryCode})` : c.countryCode;
  };

  if (parsed.length === 1) {
    const c = parsed[0];
    const provs = Array.isArray(c.provinces) ? c.provinces : [];
    return provs.length > 0
      ? `${fmt(c)} - ${provs.length} zone${provs.length === 1 ? "" : "s"}`
      : fmt(c);
  }

  return `${fmt(parsed[0])} +${parsed.length - 1} more`;
}

/* Build the rate label shown in the View modal — "₹ 120 / kg", "5 bands",
   "0.1 of cart", etc. */
function summarizeRate(rule) {
  let parsed = {};
  try {
    parsed = JSON.parse(rule.rulesJson || "{}");
  } catch {
    parsed = {};
  }
  const isRange =
    rule.logicType === "WEIGHT_RANGE" || rule.logicType === "PRICE_RANGE";
  if (isRange) {
    const bands = Array.isArray(parsed) ? parsed : [];
    return `${bands.length} band${bands.length === 1 ? "" : "s"}`;
  }
  const v =
    rule.logicType === "STANDARD_TIER"     ? parsed.flat_rate
    : rule.logicType === "WEIGHT_MULTIPLIER" ? parsed.rate_per_kg
    : rule.logicType === "PRICE_MULTIPLIER"  ? parsed.percentage
    : rule.logicType === "ITEM_MULTIPLIER"   ? parsed.rate_per_item
    : null;
  if (v == null || v === "") return "—";
  return `${v} ${rule.currency || "USD"}`;
}

/* Pull the rule's pricing details into a structured object the View modal
   renders. Range rules include band lists; non-range rules include the
   default rate and any per-destination overrides. */
function parseViewModel(rule) {
  let parsedRules = {};
  try {
    parsedRules = JSON.parse(rule.rulesJson || "{}");
  } catch {
    parsedRules = {};
  }
  let parsedCountries = [];
  try {
    parsedCountries = JSON.parse(rule.countries || "[]");
  } catch {
    parsedCountries = [];
  }
  return { parsedRules, parsedCountries };
}

export default function RulesOverview({
  rules = [],
  searchQuery,
  setSearchQuery,
  filterType,
  setFilterType,
  sortOrder,
  setSortOrder,
  onEditRule,
  onDeleteRule,
  onAddZone,
  isDeleting = false,
}) {
  const [viewingRuleId, setViewingRuleId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  /* Filter + sort + search the rules into the order shown in the table.
     Search matches against name + coverage summary so vendors can hunt
     either way ("Canada" or "Express AU"). */
  const visibleRules = useMemo(() => {
    let result = [...rules];

    if (filterType && filterType !== "ALL") {
      result = result.filter((r) => r.logicType === filterType);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((r) =>
        [r.name, summarizeCoverage(r)]
          .some((v) => String(v || "").toLowerCase().includes(q)),
      );
    }

    if (sortOrder === "NAME_ASC") {
      result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (sortOrder === "NAME_DESC") {
      result.sort((a, b) => (b.name || "").localeCompare(a.name || ""));
    }

    return result;
  }, [rules, searchQuery, filterType, sortOrder]);

  const viewingRule = useMemo(
    () => rules.find((r) => r.id === viewingRuleId) || null,
    [rules, viewingRuleId],
  );

  const deletingRule = useMemo(
    () => rules.find((r) => r.id === confirmDeleteId) || null,
    [rules, confirmDeleteId],
  );

  const viewModel = useMemo(
    () => (viewingRule ? parseViewModel(viewingRule) : null),
    [viewingRule],
  );

  return (
    <Box paddingBlockEnd="500">
      <BlockStack gap="400">
        {/* Filters + table */}
        <Card>
          <BlockStack gap="400">
            {/* Header strip — search/filter/sort + Add new zone button */}
            <InlineStack gap="300" align="start" wrap>
              <Box minWidth="280px">
                <TextField
                  label="Search rules"
                  labelHidden
                  value={searchQuery}
                  onChange={setSearchQuery}
                  prefix={<Icon source={SearchIcon} />}
                  placeholder="Search by name, country, or zone…"
                  autoComplete="off"
                />
              </Box>
              <Box minWidth="200px">
                <Select
                  label="Pricing model filter"
                  labelHidden
                  options={[
                    { label: "All pricing models", value: "ALL" },
                    ...LOGIC_TYPES,
                  ]}
                  value={filterType}
                  onChange={setFilterType}
                />
              </Box>
              <Box minWidth="160px">
                <Select
                  label="Sort"
                  labelHidden
                  options={[
                    { label: "Name A → Z", value: "NAME_ASC" },
                    { label: "Name Z → A", value: "NAME_DESC" },
                  ]}
                  value={sortOrder}
                  onChange={setSortOrder}
                />
              </Box>
              <div style={{ marginLeft: "auto" }}>
                <Button variant="primary" onClick={onAddZone}>
                  + Add new zone
                </Button>
              </div>
            </InlineStack>

            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Name", "Coverage", "Pricing model", "Actions"]}
              rows={visibleRules.map((r) => [
                <Text key={`n-${r.id}`} fontWeight="semibold">
                  {r.name}
                </Text>,
                summarizeCoverage(r),
                <InlineStack key={`l-${r.id}`} gap="100" blockAlign="center">
                  <Badge tone="info">
                    {LOGIC_SHORT_NAME[r.logicType] || r.logicType}
                  </Badge>
                  {r.source === "bulk" && (
                    <Badge tone="attention">Excel</Badge>
                  )}
                </InlineStack>,
                <InlineStack key={`a-${r.id}`} gap="200" wrap={false}>
                  <Button
                    size="micro"
                    onClick={() => setViewingRuleId(r.id)}
                  >
                    View
                  </Button>
                  <Button
                    size="micro"
                    variant="primary"
                    tone="success"
                    onClick={() => onEditRule?.(r)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="micro"
                    tone="critical"
                    icon={DeleteIcon}
                    accessibilityLabel={`Delete rule ${r.name}`}
                    onClick={() => setConfirmDeleteId(r.id)}
                    disabled={isDeleting}
                  >
                    Delete
                  </Button>
                </InlineStack>,
              ])}
            />

            {visibleRules.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: "40px 20px",
                }}
              >
                <Text variant="bodyMd" tone="subdued">
                  {rules.length === 0
                    ? "No shipping rules yet — click “+ Add new zone” to create your first rule, or upload an Excel template from the Bulk edit tab."
                    : "No rules match your filters."}
                </Text>
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* ── View (read-only details) modal ────────────────────────────── */}
      <Modal
        open={!!viewingRule}
        onClose={() => setViewingRuleId(null)}
        title={viewingRule ? `"${viewingRule.name}" details` : "Rule details"}
        primaryAction={{
          content: "Edit this rule",
          onAction: () => {
            const r = viewingRule;
            setViewingRuleId(null);
            if (r) onEditRule?.(r);
          },
        }}
        secondaryActions={[
          { content: "Close", onAction: () => setViewingRuleId(null) },
        ]}
      >
        {viewingRule && viewModel && (
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack gap="400" wrap>
                <BlockStack gap="050">
                  <Text tone="subdued" variant="bodySm">Pricing model</Text>
                  <Badge tone="info">
                    {LOGIC_SHORT_NAME[viewingRule.logicType] || viewingRule.logicType}
                  </Badge>
                </BlockStack>
                <BlockStack gap="050">
                  <Text tone="subdued" variant="bodySm">Currency</Text>
                  <Text fontWeight="semibold">
                    {viewingRule.currency || "USD"}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text tone="subdued" variant="bodySm">Source</Text>
                  <Text fontWeight="semibold">
                    {viewingRule.source === "bulk"
                      ? "Excel upload"
                      : "One-by-one editor"}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text tone="subdued" variant="bodySm">Rate</Text>
                  <Text fontWeight="semibold">{summarizeRate(viewingRule)}</Text>
                </BlockStack>
              </InlineStack>

              {/* Range type? show the band list */}
              {(viewingRule.logicType === "WEIGHT_RANGE" ||
                viewingRule.logicType === "PRICE_RANGE") && (
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h3">Bands</Text>
                  {(() => {
                    const bands = Array.isArray(viewModel.parsedRules)
                      ? viewModel.parsedRules
                      : [];
                    if (bands.length === 0) {
                      return <Text tone="subdued">No bands defined.</Text>;
                    }
                    const minKey = viewingRule.logicType === "WEIGHT_RANGE" ? "min_kg" : "min_total";
                    const maxKey = viewingRule.logicType === "WEIGHT_RANGE" ? "max_kg" : "max_total";
                    const unit = viewingRule.logicType === "WEIGHT_RANGE" ? "kg" : viewingRule.currency;
                    return (
                      <BlockStack gap="100">
                        {bands.map((b, i) => (
                          <InlineStack key={i} gap="300">
                            <Text>
                              {b[minKey] ?? 0} {unit} →{" "}
                              {b[maxKey] != null ? `${b[maxKey]} ${unit}` : "∞"}
                            </Text>
                            <Text fontWeight="semibold">
                              {b.rate} {viewingRule.currency}
                            </Text>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    );
                  })()}
                </BlockStack>
              )}

              {/* Coverage breakdown */}
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">
                  Coverage ({viewModel.parsedCountries.length} country
                  {viewModel.parsedCountries.length === 1 ? "" : "s"})
                </Text>
                {viewModel.parsedCountries.length === 0 ? (
                  <Text tone="subdued">No countries.</Text>
                ) : (
                  <BlockStack gap="100">
                    {viewModel.parsedCountries.map((c, i) => {
                      const label = c.restOfWorld
                        ? "Rest of World"
                        : c.countryCode
                          ? `${c.name || c.countryCode} (${c.countryCode})`
                          : (c.name || "—");
                      const provs = Array.isArray(c.provinces) ? c.provinces : [];
                      return (
                        <BlockStack key={i} gap="050">
                          <Text fontWeight="semibold">{label}</Text>
                          {provs.length > 0 && (
                            <Text tone="subdued" variant="bodySm">
                              {provs
                                .map((p) =>
                                  p.code && p.name ? `${p.name} (${p.code})` : (p.name || p.code),
                                )
                                .join(", ")}
                            </Text>
                          )}
                        </BlockStack>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>

              {/* Any per-destination overrides? show them */}
              {Array.isArray(viewModel.parsedRules.overrides) &&
                viewModel.parsedRules.overrides.length > 0 && (
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">
                      Per-destination rate overrides
                    </Text>
                    <BlockStack gap="100">
                      {viewModel.parsedRules.overrides.map((o, i) => (
                        <InlineStack key={i} gap="200">
                          <Text>
                            {o.countryCode}
                            {o.province ? ` · ${o.province}` : ""}
                          </Text>
                          <Text fontWeight="semibold">
                            {o.rate} {viewingRule.currency}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </BlockStack>
                )}
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>

      {/* ── Delete-confirmation modal ─────────────────────────────────── */}
      <Modal
        open={!!deletingRule}
        onClose={() => setConfirmDeleteId(null)}
        title={
          deletingRule ? `Delete "${deletingRule.name}"?` : "Delete rule?"
        }
        primaryAction={{
          content: "Delete rule",
          destructive: true,
          onAction: () => {
            const id = confirmDeleteId;
            setConfirmDeleteId(null);
            if (id) onDeleteRule?.(deletingRule);
          },
          loading: isDeleting,
          disabled: isDeleting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setConfirmDeleteId(null),
            disabled: isDeleting,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text>
              This permanently removes the rule. Customers shipping to its
              countries will fall back to whatever other rules cover them
              (or to Shopify&apos;s default rates if nothing else matches).
            </Text>
            {deletingRule?.source === "bulk" && (
              <Text tone="subdued" variant="bodySm">
                This rule came from the Excel template. Removing it here
                also removes it from the stored spreadsheet — re-upload the
                file later to bring it back.
              </Text>
            )}
            {deletingRule?.source !== "bulk" && (
              <Text tone="subdued" variant="bodySm">
                The Shopify delivery zone is not deleted — only the
                pricing rule attached to it.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Box>
  );
}
