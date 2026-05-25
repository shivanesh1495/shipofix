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

/* Short, vendor-friendly name for the pricing model column in bulk-mode.
   Replaces the cryptic Logic # numeric badge so non-technical users can
   read the table at a glance. */
const LOGIC_SHORT_NAME = {
  STANDARD_TIER: "Flat rate",
  WEIGHT_RANGE: "Weight tiers",
  PRICE_RANGE: "Order-value tiers",
  WEIGHT_MULTIPLIER: "Per kilogram",
  PRICE_MULTIPLIER: "% of cart",
  ITEM_MULTIPLIER: "Per item",
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

/* Flatten one BulkEditRule into spreadsheet-style rows that mirror the
   Excel upload layout: one row per (country, province) coverage cell,
   then any extra band rows for range logic types.

   First row of a rule carries Name / Logic # / Currency. Coverage rows
   after that just show Country / Zone. The rate value lands on the
   first coverage row for non-range types, or on its own band row(s)
   for range types. */
function flattenBulkRule(rule) {
  const logicName = LOGIC_SHORT_NAME[rule.logicType] ?? rule.logicType ?? "";
  const currency = rule.currency || "";

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

  /* Expand countries → one row per (country) or (country × province).
     Carry the raw codes alongside the display labels so per-destination
     override lookup can match without re-parsing the label string. */
  const coverageRows = [];
  for (const c of parsedCountries) {
    if (c.restOfWorld) {
      coverageRows.push({ country: "Rest of World", zone: "", countryCode: "", provinceCode: "" });
      continue;
    }
    const countryLabel = c.countryCode
      ? `${c.name || c.countryCode} (${c.countryCode})`
      : c.name || "—";
    const provinces = Array.isArray(c.provinces) ? c.provinces : [];
    if (provinces.length === 0) {
      coverageRows.push({ country: countryLabel, zone: "", countryCode: c.countryCode || "", provinceCode: "" });
    } else {
      for (const p of provinces) {
        const pCode = p?.code || "";
        const pName = p?.name || pCode;
        const zoneLabel = pCode && pName ? `${pName} (${pCode})` : pName || pCode;
        coverageRows.push({ country: countryLabel, zone: zoneLabel, countryCode: c.countryCode || "", provinceCode: pCode });
      }
    }
  }

  if (coverageRows.length === 0) {
    coverageRows.push({ country: "—", zone: "", countryCode: "", provinceCode: "" });
  }

  /* Non-range types: default rate + optional per-destination overrides */
  const defaultRate = (() => {
    switch (rule.logicType) {
      case "STANDARD_TIER":
        return parsedRules.flat_rate ?? "";
      case "WEIGHT_MULTIPLIER":
        return parsedRules.rate_per_kg ?? "";
      case "PRICE_MULTIPLIER":
        return parsedRules.percentage ?? "";
      case "ITEM_MULTIPLIER":
        return parsedRules.rate_per_item ?? "";
      default:
        return null;
    }
  })();

  const overrideByKey = new Map();
  if (!Array.isArray(parsedRules) && Array.isArray(parsedRules.overrides)) {
    for (const o of parsedRules.overrides) {
      overrideByKey.set(`${o.countryCode}::${o.province || ""}`, o.rate);
    }
  }

  /* Look up the rate that applies to this exact coverage row.
     Province match wins over country-level fallback. */
  const rateForCell = (cov) => {
    const cc = cov.countryCode || "";
    const pc = cov.provinceCode || "";
    if (cc && pc && overrideByKey.has(`${cc}::${pc}`)) {
      return overrideByKey.get(`${cc}::${pc}`);
    }
    if (cc && overrideByKey.has(`${cc}::`)) {
      return overrideByKey.get(`${cc}::`);
    }
    return defaultRate;
  };

  const isRange =
    rule.logicType === "WEIGHT_RANGE" || rule.logicType === "PRICE_RANGE";

  const rows = coverageRows.map((cov, i) => ({
    name: i === 0 ? rule.name : "",
    country: cov.country,
    zone: cov.zone,
    logic: i === 0 ? logicName : "",
    currency: i === 0 ? currency : "",
    min: "",
    max: "",
    rate: isRange ? "" : (rateForCell(cov) ?? ""),
  }));

  /* Range types: append one row per band after the coverage rows */
  if (isRange) {
    const bands = Array.isArray(parsedRules) ? parsedRules : [];
    const minKey = rule.logicType === "WEIGHT_RANGE" ? "min_kg" : "min_total";
    const maxKey = rule.logicType === "WEIGHT_RANGE" ? "max_kg" : "max_total";
    for (const b of bands) {
      rows.push({
        name: "",
        country: "",
        zone: "",
        logic: "",
        currency: "",
        min: b?.[minKey] ?? "",
        max: b?.[maxKey] ?? "",
        rate: b?.rate ?? "",
      });
    }
  }

  return rows;
}

export default function RulesOverview({
  zones,
  bulkRules = [],
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
  /* Spreadsheet-style rows for Bulk-Edit mode. Sort rules first so the
     leading row of each rule stays together with its coverage rows. */
  const bulkRows = useMemo(() => {
    if (!bulkMode) return [];

    let rules = [...bulkRules];

    if (filterType !== "ALL") {
      rules = rules.filter((r) => r.logicType === filterType);
    }
    if (sortOrder === "NAME_ASC")
      rules.sort((a, b) => a.name.localeCompare(b.name));
    if (sortOrder === "NAME_DESC")
      rules.sort((a, b) => b.name.localeCompare(a.name));

    let rows = rules.flatMap((r) => flattenBulkRule(r));

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      /* Keep entire rule groups whose any cell matches — searching by name
         shouldn't drop the rule's coverage rows. Group rows by their
         leading row (Name set) and filter as a group. */
      const groups = [];
      let current = null;
      for (const row of rows) {
        if (row.name) {
          current = { lead: row, rows: [row] };
          groups.push(current);
        } else if (current) {
          current.rows.push(row);
        }
      }
      rows = groups
        .filter((g) =>
          g.rows.some((r) =>
            [r.name, r.country, r.zone]
              .some((v) => String(v || "").toLowerCase().includes(q)),
          ),
        )
        .flatMap((g) => g.rows);
    }

    return rows;
  }, [bulkMode, bulkRules, searchQuery, filterType, sortOrder]);

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
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Name",
                    "Country",
                    "Zone",
                    "Pricing model",
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
                      <Badge key={`l-${i}`} tone="info">{String(r.logic)}</Badge>
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
