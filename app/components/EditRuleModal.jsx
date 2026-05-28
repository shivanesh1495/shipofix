/**
 * EditRuleModal — opens from the All rates table's Edit button.
 *
 * Hosts the full pricing-rule editor (model picker, currency, price fields)
 * plus a "Change countries" button. For zone-wise rules the button opens the
 * existing ZoneModal so the vendor can re-pick the country / province set.
 * For bulk (Excel) rules the button is hidden — coverage is owned by the
 * spreadsheet and the user is told to edit it there.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Divider,
  InlineStack,
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, EditIcon, PlusIcon } from "@shopify/polaris-icons";

const LOGIC_TYPES = [
  { label: "Flat rate — one price per order", value: "STANDARD_TIER" },
  { label: "Weight tiers — different price per weight band", value: "WEIGHT_RANGE" },
  { label: "Order-value tiers — different price per cart total", value: "PRICE_RANGE" },
  { label: "Per kilogram — multiply weight × rate", value: "WEIGHT_MULTIPLIER" },
  { label: "% of cart — charge a percentage of order value", value: "PRICE_MULTIPLIER" },
  { label: "Per item — multiply item count × rate", value: "ITEM_MULTIPLIER" },
];

const LOGIC_HELP = {
  STANDARD_TIER:
    "Same shipping price for every order to this zone, no matter what's in the cart.",
  WEIGHT_RANGE:
    "Set price bands by parcel weight. Example: 0–5 kg → 50, 5–10 kg → 80, 10 kg+ → 120.",
  PRICE_RANGE:
    "Set price bands by cart total. Useful for free-shipping thresholds (e.g. over 1,000 → 0).",
  WEIGHT_MULTIPLIER:
    "Cost scales with weight. A 3.5 kg cart at a rate of 20 charges 70.",
  PRICE_MULTIPLIER:
    "Cost is a percentage of the cart. Enter the percent as a decimal — 0.1 = 10%.",
  ITEM_MULTIPLIER:
    "Cost scales with how many items are in the cart. 4 items at a rate of 15 charges 60.",
};

/* Compact currency list — covers the common cases for the modal dropdown.
   Server-side validation still accepts the full ISO 4217 set so an unusual
   currency saved earlier (e.g. via the Excel upload) survives editing. */
const COMMON_CURRENCIES = [
  { code: "USD", label: "USD $" },
  { code: "EUR", label: "EUR €" },
  { code: "GBP", label: "GBP £" },
  { code: "INR", label: "INR ₹" },
  { code: "AUD", label: "AUD A$" },
  { code: "CAD", label: "CAD C$" },
  { code: "JPY", label: "JPY ¥" },
  { code: "CNY", label: "CNY ¥" },
  { code: "NZD", label: "NZD NZ$" },
  { code: "CHF", label: "CHF CHF" },
  { code: "SGD", label: "SGD S$" },
  { code: "HKD", label: "HKD HK$" },
  { code: "AED", label: "AED د.إ" },
  { code: "SAR", label: "SAR ر.س" },
  { code: "ZAR", label: "ZAR R" },
  { code: "MXN", label: "MXN Mex$" },
  { code: "BRL", label: "BRL R$" },
  { code: "SEK", label: "SEK kr" },
  { code: "NOK", label: "NOK kr" },
  { code: "DKK", label: "DKK kr" },
  { code: "PLN", label: "PLN zł" },
  { code: "TRY", label: "TRY ₺" },
  { code: "THB", label: "THB ฿" },
  { code: "MYR", label: "MYR RM" },
  { code: "PHP", label: "PHP ₱" },
  { code: "IDR", label: "IDR Rp" },
  { code: "KRW", label: "KRW ₩" },
  { code: "TWD", label: "TWD NT$" },
];

/* Make sure whatever currency is currently saved appears in the dropdown,
   even if it's not in the common list. Avoids the dropdown blanking out on
   open and then silently changing the saved value to USD on first save. */
function makeCurrencyOptions(currentCurrency) {
  const upper = String(currentCurrency || "USD").toUpperCase();
  if (COMMON_CURRENCIES.some((c) => c.code === upper)) {
    return COMMON_CURRENCIES.map((c) => ({ value: c.code, label: c.label }));
  }
  return [
    { value: upper, label: upper },
    ...COMMON_CURRENCIES.map((c) => ({ value: c.code, label: c.label })),
  ];
}

/* Read rule.rulesJson into the editor's local state shape. Range rules get
   an array of bands; non-range rules get a flat values map. */
function parseRuleState(rule) {
  let parsed = {};
  try {
    parsed = JSON.parse(rule?.rulesJson || "{}");
  } catch {
    parsed = {};
  }
  return parsed;
}

export default function EditRuleModal({
  open,
  rule,
  onClose,
  onSave,
  onChangeCountries,
  isSaving = false,
}) {
  const [logicType, setLogicType] = useState("STANDARD_TIER");
  const [currency, setCurrency] = useState("USD");
  const [name, setName] = useState("");
  const [rules, setRules] = useState({});
  const [error, setError] = useState(null);

  /* Reset editor state every time a different rule is opened. Without this,
     opening rule B after rule A would briefly render A's values. */
  useEffect(() => {
    if (!open || !rule) return;
    setName(rule.name || "");
    setCurrency(rule.currency || "USD");
    setLogicType(rule.logicType || "STANDARD_TIER");
    setRules(parseRuleState(rule));
    setError(null);
  }, [open, rule?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBulkRule = rule?.source === "bulk";

  const currencyOptions = useMemo(
    () => makeCurrencyOptions(currency),
    [currency],
  );

  /* Mirror of LogicEditor's save gating — keeps invalid input out of the DB
     and the carrier service. The server-side bulk-edit action also validates
     so this is purely UX. */
  const isInvalid = useMemo(() => {
    if (logicType === "DEFAULT") return false;
    const positiveNumber = (v) => {
      if (v === "" || v === null || v === undefined) return false;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0;
    };
    switch (logicType) {
      case "STANDARD_TIER":
        return !positiveNumber(rules.flat_rate);
      case "WEIGHT_MULTIPLIER":
        return !positiveNumber(rules.rate_per_kg);
      case "PRICE_MULTIPLIER":
        return !positiveNumber(rules.percentage);
      case "ITEM_MULTIPLIER":
        return !positiveNumber(rules.rate_per_item);
      case "WEIGHT_RANGE":
      case "PRICE_RANGE": {
        const isWeight = logicType === "WEIGHT_RANGE";
        const bands = Array.isArray(rules) ? rules : [];
        if (bands.length === 0) return true;
        return !bands.every((b) => {
          const minRaw = isWeight ? b.min_kg : b.min_total;
          const maxRaw = isWeight ? b.max_kg : b.max_total;
          if (!positiveNumber(b.rate)) return false;
          if (minRaw === "" || minRaw == null) return false;
          if (maxRaw === "" || maxRaw == null) return true;
          const minN = Number(minRaw);
          const maxN = Number(maxRaw);
          return Number.isFinite(minN) && Number.isFinite(maxN) && minN < maxN;
        });
      }
      default:
        return false;
    }
  }, [logicType, rules]);

  const handleSave = () => {
    if (!rule) return;
    if (isInvalid) {
      setError("Fill in the price fields above before saving.");
      return;
    }
    setError(null);
    onSave({ rule, name, currency, logicType, rules });
  };

  /* Render the logic-type-specific fields. Range types show a band editor
     (Min / Max / Rate rows); everything else shows a single rate field. */
  const renderFields = () => {
    switch (logicType) {
      case "STANDARD_TIER":
        return (
          <TextField
            label="Shipping price"
            type="number"
            min="0"
            value={rules.flat_rate ?? ""}
            onChange={(v) => setRules({ ...rules, flat_rate: v })}
            autoComplete="off"
            prefix={currency}
            helpText="Every order shipping to this zone pays this amount."
          />
        );

      case "WEIGHT_RANGE":
      case "PRICE_RANGE": {
        const isWeight = logicType === "WEIGHT_RANGE";
        const defaultBand = isWeight
          ? { min_kg: "", max_kg: null, rate: "" }
          : { min_total: "", max_total: null, rate: "" };
        const bands =
          Array.isArray(rules) && rules.length > 0 ? rules : [defaultBand];

        return (
          <BlockStack gap="300">
            {bands.map((band, i) => {
              const minVal = isWeight ? band.min_kg : band.min_total;
              const maxVal = isWeight ? band.max_kg : band.max_total;
              const minN = Number(minVal);
              const maxN = Number(maxVal);
              const overlap =
                minVal !== "" &&
                minVal != null &&
                maxVal !== "" &&
                maxVal != null &&
                Number.isFinite(minN) &&
                Number.isFinite(maxN) &&
                minN >= maxN;
              return (
                <BlockStack key={i} gap="100">
                  <InlineStack gap="200" blockAlign="end" wrap={false}>
                    <Box minWidth="100px">
                      <TextField
                        label={isWeight ? "From (kg)" : "From (cart total)"}
                        type="number"
                        min="0"
                        value={minVal ?? ""}
                        onChange={(v) => {
                          const next = [...bands];
                          if (isWeight) next[i].min_kg = v;
                          else next[i].min_total = v;
                          setRules(next);
                        }}
                        autoComplete="off"
                      />
                    </Box>
                    <Box minWidth="100px">
                      <TextField
                        label={isWeight ? "Up to (kg)" : "Up to (cart total)"}
                        type="number"
                        min="0"
                        value={maxVal ?? ""}
                        onChange={(v) => {
                          const next = [...bands];
                          if (isWeight) next[i].max_kg = v === "" ? null : v;
                          else next[i].max_total = v === "" ? null : v;
                          setRules(next);
                        }}
                        autoComplete="off"
                        placeholder="Leave blank for no limit"
                      />
                    </Box>
                    <Box minWidth="100px">
                      <TextField
                        label="Price"
                        type="number"
                        min="0"
                        value={band.rate ?? ""}
                        onChange={(v) => {
                          const next = [...bands];
                          next[i].rate = v;
                          setRules(next);
                        }}
                        autoComplete="off"
                        prefix={currency}
                      />
                    </Box>
                    <Button
                      icon={DeleteIcon}
                      tone="critical"
                      onClick={() => setRules(bands.filter((_, idx) => idx !== i))}
                      disabled={bands.length === 1}
                      accessibilityLabel="Remove band"
                    />
                  </InlineStack>
                  {overlap && (
                    <Text tone="critical" variant="bodySm">
                      &ldquo;From&rdquo; must be smaller than &ldquo;Up to&rdquo;.
                      Leave &ldquo;Up to&rdquo; blank on the top band to cover
                      everything above the previous range.
                    </Text>
                  )}
                </BlockStack>
              );
            })}
            <InlineStack align="start">
              <Button
                icon={PlusIcon}
                onClick={() =>
                  setRules([
                    ...bands,
                    isWeight
                      ? { min_kg: "", max_kg: null, rate: "" }
                      : { min_total: "", max_total: null, rate: "" },
                  ])
                }
              >
                Add another band
              </Button>
            </InlineStack>
          </BlockStack>
        );
      }

      case "WEIGHT_MULTIPLIER":
        return (
          <TextField
            label="Price per kilogram"
            type="number"
            min="0"
            value={rules.rate_per_kg ?? ""}
            onChange={(v) => setRules({ ...rules, rate_per_kg: v })}
            autoComplete="off"
            prefix={currency}
            helpText="We multiply the parcel's total weight by this number. A 3.5 kg cart at 20 charges 70."
          />
        );

      case "PRICE_MULTIPLIER": {
        const pctN = Number(rules.percentage);
        const pctSuspicious = Number.isFinite(pctN) && pctN > 1;
        return (
          <TextField
            label="Percentage of cart total (as a decimal)"
            type="number"
            min="0"
            step="0.01"
            value={rules.percentage ?? ""}
            onChange={(v) => setRules({ ...rules, percentage: v })}
            autoComplete="off"
            helpText={
              pctSuspicious
                ? `That's ${(pctN * 100).toFixed(0)}% of every order — if you wanted 10%, type 0.1 instead.`
                : "Type as a decimal: 0.1 = 10%, 0.05 = 5%."
            }
            error={pctSuspicious ? "Looks like a whole percent. Try 0.1 for 10%." : undefined}
          />
        );
      }

      case "ITEM_MULTIPLIER":
        return (
          <TextField
            label="Price per item"
            type="number"
            min="0"
            value={rules.rate_per_item ?? ""}
            onChange={(v) => setRules({ ...rules, rate_per_item: v })}
            autoComplete="off"
            prefix={currency}
            helpText="We multiply how many items are in the cart by this. 4 items at 15 charges 60."
          />
        );

      default:
        return null;
    }
  };

  if (!rule) return null;

  const countriesArr = (() => {
    try {
      return JSON.parse(rule.countries || "[]");
    } catch {
      return [];
    }
  })();

  const coverageSummary = (() => {
    if (countriesArr.length === 0) return "No countries selected";
    if (countriesArr.length === 1) {
      const c = countriesArr[0];
      if (c.restOfWorld) return "Rest of World";
      const provs = Array.isArray(c.provinces) ? c.provinces : [];
      const base = c.name ? `${c.name} (${c.countryCode})` : c.countryCode;
      return provs.length > 0
        ? `${base} · ${provs.length} zone${provs.length === 1 ? "" : "s"}`
        : `${base} · whole country`;
    }
    const first = countriesArr[0].restOfWorld
      ? "Rest of World"
      : `${countriesArr[0].name || countriesArr[0].countryCode}`;
    return `${first} · ${countriesArr.length} countries`;
  })();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule.name || "Edit rule"}
      primaryAction={{
        content: "Save shipping rate",
        onAction: handleSave,
        loading: isSaving,
        disabled: isSaving || isInvalid,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSaving },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {/* Header row — coverage summary + Change countries button. The
              button is hidden for bulk rules; their coverage is owned by
              the Excel template and the user is told to edit it there. */}
          <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
            <BlockStack gap="050">
              <Text variant="headingSm" as="h3">{rule.name}</Text>
              <Text tone="subdued" variant="bodySm">{coverageSummary}</Text>
            </BlockStack>
            <InlineStack gap="200" blockAlign="center">
              {isBulkRule && <Badge tone="info">From Excel upload</Badge>}
              <Button
                variant="plain"
                icon={EditIcon}
                onClick={() => onChangeCountries?.(rule)}
                disabled={isSaving}
              >
                Change countries
              </Button>
            </InlineStack>
          </InlineStack>

          {isBulkRule && (
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <Text variant="bodySm" tone="subdued">
                This rule came from the Excel template. You can change its
                countries here for a quick edit, but re-uploading the
                spreadsheet from the <b>Bulk edit (Excel)</b> tab will
                overwrite this coverage with whatever the file says.
              </Text>
            </Box>
          )}

          <Divider />

          {/* Rule name — vendors can rename a rule from this modal too. The
              server-side action validates non-empty. */}
          <TextField
            label="Rule name"
            value={name}
            onChange={setName}
            autoComplete="off"
            requiredIndicator
            error={!name.trim() ? "Name can't be empty" : undefined}
          />

          {/* Pricing model */}
          <Select
            label="How do you want to charge for this zone?"
            helpText="Choose Shopify default to hand pricing back to Shopify's built-in rates."
            options={[
              { label: "Shopify default (use Shopify's own rates)", value: "DEFAULT" },
              ...LOGIC_TYPES,
            ]}
            value={logicType}
            onChange={(v) => {
              setLogicType(v);
              /* Reset rules to a sensible default for the new logic so the
                 form doesn't carry stale fields from the previous model. */
              if (v === "WEIGHT_RANGE") setRules([{ min_kg: "", max_kg: null, rate: "" }]);
              else if (v === "PRICE_RANGE") setRules([{ min_total: "", max_total: null, rate: "" }]);
              else setRules({});
            }}
          />

          {logicType !== "DEFAULT" && LOGIC_HELP[logicType] && (
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <Text tone="subdued" variant="bodySm">{LOGIC_HELP[logicType]}</Text>
            </Box>
          )}

          {logicType !== "DEFAULT" && (
            <>
              {/* Currency picker */}
              <Box maxWidth="240px">
                <Select
                  label="Currency"
                  options={currencyOptions}
                  value={currency}
                  onChange={setCurrency}
                />
              </Box>

              {/* Logic-type-specific fields */}
              {renderFields()}
            </>
          )}

          {error && (
            <Box
              background="bg-surface-critical-subdued"
              padding="300"
              borderRadius="200"
            >
              <Text tone="critical" variant="bodySm">{error}</Text>
            </Box>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
