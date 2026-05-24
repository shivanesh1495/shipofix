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
  { num: 1, label: "Standard Flat Tier", hint: "Fill Rate column on Bulk Edit. One row per zone." },
  { num: 2, label: "Weight Based (Category)", hint: "Use the Rate Bands sheet — one row per slab." },
  { num: 3, label: "Price Based (Category)", hint: "Use the Rate Bands sheet — Min/Max on cart total." },
  { num: 4, label: "Per KG Dynamic", hint: "Fill Rate column with rate per kg." },
  { num: 5, label: "Per Price Dynamic", hint: "Fill Rate column with decimal % (0.1 = 10%)." },
  { num: 6, label: "Per Item Dynamic", hint: "Fill Rate column with rate per item." },
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
          {/* ── How the workbook is structured ── */}
          <BlockStack gap="200">
            <Text variant="headingMd" as="h3">
              Workbook structure
            </Text>
            <Text tone="subdued">
              The template ships with four sheets. You only edit the first two.
            </Text>
            <div className="bulk-docs-sheet-grid">
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">Bulk Edit</div>
                <div className="bulk-docs-sheet-body">
                  Coverage + logic. Type a rule <b>Name</b> on every Country /
                  Zone row the rule applies to. Set <b>Logic #</b> and{" "}
                  <b>Currency</b> on the first row of each rule.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">Rate Bands</div>
                <div className="bulk-docs-sheet-body">
                  Slabs for category logic (Logic 2 & 3). One row per band, all
                  sharing the same rule <b>Name</b>. Leave <b>Max</b> blank on
                  the top band for an open-ended range.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">All Regions</div>
                <div className="bulk-docs-sheet-body">
                  Read-only reference of every country and its states /
                  provinces. Same list powers the dropdowns on Bulk Edit.
                </div>
              </div>
              <div className="bulk-docs-sheet">
                <div className="bulk-docs-sheet-title">Instructions</div>
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
                Logic # (1-6). Use 0 to reset that rule to Shopify Default,
                blank to leave the existing rule alone.
              </li>
              <li>
                <b>Set Currency once</b> on that same first row. Defaults to INR
                if blank.
              </li>
              <li>
                <b>Add the rate.</b>
                <ul>
                  <li>
                    Logic <b>1, 4, 5, 6</b> — put the value in the Rate column
                    on the Bulk Edit sheet.
                  </li>
                  <li>
                    Logic <b>2, 3</b> — switch to the <b>Rate Bands</b> sheet
                    and add one row per slab (Name, Min, Max, Rate). Order
                    doesn&apos;t matter; the carrier picks the matching band.
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

          {/* ── Worked example for category logic ── */}
          <BlockStack gap="200">
            <Text variant="headingMd" as="h3">
              Example · Weight Based with 3 slabs covering Australia
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
          </BlockStack>

          <Divider />

          {/* ── Edge cases ── */}
          <BlockStack gap="200">
            <Text variant="headingMd" as="h3">
              Edge cases &amp; rules
            </Text>
            <ul className="bulk-docs-edges">
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
                <b>Bands assigned to a Logic 1 / 4 / 5 / 6 rule</b> → only the
                first rate value is used as the rule&apos;s rate; Min/Max are
                ignored.
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

          {/* ── Logic # reference ── */}
          <BlockStack gap="200">
            <Text variant="headingMd" as="h3">
              Logic # reference
            </Text>
            <Text tone="subdued">
              Each rule&apos;s shipping behaviour is set with a single number in
              the Logic # column. Leave it blank to keep the existing rule
              unchanged. Set it to <b>0</b> to reset to Shopify Default.
            </Text>
            <div className="bulk-logic-grid">
              {LOGIC_REFERENCE.map((l) => (
                <div key={l.num} className="bulk-logic-row">
                  <span className="bulk-logic-num">{l.num}</span>
                  <div>
                    <div className="bulk-logic-label">{l.label}</div>
                    <div className="bulk-logic-hint">{l.hint}</div>
                  </div>
                </div>
              ))}
            </div>
          </BlockStack>

          <Divider />

          {/* ── Country & zone code reference ── */}
          <BlockStack gap="300">
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
