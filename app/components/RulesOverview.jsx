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
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon, SearchIcon } from "@shopify/polaris-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

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

/* Summary label for the Country column: "United States (US)", or
   "United States (US) +2 more" when the zone covers multiple countries. */
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
    /* ruleId tagged on the leading row only so the Edit button can identify
       the rule without us having to keep a parallel index. */
    ruleId: i === 0 ? rule.id : null,
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
        ruleId: null,
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

/* Pull the editable rate / bands out of a BulkEditRule into the shape the
   inline edit modal works with. Non-range rules get a single `rate` field;
   range rules get an array of {min, max, rate} bands. */
function ruleToEditState(rule) {
  let parsed = {};
  try { parsed = JSON.parse(rule.rulesJson || "{}"); } catch { parsed = {}; }
  const isRange =
    rule.logicType === "WEIGHT_RANGE" || rule.logicType === "PRICE_RANGE";
  if (isRange) {
    const arr = Array.isArray(parsed) ? parsed : [];
    const minKey = rule.logicType === "WEIGHT_RANGE" ? "min_kg" : "min_total";
    const maxKey = rule.logicType === "WEIGHT_RANGE" ? "max_kg" : "max_total";
    const bands = arr.map((b) => ({
      min: b?.[minKey] != null ? String(b[minKey]) : "",
      max: b?.[maxKey] != null ? String(b[maxKey]) : "",
      rate: b?.rate != null ? String(b.rate) : "",
    }));
    return { isRange: true, bands: bands.length ? bands : [{ min: "", max: "", rate: "" }] };
  }
  const rateField =
    rule.logicType === "STANDARD_TIER"     ? "flat_rate"
    : rule.logicType === "WEIGHT_MULTIPLIER" ? "rate_per_kg"
    : rule.logicType === "PRICE_MULTIPLIER"  ? "percentage"
    : rule.logicType === "ITEM_MULTIPLIER"   ? "rate_per_item"
    : null;
  const rate = rateField && parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed[rateField]
    : null;
  return { isRange: false, rate: rate != null ? String(rate) : "" };
}

/* Client-side mirror of the server's ISO 4217 list. Used to enable the
   Save button only when the currency is one a vendor can actually ship in.
   Keeping it shorter than the full server list keeps the dropdown usable —
   uncommon currencies still pass server-side validation. */
const COMMON_CURRENCIES = [
  "USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY", "INR", "NZD", "CHF",
  "AED", "ARS", "BDT", "BRL", "CLP", "COP", "CZK", "DKK", "EGP", "HKD",
  "HUF", "IDR", "ILS", "ISK", "KRW", "KWD", "LKR", "MAD", "MXN", "MYR",
  "NGN", "NOK", "OMR", "PEN", "PHP", "PKR", "PLN", "QAR", "RON", "RUB",
  "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "UAH", "VND", "ZAR",
];
const COMMON_CURRENCY_SET = new Set(COMMON_CURRENCIES);

/* Short label used as the rate field's label in the edit modal. */
function rateLabelFor(logicType) {
  switch (logicType) {
    case "STANDARD_TIER":     return "Flat rate";
    case "WEIGHT_MULTIPLIER": return "Rate per kg";
    case "PRICE_MULTIPLIER":  return "Decimal fraction (0.1 = 10%)";
    case "ITEM_MULTIPLIER":   return "Rate per item";
    default:                   return "Rate";
  }
}

function rateUnitFor(logicType) {
  if (logicType === "WEIGHT_RANGE") return "kg";
  if (logicType === "PRICE_RANGE") return "cart total";
  return "";
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
  onBulkRuleEdited,
  disabled = false,
  bulkMode = false,
}) {
  /* ── Inline edit modal state ─────────────────────────────────────────── */
  const editFetcher = useFetcher();
  /* Carries the optimistic patch from submit-time to success-effect-time so
     the parent's setter sees the right rule id even after the form state
     in this component has been reset by closeEdit. */
  const pendingPatchRef = useRef(null);
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editCurrency, setEditCurrency] = useState("USD");
  const [editRate, setEditRate] = useState("");
  const [editBands, setEditBands] = useState([{ min: "", max: "", rate: "" }]);
  const [editError, setEditError] = useState(null);

  const editingRule = useMemo(
    () => bulkRules.find((r) => r.id === editingRuleId) || null,
    [bulkRules, editingRuleId],
  );
  const editingIsRange =
    editingRule &&
    (editingRule.logicType === "WEIGHT_RANGE" ||
      editingRule.logicType === "PRICE_RANGE");

  const openEdit = useCallback((ruleId) => {
    const rule = bulkRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const state = ruleToEditState(rule);
    setEditingRuleId(ruleId);
    setEditName(rule.name || "");
    setEditCurrency(rule.currency || "USD");
    setEditError(null);
    if (state.isRange) {
      setEditBands(state.bands);
      setEditRate("");
    } else {
      setEditRate(state.rate);
      setEditBands([{ min: "", max: "", rate: "" }]);
    }
  }, [bulkRules]);

  const closeEdit = useCallback(() => {
    setEditingRuleId(null);
    setEditError(null);
  }, []);

  const updateBand = useCallback((idx, key, value) => {
    setEditBands((prev) => prev.map((b, i) => (i === idx ? { ...b, [key]: value } : b)));
  }, []);
  const addBand = useCallback(() => {
    setEditBands((prev) => [...prev, { min: "", max: "", rate: "" }]);
  }, []);
  const removeBand = useCallback((idx) => {
    setEditBands((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingRule) return;
    setEditError(null);

    const trimmedName = editName.trim();
    if (!trimmedName) { setEditError("Name can't be empty."); return; }
    const cur = (editCurrency || "USD").trim().toUpperCase();

    let rulesPayload;
    if (editingIsRange) {
      if (editBands.length === 0) {
        setEditError("Add at least one band."); return;
      }
      const minKey = editingRule.logicType === "WEIGHT_RANGE" ? "min_kg" : "min_total";
      const maxKey = editingRule.logicType === "WEIGHT_RANGE" ? "max_kg" : "max_total";
      const out = [];
      for (let i = 0; i < editBands.length; i++) {
        const b = editBands[i];
        const minRaw = String(b.min ?? "").trim();
        const maxRaw = String(b.max ?? "").trim();
        const rateRaw = String(b.rate ?? "").trim();
        if (rateRaw === "") { setEditError(`Band ${i + 1}: rate is required.`); return; }
        const minN = minRaw === "" ? null : Number(minRaw);
        const maxN = maxRaw === "" ? null : Number(maxRaw);
        const rateN = Number(rateRaw);
        if (!Number.isFinite(rateN) || rateN < 0) {
          setEditError(`Band ${i + 1}: rate must be a non-negative number.`); return;
        }
        if (minRaw !== "" && (!Number.isFinite(minN) || minN < 0)) {
          setEditError(`Band ${i + 1}: min must be a non-negative number.`); return;
        }
        if (maxRaw !== "" && (!Number.isFinite(maxN) || maxN < 0)) {
          setEditError(`Band ${i + 1}: max must be a non-negative number.`); return;
        }
        if (minN !== null && maxN !== null && minN >= maxN) {
          setEditError(`Band ${i + 1}: min must be less than max.`); return;
        }
        const entry = { [minKey]: minN ?? 0, rate: rateN };
        if (maxN !== null) entry[maxKey] = maxN;
        out.push(entry);
      }
      rulesPayload = JSON.stringify(out);
    } else {
      const rateRaw = String(editRate ?? "").trim();
      if (rateRaw === "") { setEditError("Rate is required."); return; }
      const rateN = Number(rateRaw);
      if (!Number.isFinite(rateN) || rateN < 0) {
        setEditError("Rate must be a non-negative number."); return;
      }
      const rateField =
        editingRule.logicType === "STANDARD_TIER"     ? "flat_rate"
        : editingRule.logicType === "WEIGHT_MULTIPLIER" ? "rate_per_kg"
        : editingRule.logicType === "PRICE_MULTIPLIER"  ? "percentage"
        : editingRule.logicType === "ITEM_MULTIPLIER"   ? "rate_per_item"
        : null;
      if (!rateField) {
        setEditError("Unsupported pricing model for inline edit."); return;
      }
      /* Preserve existing per-destination overrides so the optimistic patch
         matches what the server will write back. Without this, real and
         ovr rulesJson diverge for rules with overrides and the parity-drop
         in the parent never fires — leaving the optimistic state hanging
         around and masking the loader's canonical view. */
      const payload = { [rateField]: rateN };
      let prior = {};
      try { prior = JSON.parse(editingRule.rulesJson || "{}"); } catch { prior = {}; }
      if (Array.isArray(prior.overrides) && prior.overrides.length > 0) {
        payload.overrides = prior.overrides;
      }
      rulesPayload = JSON.stringify(payload);
    }

    /* Stash the optimistic patch keyed by rule id so the table can re-render
       with the new values immediately on success — no waiting for the
       loader to revalidate. */
    const optimisticPatch = {
      name: trimmedName,
      currency: cur,
      rulesJson: rulesPayload,
    };
    const body = new FormData();
    body.set("intent", "edit_rule");
    body.set("id", editingRule.id);
    body.set("name", trimmedName);
    body.set("currency", cur);
    body.set("rulesJson", rulesPayload);
    body.set("_optimisticRuleId", editingRule.id);
    /* Remember the patch on the ref so the success effect can apply it
       without having to re-derive it from form state (which may have
       reset by then). */
    pendingPatchRef.current = { id: editingRule.id, patch: optimisticPatch };
    editFetcher.submit(body, { method: "POST", action: "/app/bulk-edit" });
  }, [editingRule, editingIsRange, editName, editCurrency, editRate, editBands, editFetcher]);

  /* Track the data ref we've already reacted to so a stale {success: true}
     from a previous save doesn't trigger anything on later renders. */
  const [lastHandledEdit, setLastHandledEdit] = useState(null);

  /* On success: hand the optimistic patch up to the parent (which holds
     the state so it survives tab switches), pop a toast, close the modal.
     The parent also triggers loader revalidation. */
  useEffect(() => {
    if (editFetcher.state !== "idle") return;
    if (!editFetcher.data || editFetcher.data === lastHandledEdit) return;
    setLastHandledEdit(editFetcher.data);
    if (editFetcher.data.success) {
      const pending = pendingPatchRef.current;
      if (pending && onBulkRuleEdited) {
        onBulkRuleEdited(pending.id, pending.patch);
      }
      pendingPatchRef.current = null;
      if (typeof window !== "undefined" && window.shopify?.toast?.show) {
        window.shopify.toast.show(editFetcher.data.message || "Rule updated");
      }
      closeEdit();
    } else if (editFetcher.data.error) {
      pendingPatchRef.current = null;
      setEditError(editFetcher.data.error);
    }
  }, [editFetcher.state, editFetcher.data, lastHandledEdit, closeEdit, onBulkRuleEdited]);

  const saving = editFetcher.state === "submitting" || editFetcher.state === "loading";
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
                    "text",
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
                    "Actions",
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
                    /* Edit button lives in its own Actions column so the
                       Name column stays narrow and Country / Zone / values
                       line up cleanly across rule and coverage rows. Only
                       the leading row of each rule shows it. */
                    r.ruleId ? (
                      <Button
                        key={`e-${i}`}
                        size="micro"
                        variant="primary"
                        tone="success"
                        onClick={() => openEdit(r.ruleId)}
                        disabled={saving}
                      >
                        Edit
                      </Button>
                    ) : (
                      ""
                    ),
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

      {/* ── Inline edit modal ─────────────────────────────────────────────
          Lets the vendor tweak the rate / bands / currency / name of one
          bulk rule without leaving the Rules Overview tab. Coverage and
          logic type are read-only here — structural changes still go via
          download → edit in Excel → re-upload. */}
      <Modal
        open={!!editingRule}
        onClose={closeEdit}
        title={editingRule ? `Edit "${editingRule.name}"` : "Edit rule"}
        primaryAction={{
          content: "Save",
          onAction: handleSaveEdit,
          loading: saving,
          /* Block Save while invalid — empty Name or unknown currency code.
             Server validates again so this is just UX guidance. */
          disabled:
            saving ||
            !editName.trim() ||
            !COMMON_CURRENCY_SET.has((editCurrency || "").trim().toUpperCase()),
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeEdit, disabled: saving }]}
      >
        {editingRule && (
          <Modal.Section>
            <BlockStack gap="400">
              {editError && (
                <Box
                  background="bg-surface-critical-subdued"
                  padding="300"
                  borderRadius="200"
                >
                  <Text tone="critical">{editError}</Text>
                </Box>
              )}

              <Text tone="subdued" variant="bodySm">
                Pricing model:{" "}
                <b>
                  {LOGIC_SHORT_NAME[editingRule.logicType] || editingRule.logicType}
                </b>
                . To change the pricing model or which countries this rule
                covers, download the spreadsheet from the Bulk edit tab.
              </Text>

              <TextField
                label="Name"
                value={editName}
                onChange={setEditName}
                autoComplete="off"
                requiredIndicator
                error={
                  editName.trim() === ""
                    ? "Name can't be empty"
                    : undefined
                }
              />

              <TextField
                label="Currency"
                value={editCurrency}
                onChange={(v) => setEditCurrency(v.toUpperCase())}
                autoComplete="off"
                maxLength={3}
                requiredIndicator
                helpText="ISO 3-letter code (e.g. USD, EUR, GBP, AUD, CAD, JPY)."
                error={
                  !COMMON_CURRENCY_SET.has(
                    (editCurrency || "").trim().toUpperCase(),
                  )
                    ? `"${editCurrency}" isn't a recognised currency code`
                    : undefined
                }
              />

              {editingIsRange ? (
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h3">
                    Bands ({rateUnitFor(editingRule.logicType)})
                  </Text>
                  <Text tone="subdued" variant="bodySm">
                    Leave <b>Max</b> blank on the top band for an open-ended
                    range. Bands shouldn&apos;t overlap.
                  </Text>
                  {editBands.map((b, idx) => (
                    <InlineStack key={idx} gap="200" blockAlign="end" wrap={false}>
                      <Box minWidth="100px">
                        <TextField
                          label={idx === 0 ? "Min" : ""}
                          labelHidden={idx !== 0}
                          value={b.min}
                          onChange={(v) => updateBand(idx, "min", v)}
                          type="number"
                          min="0"
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="100px">
                        <TextField
                          label={idx === 0 ? "Max" : ""}
                          labelHidden={idx !== 0}
                          value={b.max}
                          onChange={(v) => updateBand(idx, "max", v)}
                          type="number"
                          min="0"
                          placeholder="∞"
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="100px">
                        <TextField
                          label={idx === 0 ? "Rate" : ""}
                          labelHidden={idx !== 0}
                          value={b.rate}
                          onChange={(v) => updateBand(idx, "rate", v)}
                          type="number"
                          min="0"
                          autoComplete="off"
                        />
                      </Box>
                      <Button
                        icon={DeleteIcon}
                        accessibilityLabel={`Remove band ${idx + 1}`}
                        onClick={() => removeBand(idx)}
                        disabled={editBands.length <= 1 || saving}
                      />
                    </InlineStack>
                  ))}
                  <InlineStack align="start">
                    <Button icon={PlusIcon} onClick={addBand} disabled={saving}>
                      Add band
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : (
                <TextField
                  label={rateLabelFor(editingRule.logicType)}
                  value={editRate}
                  onChange={setEditRate}
                  type="number"
                  min="0"
                  autoComplete="off"
                  helpText={
                    editingRule.logicType === "PRICE_MULTIPLIER"
                      ? "Type the percent as a decimal — 0.1 means 10%."
                      : `Charged in ${editCurrency || "USD"}.`
                  }
                />
              )}
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    </Box>
  );
}
