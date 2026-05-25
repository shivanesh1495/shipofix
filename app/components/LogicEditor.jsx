/**
 * LogicEditor — rule configuration form for the active zone.
 * Renders logic type selector, currency picker, and type-specific fields.
 */

import {
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  Icon,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  DeleteIcon,
  EditIcon,
  GlobeIcon,
  PlusIcon,
} from "@shopify/polaris-icons";

/* Vendor-facing labels for each pricing model. The value strings are the
   internal contract with the carrier service — don't change them. */
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

const ALL_CURRENCIES = [
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
  { code: "AFN", symbol: "؋", name: "Afghan Afghani" },
  { code: "ALL", symbol: "L", name: "Albanian Lek" },
  { code: "AMD", symbol: "֏", name: "Armenian Dram" },
  { code: "ANG", symbol: "ƒ", name: "Netherlands Antillean Guilder" },
  { code: "AOA", symbol: "Kz", name: "Angolan Kwanza" },
  { code: "ARS", symbol: "$", name: "Argentine Peso" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "AWG", symbol: "ƒ", name: "Aruban Florin" },
  { code: "AZN", symbol: "₼", name: "Azerbaijani Manat" },
  { code: "BAM", symbol: "KM", name: "Bosnia Mark" },
  { code: "BBD", symbol: "Bds$", name: "Barbadian Dollar" },
  { code: "BDT", symbol: "৳", name: "Bangladeshi Taka" },
  { code: "BGN", symbol: "лв", name: "Bulgarian Lev" },
  { code: "BHD", symbol: ".د.ب", name: "Bahraini Dinar" },
  { code: "BIF", symbol: "FBu", name: "Burundian Franc" },
  { code: "BMD", symbol: "$", name: "Bermudian Dollar" },
  { code: "BND", symbol: "B$", name: "Brunei Dollar" },
  { code: "BOB", symbol: "Bs.", name: "Bolivian Boliviano" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "BSD", symbol: "B$", name: "Bahamian Dollar" },
  { code: "BTN", symbol: "Nu.", name: "Bhutanese Ngultrum" },
  { code: "BWP", symbol: "P", name: "Botswana Pula" },
  { code: "BYN", symbol: "Br", name: "Belarusian Ruble" },
  { code: "BZD", symbol: "BZ$", name: "Belize Dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "CDF", symbol: "FC", name: "Congolese Franc" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc" },
  { code: "CLP", symbol: "$", name: "Chilean Peso" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "COP", symbol: "$", name: "Colombian Peso" },
  { code: "CRC", symbol: "₡", name: "Costa Rican Colón" },
  { code: "CUP", symbol: "₱", name: "Cuban Peso" },
  { code: "CVE", symbol: "$", name: "Cape Verdean Escudo" },
  { code: "CZK", symbol: "Kč", name: "Czech Koruna" },
  { code: "DJF", symbol: "Fdj", name: "Djiboutian Franc" },
  { code: "DKK", symbol: "kr", name: "Danish Krone" },
  { code: "DOP", symbol: "RD$", name: "Dominican Peso" },
  { code: "DZD", symbol: "د.ج", name: "Algerian Dinar" },
  { code: "EGP", symbol: "E£", name: "Egyptian Pound" },
  { code: "ERN", symbol: "Nfk", name: "Eritrean Nakfa" },
  { code: "ETB", symbol: "Br", name: "Ethiopian Birr" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "FJD", symbol: "FJ$", name: "Fijian Dollar" },
  { code: "FKP", symbol: "£", name: "Falkland Islands Pound" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "GEL", symbol: "₾", name: "Georgian Lari" },
  { code: "GHS", symbol: "GH₵", name: "Ghanaian Cedi" },
  { code: "GIP", symbol: "£", name: "Gibraltar Pound" },
  { code: "GMD", symbol: "D", name: "Gambian Dalasi" },
  { code: "GNF", symbol: "FG", name: "Guinean Franc" },
  { code: "GTQ", symbol: "Q", name: "Guatemalan Quetzal" },
  { code: "GYD", symbol: "G$", name: "Guyanese Dollar" },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar" },
  { code: "HNL", symbol: "L", name: "Honduran Lempira" },
  { code: "HRK", symbol: "kn", name: "Croatian Kuna" },
  { code: "HTG", symbol: "G", name: "Haitian Gourde" },
  { code: "HUF", symbol: "Ft", name: "Hungarian Forint" },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah" },
  { code: "ILS", symbol: "₪", name: "Israeli Shekel" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "IQD", symbol: "ع.د", name: "Iraqi Dinar" },
  { code: "IRR", symbol: "﷼", name: "Iranian Rial" },
  { code: "ISK", symbol: "kr", name: "Icelandic Króna" },
  { code: "JMD", symbol: "J$", name: "Jamaican Dollar" },
  { code: "JOD", symbol: "JD", name: "Jordanian Dinar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling" },
  { code: "KGS", symbol: "лв", name: "Kyrgystani Som" },
  { code: "KHR", symbol: "៛", name: "Cambodian Riel" },
  { code: "KMF", symbol: "CF", name: "Comorian Franc" },
  { code: "KRW", symbol: "₩", name: "South Korean Won" },
  { code: "KWD", symbol: "د.ك", name: "Kuwaiti Dinar" },
  { code: "KYD", symbol: "CI$", name: "Cayman Islands Dollar" },
  { code: "KZT", symbol: "₸", name: "Kazakhstani Tenge" },
  { code: "LAK", symbol: "₭", name: "Lao Kip" },
  { code: "LBP", symbol: "ل.ل", name: "Lebanese Pound" },
  { code: "LKR", symbol: "Rs", name: "Sri Lankan Rupee" },
  { code: "LRD", symbol: "L$", name: "Liberian Dollar" },
  { code: "LSL", symbol: "M", name: "Lesotho Loti" },
  { code: "LYD", symbol: "ل.د", name: "Libyan Dinar" },
  { code: "MAD", symbol: "د.م.", name: "Moroccan Dirham" },
  { code: "MDL", symbol: "L", name: "Moldovan Leu" },
  { code: "MGA", symbol: "Ar", name: "Malagasy Ariary" },
  { code: "MKD", symbol: "ден", name: "Macedonian Denar" },
  { code: "MMK", symbol: "K", name: "Myanmar Kyat" },
  { code: "MNT", symbol: "₮", name: "Mongolian Tugrik" },
  { code: "MOP", symbol: "MOP$", name: "Macanese Pataca" },
  { code: "MRU", symbol: "UM", name: "Mauritanian Ouguiya" },
  { code: "MUR", symbol: "₨", name: "Mauritian Rupee" },
  { code: "MVR", symbol: "Rf", name: "Maldivian Rufiyaa" },
  { code: "MWK", symbol: "MK", name: "Malawian Kwacha" },
  { code: "MXN", symbol: "Mex$", name: "Mexican Peso" },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit" },
  { code: "MZN", symbol: "MT", name: "Mozambican Metical" },
  { code: "NAD", symbol: "N$", name: "Namibian Dollar" },
  { code: "NGN", symbol: "₦", name: "Nigerian Naira" },
  { code: "NIO", symbol: "C$", name: "Nicaraguan Córdoba" },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone" },
  { code: "NPR", symbol: "रू", name: "Nepalese Rupee" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar" },
  { code: "OMR", symbol: "ر.ع.", name: "Omani Rial" },
  { code: "PAB", symbol: "B/.", name: "Panamanian Balboa" },
  { code: "PEN", symbol: "S/.", name: "Peruvian Sol" },
  { code: "PGK", symbol: "K", name: "Papua New Guinean Kina" },
  { code: "PHP", symbol: "₱", name: "Philippine Peso" },
  { code: "PKR", symbol: "₨", name: "Pakistani Rupee" },
  { code: "PLN", symbol: "zł", name: "Polish Zloty" },
  { code: "PYG", symbol: "₲", name: "Paraguayan Guaraní" },
  { code: "QAR", symbol: "ر.ق", name: "Qatari Riyal" },
  { code: "RON", symbol: "lei", name: "Romanian Leu" },
  { code: "RSD", symbol: "din.", name: "Serbian Dinar" },
  { code: "RUB", symbol: "₽", name: "Russian Ruble" },
  { code: "RWF", symbol: "RF", name: "Rwandan Franc" },
  { code: "SAR", symbol: "ر.س", name: "Saudi Riyal" },
  { code: "SBD", symbol: "SI$", name: "Solomon Islands Dollar" },
  { code: "SCR", symbol: "₨", name: "Seychellois Rupee" },
  { code: "SDG", symbol: "ج.س.", name: "Sudanese Pound" },
  { code: "SEK", symbol: "kr", name: "Swedish Krona" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "SHP", symbol: "£", name: "Saint Helena Pound" },
  { code: "SLE", symbol: "Le", name: "Sierra Leonean Leone" },
  { code: "SOS", symbol: "Sh", name: "Somali Shilling" },
  { code: "SRD", symbol: "$", name: "Surinamese Dollar" },
  { code: "SSP", symbol: "£", name: "South Sudanese Pound" },
  { code: "STN", symbol: "Db", name: "São Tomé Dobra" },
  { code: "SYP", symbol: "£S", name: "Syrian Pound" },
  { code: "SZL", symbol: "E", name: "Swazi Lilangeni" },
  { code: "THB", symbol: "฿", name: "Thai Baht" },
  { code: "TJS", symbol: "SM", name: "Tajikistani Somoni" },
  { code: "TMT", symbol: "T", name: "Turkmenistani Manat" },
  { code: "TND", symbol: "د.ت", name: "Tunisian Dinar" },
  { code: "TOP", symbol: "T$", name: "Tongan Paʻanga" },
  { code: "TRY", symbol: "₺", name: "Turkish Lira" },
  { code: "TTD", symbol: "TT$", name: "Trinidad Dollar" },
  { code: "TWD", symbol: "NT$", name: "New Taiwan Dollar" },
  { code: "TZS", symbol: "TSh", name: "Tanzanian Shilling" },
  { code: "UAH", symbol: "₴", name: "Ukrainian Hryvnia" },
  { code: "UGX", symbol: "USh", name: "Ugandan Shilling" },
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "UYU", symbol: "$U", name: "Uruguayan Peso" },
  { code: "UZS", symbol: "сўм", name: "Uzbekistani Som" },
  { code: "VES", symbol: "Bs.S", name: "Venezuelan Bolívar" },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong" },
  { code: "VUV", symbol: "VT", name: "Vanuatu Vatu" },
  { code: "WST", symbol: "WS$", name: "Samoan Tala" },
  { code: "XAF", symbol: "FCFA", name: "Central African CFA Franc" },
  { code: "XCD", symbol: "EC$", name: "East Caribbean Dollar" },
  { code: "XOF", symbol: "CFA", name: "West African CFA Franc" },
  { code: "XPF", symbol: "₣", name: "CFP Franc" },
  { code: "YER", symbol: "﷼", name: "Yemeni Rial" },
  { code: "ZAR", symbol: "R", name: "South African Rand" },
  { code: "ZMW", symbol: "ZK", name: "Zambian Kwacha" },
  { code: "ZWL", symbol: "Z$", name: "Zimbabwean Dollar" },
];

const CURRENCY_OPTIONS = ALL_CURRENCIES.map((c) => ({
  value: c.code,
  label: `${c.code} ${c.symbol} — ${c.name}`,
}));

export default function LogicEditor({
  activeZone,
  logicType,
  setLogicType,
  currency,
  setCurrency,
  rules,
  setRules,
  onSave,
  onDeleteRule,
  onEditRegions,
  onDeleteZone,
  onCreateZone,
  isSaving,
  disabled = false,
}) {
  if (!activeZone) {
    return (
      <Card>
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icon source={GlobeIcon} tone="info" />
          </div>
          <h3>Pick a zone to get started</h3>
          <p>
            A <b>zone</b> is a group of countries (or states / provinces) that
            share the same shipping price. Choose one on the left, or add a
            new one — then come back here to decide what to charge.
          </p>
          <Button
            variant="primary"
            onClick={onCreateZone}
            icon={PlusIcon}
            disabled={disabled}
          >
            Add a new zone
          </Button>
        </div>
      </Card>
    );
  }

  /* Client-side gating for Save Rule. Mirrors what the carrier service
     needs at runtime so vendors don't waste a round-trip on a save that
     would do nothing or charge zero. The Excel upload path has equivalent
     server-side checks; here we just short-circuit obvious gaps. */
  const isSaveDisabled = (() => {
    if (disabled || logicType === "DEFAULT") return false;
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
          const rateOk = positiveNumber(b.rate);
          if (!rateOk) return false;
          /* Max may be blank (= ∞) for the top band — that's allowed. */
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
  })();

  const renderLogicFields = () => {
    switch (logicType) {
      case "STANDARD_TIER":
        return (
          <TextField
            label="Shipping price"
            type="number"
            min="0"
            value={rules.flat_rate || ""}
            onChange={(v) => setRules({ ...rules, flat_rate: v })}
            autoComplete="off"
            prefix={currency}
            disabled={disabled}
            helpText="Every order shipping to this zone pays this amount."
          />
        );

      case "WEIGHT_RANGE":
      case "PRICE_RANGE": {
        const isWeight = logicType === "WEIGHT_RANGE";
        /* Build the default band with the SAME keys the runtime calculator
           reads — { min_kg, max_kg, rate } for weight and { min_total,
           max_total, rate } for price. Using neutral { min, max } here
           silently created bands the carrier service couldn't match (the
           rate fell through to 0 → accidental free shipping). */
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
              const minMaxInvalid =
                minVal !== "" &&
                minVal != null &&
                maxVal !== "" &&
                maxVal != null &&
                Number.isFinite(minN) &&
                Number.isFinite(maxN) &&
                minN >= maxN;
              return (
                <BlockStack key={i} gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Box minWidth="100px">
                      <TextField
                        label={isWeight ? "From (kg)" : "From (cart total)"}
                        type="number"
                        min="0"
                        value={minVal ?? ""}
                        onChange={(v) => {
                          const nb = [...bands];
                          if (isWeight) nb[i].min_kg = v;
                          else nb[i].min_total = v;
                          setRules(nb);
                        }}
                        autoComplete="off"
                        disabled={disabled}
                      />
                    </Box>
                    <Box minWidth="100px">
                      <TextField
                        label={isWeight ? "Up to (kg)" : "Up to (cart total)"}
                        type="number"
                        min="0"
                        value={maxVal ?? ""}
                        onChange={(v) => {
                          const nb = [...bands];
                          if (isWeight) nb[i].max_kg = v === "" ? null : v;
                          else nb[i].max_total = v === "" ? null : v;
                          setRules(nb);
                        }}
                        autoComplete="off"
                        placeholder="Leave blank for no limit"
                        disabled={disabled}
                      />
                    </Box>
                    <Box minWidth="100px">
                      <TextField
                        label="Price"
                        type="number"
                        min="0"
                        value={band.rate ?? ""}
                        onChange={(v) => {
                          const nb = [...bands];
                          nb[i].rate = v;
                          setRules(nb);
                        }}
                        autoComplete="off"
                        prefix={currency}
                        disabled={disabled}
                      />
                    </Box>
                    <Box paddingBlockStart="400">
                      <Button
                        icon={DeleteIcon}
                        tone="critical"
                        onClick={() =>
                          setRules(bands.filter((_, idx) => idx !== i))
                        }
                        disabled={disabled || bands.length === 1}
                        accessibilityLabel="Remove band"
                      />
                    </Box>
                  </InlineStack>
                  {minMaxInvalid && (
                    <Text tone="critical" variant="bodySm">
                      &ldquo;From&rdquo; must be smaller than &ldquo;Up to&rdquo;.
                      Leave &ldquo;Up to&rdquo; blank on your top band if you
                      want it to cover everything above the previous range.
                    </Text>
                  )}
                </BlockStack>
              );
            })}
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
              disabled={disabled}
            >
              Add another band
            </Button>
          </BlockStack>
        );
      }

      case "WEIGHT_MULTIPLIER":
        return (
          <TextField
            label="Price per kilogram"
            type="number"
            min="0"
            value={rules.rate_per_kg || ""}
            onChange={(v) => setRules({ ...rules, rate_per_kg: v })}
            autoComplete="off"
            prefix={currency}
            disabled={disabled}
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
            value={rules.percentage || ""}
            onChange={(v) => setRules({ ...rules, percentage: v })}
            autoComplete="off"
            disabled={disabled}
            helpText={
              pctSuspicious
                ? `That's ${(pctN * 100).toFixed(0)}% of every order — if you wanted 10%, type 0.1 instead.`
                : "Type as a decimal: 0.1 = 10%, 0.05 = 5%. We multiply the cart subtotal by this."
            }
            error={pctSuspicious ? "Looks like you typed a whole percent. Try 0.1 for 10%." : undefined}
          />
        );
      }

      case "ITEM_MULTIPLIER":
        return (
          <TextField
            label="Price per item"
            type="number"
            min="0"
            value={rules.rate_per_item || ""}
            onChange={(v) => setRules({ ...rules, rate_per_item: v })}
            autoComplete="off"
            prefix={currency}
            helpText="We multiply how many items are in the cart by this. 4 items at 15 charges 60."
            disabled={disabled}
          />
        );

      default:
        return null;
    }
  };

  return (
    <Card>
      <BlockStack gap="400">
        {/* Editor Header */}
        <div className="editor-header">
          <div>
            <div className="editor-title">{activeZone.name}</div>
            <div className="brand-subtitle" style={{ marginTop: "2px" }}>
              {activeZone.isDomestic ? "Inside your home country" : "International"} ·{" "}
              {activeZone.countries.length}{" "}
              {activeZone.countries.length === 1 ? "country" : "countries"}
            </div>
          </div>
          <div className="editor-actions">
            <Button
              variant="plain"
              icon={EditIcon}
              onClick={() => onEditRegions(activeZone)}
              disabled={disabled}
            >
              Change countries
            </Button>
            <Button
              variant="plain"
              tone="critical"
              icon={DeleteIcon}
              onClick={() => onDeleteZone(activeZone.id)}
              disabled={disabled}
            >
              Delete zone
            </Button>
          </div>
        </div>

        {/* Countries Strip */}
        <div className="countries-strip">
          {activeZone.countries.length > 0 ? (
            activeZone.countries.map((c) => (
              <span key={c.countryCode} className="country-chip">
                {c.name || c.countryCode}
              </span>
            ))
          ) : (
            <Text tone="subdued" variant="bodySm">
              No countries in this zone yet — click &ldquo;Change countries&rdquo; to add some.
            </Text>
          )}
        </div>

        <Divider />

        {/* Logic Type Selector */}
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
            if (v === "DEFAULT" && activeZone.rule) {
              onDeleteRule(activeZone.rule.id);
            }
          }}
          disabled={disabled}
        />

        {logicType !== "DEFAULT" && LOGIC_HELP[logicType] && (
          <Box
            padding="300"
            background="bg-surface-secondary"
            borderRadius="200"
          >
            <Text tone="subdued" variant="bodySm">
              {LOGIC_HELP[logicType]}
            </Text>
          </Box>
        )}

        {logicType !== "DEFAULT" && (
          <BlockStack gap="400">
            <InlineStack gap="400">
              <Box minWidth="240px">
                <Select
                  label="Currency"
                  options={CURRENCY_OPTIONS}
                  value={currency}
                  onChange={setCurrency}
                  disabled={disabled}
                />
              </Box>
            </InlineStack>
            <div className="logic-box">{renderLogicFields()}</div>
            <InlineStack align="end" gap="200" blockAlign="center">
              {isSaveDisabled && !isSaving && (
                <Text tone="subdued" variant="bodySm">
                  Fill in the price fields above before saving.
                </Text>
              )}
              <Button
                variant="primary"
                onClick={onSave}
                loading={isSaving}
                disabled={disabled || isSaveDisabled}
              >
                Save shipping rate
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
