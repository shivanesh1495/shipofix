/**
 * RulesOverview — searchable, filterable data table of all zones.
 * Premium design with stat cards, enhanced table, and polished filters.
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
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useMemo } from "react";

const LOGIC_TYPES = [
  { label: "Standard Flat Tier", value: "STANDARD_TIER" },
  { label: "Weight Based (Category)", value: "WEIGHT_RANGE" },
  { label: "Price Based (Category)", value: "PRICE_RANGE" },
  { label: "Per KG Dynamic", value: "WEIGHT_MULTIPLIER" },
  { label: "Per Price Dynamic", value: "PRICE_MULTIPLIER" },
  { label: "Per Item Dynamic", value: "ITEM_MULTIPLIER" },
];

const LOGIC_LABELS = Object.fromEntries(
  LOGIC_TYPES.map((t) => [t.value, t.label]),
);

/* Map server-side logic types to the Logic # vendors see in the Bulk Edit
   template, so the spreadsheet view here matches the .xlsx column exactly. */
const LOGIC_NUM = {
  STANDARD_TIER: 1,
  WEIGHT_RANGE: 2,
  PRICE_RANGE: 3,
  WEIGHT_MULTIPLIER: 4,
  PRICE_MULTIPLIER: 5,
  ITEM_MULTIPLIER: 6,
};

function fmtCountry(c) {
  if (c.restOfWorld) return "Rest of World";
  const name = c.name || c.countryCode || "—";
  return c.countryCode ? `${name} (${c.countryCode})` : name;
}

function fmtProvince(p) {
  if (p.code && p.name) return `${p.name} (${p.code})`;
  return p.name || p.code || "";
}

/* Summary label for the Country column: "India (IN)", or
   "India (IN) +2 more" when the zone covers multiple countries. */
function countrySummary(zone) {
  const countries = zone.countries || [];
  if (countries.length === 0) return "";
  const first = fmtCountry(countries[0]);
  if (countries.length === 1) return first;
  return `${first} +${countries.length - 1} more`;
}

/* Flatten one zone + its rule into rule-row(s) for the bulk-mode view.
   Only zones that actually have a bulk-edit rule produce rows — otherwise
   the table would balloon to thousands of empty country/province rows.
   For range types we emit one row per band. */
function flattenZoneForBulk(zone) {
  const rule = zone.bulkRule;
  if (!rule) return [];

  const baseCountry = countrySummary(zone);
  const logicNum = LOGIC_NUM[rule.logicType] ?? "";
  const currency = rule.currency || "";

  let parsed = {};
  try {
    parsed = JSON.parse(rule.rulesJson || "{}");
  } catch {
    parsed = {};
  }

  const row = (extra = {}) => ({
    name: zone.name,
    country: baseCountry,
    zone: "",
    logic: logicNum,
    currency,
    min: "",
    max: "",
    rate: "",
    ...extra,
  });

  switch (rule.logicType) {
    case "STANDARD_TIER":
      return [row({ rate: parsed.flat_rate ?? "" })];
    case "WEIGHT_MULTIPLIER":
      return [row({ rate: parsed.rate_per_kg ?? "" })];
    case "PRICE_MULTIPLIER":
      return [row({ rate: parsed.percentage ?? "" })];
    case "ITEM_MULTIPLIER":
      return [row({ rate: parsed.rate_per_item ?? "" })];
    case "WEIGHT_RANGE":
    case "PRICE_RANGE": {
      const bands = Array.isArray(parsed) ? parsed : [];
      if (bands.length === 0) return [row()];
      const isWeight = rule.logicType === "WEIGHT_RANGE";
      const minKey = isWeight ? "min_kg" : "min_total";
      const maxKey = isWeight ? "max_kg" : "max_total";
      /* First band carries Name/Country/Logic/Currency; subsequent bands
         show just Min/Max/Rate (matches the .xlsx template convention). */
      return bands.map((b, i) =>
        i === 0
          ? row({
              min: b[minKey] ?? "",
              max: b[maxKey] ?? "",
              rate: b.rate ?? "",
            })
          : {
              name: "",
              country: "",
              zone: "",
              logic: "",
              currency: "",
              min: b[minKey] ?? "",
              max: b[maxKey] ?? "",
              rate: b.rate ?? "",
            },
      );
    }
    default:
      return [row()];
  }
}

export default function RulesOverview({
  zones,
  searchQuery,
  setSearchQuery,
  filterType,
  setFilterType,
  sortOrder,
  setSortOrder,
  onEditZone,
  onDeleteRule,
  disabled = false,
  bulkMode = false,
}) {
  /* Spreadsheet-style rows for Bulk-Edit mode. Built lazily so we only pay
     the flatten cost when actually showing this view. */
  const bulkRows = useMemo(() => {
    if (!bulkMode) return [];
    let rows = zones.flatMap((z) => flattenZoneForBulk(z));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((r) =>
        [r.name, r.country, r.zone]
          .some((v) => String(v || "").toLowerCase().includes(q)),
      );
    }
    if (filterType !== "ALL") {
      const num = LOGIC_NUM[filterType];
      rows = rows.filter((r) => r.logic === num);
    }
    if (sortOrder === "NAME_ASC")
      rows.sort((a, b) => a.name.localeCompare(b.name));
    if (sortOrder === "NAME_DESC")
      rows.sort((a, b) => b.name.localeCompare(a.name));
    return rows;
  }, [bulkMode, zones, searchQuery, filterType, sortOrder]);

  const filteredZones = useMemo(() => {
    let result = zones.map((z) => ({
      ...z,
      logic: z.rule ? LOGIC_LABELS[z.rule.logicType] : "Shopify Default",
      updatedAt: z.rule
        ? new Date(z.rule.updatedAt).toLocaleDateString()
        : "N/A",
    }));

    if (searchQuery) {
      result = result.filter((z) =>
        z.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    }
    if (filterType !== "ALL") {
      result = result.filter(
        (z) => (z.rule?.logicType || "DEFAULT") === filterType,
      );
    }

    result.sort((a, b) => {
      if (sortOrder === "NAME_ASC") return a.name.localeCompare(b.name);
      if (sortOrder === "NAME_DESC") return b.name.localeCompare(a.name);
      return 0;
    });

    return result;
  }, [zones, searchQuery, filterType, sortOrder]);

  return (
    <Box paddingBlockEnd="500">
      <BlockStack gap="400">
        {/* Filters + Table */}
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" align="start">
              <Box minWidth="300px">
                <TextField
                  label="Search zones"
                  labelHidden
                  value={searchQuery}
                  onChange={setSearchQuery}
                  prefix={<Icon source={SearchIcon} />}
                  placeholder={
                    bulkMode
                      ? "Search by name, country, or zone…"
                      : "Search by zone name..."
                  }
                  autoComplete="off"
                />
              </Box>
              <Box minWidth="200px">
                <Select
                  label="Filter Logic"
                  labelHidden
                  options={[
                    { label: "All logic types", value: "ALL" },
                    ...LOGIC_TYPES,
                  ]}
                  value={filterType}
                  onChange={setFilterType}
                />
              </Box>
              <Box minWidth="160px">
                <Select
                  label="Sort By"
                  labelHidden
                  options={[
                    { label: "Name A → Z", value: "NAME_ASC" },
                    { label: "Name Z → A", value: "NAME_DESC" },
                  ]}
                  value={sortOrder}
                  onChange={setSortOrder}
                />
              </Box>
            </InlineStack>

            {bulkMode ? (
              <>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Name",
                    "Country",
                    "Zone",
                    "Logic #",
                    "Currency",
                    "Min",
                    "Max",
                    "Rate",
                  ]}
                  rows={bulkRows.map((r, i) => [
                    <Text key={`n-${i}`} fontWeight={r.name ? "semibold" : "regular"}>
                      {r.name}
                    </Text>,
                    r.country || "",
                    r.zone || "",
                    r.logic !== "" ? (
                      <Badge key={`l-${i}`} tone="success">{String(r.logic)}</Badge>
                    ) : (
                      ""
                    ),
                    r.currency || "",
                    r.min === "" || r.min == null ? "" : String(r.min),
                    r.max === "" || r.max == null ? "" : String(r.max),
                    r.rate === "" || r.rate == null ? "" : String(r.rate),
                  ])}
                />
                {bulkRows.length === 0 && (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "40px 20px",
                      color: "var(--text-muted)",
                    }}
                  >
                    <Text variant="bodySm" tone="subdued">
                      No rows match your filters
                    </Text>
                  </div>
                )}
              </>
            ) : (
              <>
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric"]}
                  headings={[
                    "Zone Name",
                    "Logic Type",
                    "Last Updated",
                    "Actions",
                  ]}
                  rows={filteredZones.map((z) => [
                    <Text key={z.id} fontWeight="bold">
                      {z.name}
                    </Text>,
                    <Badge
                      key={z.id + "logic"}
                      tone={z.rule ? "success" : "subdued"}
                    >
                      {z.logic}
                    </Badge>,
                    <Text key={z.id + "up"} tone="subdued">
                      {z.updatedAt}
                    </Text>,
                    <InlineStack key={z.id + "act"} gap="200">
                      <Button
                        variant="tertiary"
                        onClick={() => onEditZone(z.id)}
                        disabled={disabled}
                      >
                        Edit
                      </Button>
                      {z.rule && (
                        <Button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => onDeleteRule(z.rule.id)}
                          disabled={disabled}
                        >
                          Reset
                        </Button>
                      )}
                    </InlineStack>,
                  ])}
                />

                {filteredZones.length === 0 && (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "40px 20px",
                      color: "var(--text-muted)",
                    }}
                  >
                    <Text variant="bodySm" tone="subdued">
                      No zones match your filters
                    </Text>
                  </div>
                )}
              </>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Box>
  );
}
