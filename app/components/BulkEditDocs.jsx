/**
 * BulkEditDocs — full how-to-use guide for the Excel-based Bulk Edit flow.
 *
 * Opens as a Polaris Modal from the Bulk Edit panel. Holds the Logic #
 * reference + Country & zone code reference that used to live inline on
 * the panel, plus a step-by-step walkthrough of the new Rate Bands sheet.
 */

import { useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Divider,
  Icon,
  InlineStack,
  Modal,
  Scrollable,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import ALL_COUNTRIES from "../lib/locations.json";

const LOGIC_REFERENCE = [
  {
    num: 1,
    label: "Standard Flat Tier",
    rateSource: "Bulk Edit · Rate",
    unit: "Flat amount",
    example: "Rate = 99 → every order pays 99",
    use: "Single flat charge per zone, regardless of cart contents.",
  },
  {
    num: 2,
    label: "Weight Based (Category)",
    rateSource: "Rate Bands sheet",
    unit: "Bands by total weight (kg)",
    example: "0–5 kg → 50, 5–10 kg → 80, 10+ kg → 120",
    use: "Tiered pricing by parcel weight. Carrier picks the band the order falls into.",
  },
  {
    num: 3,
    label: "Price Based (Category)",
    rateSource: "Rate Bands sheet",
    unit: "Bands by cart subtotal",
    example: "0–999 → 99, 1000–4999 → 49, 5000+ → 0 (free)",
    use: "Tiered pricing by cart value — common for free-shipping thresholds.",
  },
  {
    num: 4,
    label: "Per KG Dynamic",
    rateSource: "Bulk Edit · Rate",
    unit: "Currency per kg",
    example: "Rate = 20 · 3.5 kg cart → 70",
    use: "Charge proportional to total parcel weight.",
  },
  {
    num: 5,
    label: "Per Price Dynamic",
    rateSource: "Bulk Edit · Rate",
    unit: "Decimal fraction of subtotal",
    example: "Rate = 0.1 · 800 cart → 80 (10%)",
    use: "Charge a fixed percentage of the cart subtotal.",
  },
  {
    num: 6,
    label: "Per Item Dynamic",
    rateSource: "Bulk Edit · Rate",
    unit: "Currency per item",
    example: "Rate = 15 · 4 items → 60",
    use: "Charge proportional to item count.",
  },
  {
    num: 7,
    label: "Weight Tiered Per-KG",
    rateSource: "Rate Bands sheet",
    unit: "Per-kg rate, banded by weight (kg)",
    example: "0–5 → 20/kg · 5–10 → 15/kg · 7 kg cart → 7 × 15 = 105",
    use: "Different per-kg rate inside each weight band. Combines weight tiers with a per-kg multiplier.",
  },
];

const BULK_EDIT_COLUMNS = [
  {
    col: "Name",
    required: "Always",
    body: "Free-form rule name. Rows sharing the same Name merge into one rule — coverage is the union of those rows.",
  },
  {
    col: "Country",
    required: "Always",
    body: "Pick from the dropdown (ISO code shown in parentheses). Use Rest of World to catch everything your other rules miss.",
  },
  {
    col: "Zone",
    required: "Always",
    body: "State / province for the chosen country, or the country-wide entry. Dropdown is pre-filtered.",
  },
  {
    col: "Logic #",
    required: "First row of each rule",
    body: "1–7 picks the pricing model. 0 resets the rule to Shopify Default. Blank leaves the existing rule untouched.",
  },
  {
    col: "Currency",
    required: "First row of each rule",
    body: "ISO 4217 code (USD, EUR, GBP, …). Defaults to USD if blank.",
  },
  {
    col: "Rate",
    required: "Logic 1, 4, 5, 6",
    body: "Numeric rate in the chosen currency. Leave blank for Logic 2, 3 & 7 — those rules read from Rate Bands.",
  },
];

const RATE_BANDS_COLUMNS = [
  {
    col: "Name",
    required: "Always",
    body: "Must match a rule Name on the Bulk Edit sheet exactly (case-sensitive).",
  },
  {
    col: "Min",
    required: "Always",
    body: "Lower bound (inclusive). Blank is treated as 0.",
  },
  {
    col: "Max",
    required: "Optional",
    body: "Upper bound. Blank on the top band = open-ended (∞).",
  },
  {
    col: "Rate",
    required: "Always",
    body: "Logic 2 & 3: flat amount charged when an order falls in this band. Logic 7: per-kg rate inside this band (final charge = cart weight × this rate). Blank rows are dropped.",
  },
];

const TOC_SECTIONS = [
  { id: "structure", label: "Workbook structure" },
  { id: "steps", label: "Filling the template" },
  { id: "columns", label: "Column reference" },
  { id: "logic", label: "Logic # reference" },
  { id: "example", label: "Worked example" },
  { id: "edges", label: "Edge cases & rules" },
  { id: "codes", label: "Country & zone codes" },
];

const SORTED_COUNTRIES = [...ALL_COUNTRIES].sort((a, b) =>
  a.name.localeCompare(b.name),
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, tokens) {
  const s = String(text ?? "");
  if (!tokens.length || !s) return s;
  const re = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
  const parts = s.split(re);
  return parts.map((p, i) => {
    if (!p) return null;
    return tokens.includes(p.toLowerCase()) ? (
      <mark key={i} className="bulk-codes-mark">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    );
  });
}

export default function BulkEditDocs({ open, onClose }) {
  const [codesSearch, setCodesSearch] = useState("");

  const searchTokens = useMemo(
    () => codesSearch.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [codesSearch],
  );

  const filteredCountries = useMemo(() => {
    if (!searchTokens.length) return SORTED_COUNTRIES;
    return SORTED_COUNTRIES.filter((c) =>
      searchTokens.every((tok) => {
        if (c.name.toLowerCase().includes(tok)) return true;
        if (c.code.toLowerCase().includes(tok)) return true;
        return (c.provinces || []).some(
          (p) =>
            p.name.toLowerCase().includes(tok) ||
            p.code.toLowerCase().includes(tok),
        );
      }),
    );
  }, [searchTokens]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk Edit · Excel template guide"
      size="large"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      <Modal.Section>
        <BlockStack gap="500">
          {/* ── Quick jump TOC ── */}
          <div className="bulk-docs-toc">
            <div className="bulk-docs-toc-label">On this page</div>
            <div className="bulk-docs-toc-links">
              {TOC_SECTIONS.map((s) => (
                <a key={s.id} href={`#bulk-docs-${s.id}`} className="bulk-docs-toc-link">
                  {s.label}
                </a>
              ))}
            </div>
          </div>

          {/* ── How the workbook is structured ── */}
          <BlockStack gap="200">
            <div id="bulk-docs-structure" />
            <Text variant="headingMd" as="h3">
              Workbook structure
            </Text>
            <Text tone="subdued">
              The template ships with four sheets. You only edit the first two.
            </Text>
            <div className="bulk-docs-sheet-grid">
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">
                  Bulk Edit
                  <span className="bulk-docs-sheet-tag bulk-docs-sheet-tag--edit">Edit</span>
                </div>
                <div className="bulk-docs-sheet-body">
                  Coverage + logic. Type a rule <b>Name</b> on every Country /
                  Zone row the rule applies to. Set <b>Logic #</b> and{" "}
                  <b>Currency</b> on the first row of each rule.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">
                  Rate Bands
                  <span className="bulk-docs-sheet-tag bulk-docs-sheet-tag--edit">Edit (Logic 2, 3 &amp; 7)</span>
                </div>
                <div className="bulk-docs-sheet-body">
                  Slabs for category logic. One row per band, all sharing the
                  same rule <b>Name</b>. Leave <b>Max</b> blank on the top
                  band for an open-ended range.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">
                  All Regions
                  <span className="bulk-docs-sheet-tag">Reference</span>
                </div>
                <div className="bulk-docs-sheet-body">
                  Read-only reference of every country and its states /
                  provinces. Same list powers the dropdowns on Bulk Edit.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">
                  Instructions
                  <span className="bulk-docs-sheet-tag">Reference</span>
                </div>
                <div className="bulk-docs-sheet-body">
                  Quick-reference copy of this guide, including worked
                  examples for each logic type.
                </div>
              </div>
            </div>
          </BlockStack>

          <Divider />

          {/* ── Step-by-step ── */}
          <BlockStack gap="200">
            <div id="bulk-docs-steps" />
            <Text variant="headingMd" as="h3">
              Filling the template
            </Text>
            <ol className="bulk-docs-steps">
              <li>
                <b>Decide the rule&apos;s coverage.</b> On the Bulk Edit sheet,
                find each Country / Zone row the rule should apply to and type
                the rule&apos;s Name in column A. Rows sharing the same Name
                merge into a single rule — coverage is the union of those rows.
              </li>
              <li>
                <b>Pick a Logic #.</b> On the <i>first</i> row of each rule, set
                Logic # (1–7). Use 0 to reset that rule to Shopify Default,
                blank to leave the existing rule alone.
              </li>
              <li>
                <b>Set Currency once</b> on that same first row. Defaults to USD
                if blank.
              </li>
              <li>
                <b>Add the rate.</b>
                <ul>
                  <li>
                    Logic <b>1, 4, 5, 6</b> — put the value in the Rate column
                    on the Bulk Edit sheet. Leave the Rate column blank for
                    Logic 2, 3 &amp; 7 rules.
                  </li>
                  <li>
                    Logic <b>2, 3, 7</b> — switch to the <b>Rate Bands</b>{" "}
                    sheet and add one row per slab (Name, Min, Max, Rate).{" "}
                    <b>Required:</b> upload is rejected if a Logic 2 / 3 / 7
                    rule has no Rate Bands rows. Order doesn&apos;t matter; the
                    carrier picks the matching band. For Logic 7 the Rate
                    column is a <i>per-kg</i> rate (final charge = cart weight
                    × the matching band&apos;s rate).
                  </li>
                </ul>
              </li>
              <li>
                <b>Save and upload.</b> The upload replaces every existing
                bulk-edit rule for the shop — rules you left out are reset to
                Shopify Default. Your zone-wise rules in Configuration Logic
                are not touched.
              </li>
            </ol>
          </BlockStack>

          <Divider />

          {/* ── Column reference ── */}
          <BlockStack gap="300">
            <div id="bulk-docs-columns" />
            <Text variant="headingMd" as="h3">
              Column reference
            </Text>
            <Text tone="subdued">
              What each column does on the two editable sheets.
            </Text>

            <BlockStack gap="100">
              <Text fontWeight="semibold" variant="bodySm">
                Bulk Edit sheet
              </Text>
              <div className="bulk-docs-table-wrap">
                <table className="bulk-docs-table bulk-docs-table--cols">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Required</th>
                      <th>What to put in it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BULK_EDIT_COLUMNS.map((c) => (
                      <tr key={c.col}>
                        <td><b>{c.col}</b></td>
                        <td className="bulk-docs-muted">{c.required}</td>
                        <td>{c.body}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>

            <BlockStack gap="100">
              <Text fontWeight="semibold" variant="bodySm">
                Rate Bands sheet
              </Text>
              <div className="bulk-docs-table-wrap">
                <table className="bulk-docs-table bulk-docs-table--cols">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Required</th>
                      <th>What to put in it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RATE_BANDS_COLUMNS.map((c) => (
                      <tr key={c.col}>
                        <td><b>{c.col}</b></td>
                        <td className="bulk-docs-muted">{c.required}</td>
                        <td>{c.body}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </BlockStack>

          <Divider />

          {/* ── Logic # reference (expanded table) ── */}
          <BlockStack gap="300">
            <div id="bulk-docs-logic" />
            <Text variant="headingMd" as="h3">
              Logic # reference
            </Text>
            <Text tone="subdued">
              Each rule&apos;s pricing model is set with a single number in the{" "}
              <b>Logic #</b> column. Leave it blank to keep the existing rule
              unchanged. Set it to <b>0</b> to reset to Shopify Default.
            </Text>
            <div className="bulk-docs-table-wrap">
              <table className="bulk-docs-table bulk-docs-table--logic">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Logic</th>
                    <th>Where the rate lives</th>
                    <th>Unit</th>
                    <th>Example</th>
                    <th>Use when…</th>
                  </tr>
                </thead>
                <tbody>
                  {LOGIC_REFERENCE.map((l) => (
                    <tr key={l.num}>
                      <td>
                        <span className="bulk-logic-num">{l.num}</span>
                      </td>
                      <td><b>{l.label}</b></td>
                      <td>{l.rateSource}</td>
                      <td>{l.unit}</td>
                      <td className="bulk-docs-example">{l.example}</td>
                      <td>{l.use}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </BlockStack>

          <Divider />

          {/* ── Worked example for category logic ── */}
          <BlockStack gap="200">
            <div id="bulk-docs-example" />
            <Text variant="headingMd" as="h3">
              Worked example · Weight Based with 3 slabs covering Australia
            </Text>
            <Text tone="subdued">
              Coverage on the Bulk Edit sheet, slabs on the Rate Bands sheet —
              both tied together by the rule Name.
            </Text>

            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <Text fontWeight="semibold" variant="bodySm">
                  Bulk Edit sheet
                </Text>
                <div className="bulk-docs-table-wrap">
                  <table className="bulk-docs-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Country</th>
                        <th>Zone</th>
                        <th>Logic #</th>
                        <th>Currency</th>
                        <th>Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Weight AU</td>
                        <td>Australia (AU)</td>
                        <td>Australian Capital Territory (ACT)</td>
                        <td>2</td>
                        <td>AUD</td>
                        <td className="bulk-docs-muted">—</td>
                      </tr>
                      <tr>
                        <td>Weight AU</td>
                        <td>Australia (AU)</td>
                        <td>New South Wales (NSW)</td>
                        <td className="bulk-docs-muted">—</td>
                        <td className="bulk-docs-muted">—</td>
                        <td className="bulk-docs-muted">—</td>
                      </tr>
                      <tr>
                        <td>Weight AU</td>
                        <td>Australia (AU)</td>
                        <td>Queensland (QLD)</td>
                        <td className="bulk-docs-muted">—</td>
                        <td className="bulk-docs-muted">—</td>
                        <td className="bulk-docs-muted">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Box>

            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <Text fontWeight="semibold" variant="bodySm">
                  Rate Bands sheet
                </Text>
                <div className="bulk-docs-table-wrap">
                  <table className="bulk-docs-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Min</th>
                        <th>Max</th>
                        <th>Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Weight AU</td>
                        <td>0</td>
                        <td>5</td>
                        <td>50</td>
                      </tr>
                      <tr>
                        <td>Weight AU</td>
                        <td>5</td>
                        <td>10</td>
                        <td>80</td>
                      </tr>
                      <tr>
                        <td>Weight AU</td>
                        <td>10</td>
                        <td className="bulk-docs-muted">(blank = ∞)</td>
                        <td>120</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Box>

            <Text variant="headingMd" as="h3">
              Worked example · Weight Tiered Per-KG (Logic 7)
            </Text>
            <Text tone="subdued">
              Same shape as Logic 2, but the Rate column on Rate Bands is a{" "}
              <i>per-kg</i> rate. Final charge = cart weight × the matching
              band&apos;s rate. A 7 kg cart with the bands below lands in the
              5–10 band: <b>7 × 15 = 105</b>.
            </Text>

            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <Text fontWeight="semibold" variant="bodySm">
                  Bulk Edit sheet
                </Text>
                <div className="bulk-docs-table-wrap">
                  <table className="bulk-docs-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Country</th>
                        <th>Zone</th>
                        <th>Logic #</th>
                        <th>Currency</th>
                        <th>Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Tiered AU</td>
                        <td>Australia (AU)</td>
                        <td>Australian Capital Territory (ACT)</td>
                        <td>7</td>
                        <td>AUD</td>
                        <td className="bulk-docs-muted">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Box>

            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <Text fontWeight="semibold" variant="bodySm">
                  Rate Bands sheet (Rate column is per-kg)
                </Text>
                <div className="bulk-docs-table-wrap">
                  <table className="bulk-docs-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Min</th>
                        <th>Max</th>
                        <th>Rate (per kg)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Tiered AU</td>
                        <td>0</td>
                        <td>5</td>
                        <td>20</td>
                      </tr>
                      <tr>
                        <td>Tiered AU</td>
                        <td>5</td>
                        <td>10</td>
                        <td>15</td>
                      </tr>
                      <tr>
                        <td>Tiered AU</td>
                        <td>10</td>
                        <td className="bulk-docs-muted">(blank = ∞)</td>
                        <td>10</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Box>
          </BlockStack>

          <Divider />

          {/* ── Edge cases ── */}
          <BlockStack gap="200">
            <div id="bulk-docs-edges" />
            <Text variant="headingMd" as="h3">
              Edge cases &amp; rules
            </Text>
            <ul className="bulk-docs-edges">
              <li>
                <b>Logic 2 / 3 / 7 with no Rate Bands rows</b> → upload is{" "}
                <b>rejected</b> with a row-level error naming the rule. Add at
                least one row on the Rate Bands sheet with the same Name.
              </li>
              <li>
                <b>Logic 1 / 4 / 5 / 6 with no Rate on Bulk Edit</b> → upload is
                rejected for that rule. Fill the Rate column on the rule&apos;s
                first row.
              </li>
              <li>
                <b>Blank Min</b> on a Rate Bands row → treated as 0.
              </li>
              <li>
                <b>Blank Max</b> on a Rate Bands row → open-ended (catches
                everything above Min).
              </li>
              <li>
                <b>Blank Rate</b> on a Rate Bands row → that band is dropped.
              </li>
              <li>
                <b>Name mismatch</b> between Bulk Edit and Rate Bands (typo,
                different case) → the bands are ignored. Names are
                case-sensitive.
              </li>
              <li>
                <b>Rate Bands rows for a Logic 1 / 4 / 5 / 6 rule</b> → upload
                is rejected. Those rules read the rate from the Bulk Edit Rate
                column only — remove the Rate Bands rows or change Logic # to
                2 / 3 / 7.
              </li>
              <li>
                <b>No coverage for a rule</b> (Name appears on Rate Bands but
                nowhere on Bulk Edit) → upload reports a row issue and skips
                the rule.
              </li>
              <li>
                <b>Rest of World</b> is a valid Country value — pick it from the
                dropdown to target every country your other rules don&apos;t
                cover.
              </li>
            </ul>
          </BlockStack>

          <Divider />

          {/* ── Country & zone code reference ── */}
          <BlockStack gap="300">
            <div id="bulk-docs-codes" />
            <InlineStack
              align="space-between"
              blockAlign="center"
              wrap={false}
            >
              <BlockStack gap="050">
                <Text variant="headingMd" as="h3">
                  Country &amp; zone code reference
                </Text>
                <Text tone="subdued">
                  Same list pre-filled in the Country and Zone dropdowns —
                  shown here with ISO codes for quick lookup.
                </Text>
              </BlockStack>
              <Badge>
                {`${filteredCountries.length} of ${SORTED_COUNTRIES.length} countries`}
              </Badge>
            </InlineStack>

            <TextField
              label="Search countries or zones"
              labelHidden
              value={codesSearch}
              onChange={setCodesSearch}
              prefix={<Icon source={SearchIcon} />}
              placeholder="Search by country or zone name / code…"
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setCodesSearch("")}
            />

            <Scrollable style={{ maxHeight: "320px" }} shadow>
              <div className="bulk-codes-list">
                {filteredCountries.map((c) => (
                  <div key={c.code} className="bulk-codes-country">
                    <div className="bulk-codes-country-head">
                      <span className="bulk-codes-country-name">
                        {highlight(c.name, searchTokens)}
                      </span>
                      <span className="bulk-codes-country-code">
                        {highlight(c.code, searchTokens)}
                      </span>
                      {c.provinces && c.provinces.length > 0 && (
                        <span className="bulk-codes-country-count">
                          {c.provinces.length} zones
                        </span>
                      )}
                    </div>
                    {c.provinces && c.provinces.length > 0 && (
                      <div className="bulk-codes-province-grid">
                        {c.provinces.map((p) => (
                          <span key={p.code} className="bulk-codes-chip">
                            <span className="bulk-codes-chip-name">
                              {highlight(p.name, searchTokens)}
                            </span>
                            <span className="bulk-codes-chip-code">
                              {highlight(p.code, searchTokens)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {filteredCountries.length === 0 && (
                  <div className="bulk-codes-empty">
                    <Text tone="subdued" variant="bodySm">
                      No countries or zones match &quot;{codesSearch}&quot;.
                    </Text>
                  </div>
                )}
              </div>
            </Scrollable>
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
