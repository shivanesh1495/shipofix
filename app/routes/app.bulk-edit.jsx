/* eslint-env node */
/**
 * Bulk Edit resource route.
 *
 * GET  /app/bulk-edit?intent=template   → download .xlsx template
 * POST /app/bulk-edit                   → upload filled .xlsx, upsert BulkEditRule rows
 *
 * Excel semantics:
 *   - Name column = rule name (free-form, vendor's choice).
 *   - Rows sharing the same Name belong to ONE rule.
 *   - Country/Zone cells across those rows = the rule's coverage (union).
 *     Empty Zone = whole country. "Rest of World" = catch-all.
 *   - Logic #, Currency, and the rate value(s) are taken from the rule's
 *     filled rows (first non-blank wins for Logic / Currency).
 */

import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { QUERY_DELIVERY_ZONES } from "../lib/graphql.js";
import ALL_COUNTRIES from "../lib/locations.json";

const LOGIC_BY_NUMBER = {
  1: "STANDARD_TIER",
  2: "WEIGHT_RANGE",
  3: "PRICE_RANGE",
  4: "WEIGHT_MULTIPLIER",
  5: "PRICE_MULTIPLIER",
  6: "ITEM_MULTIPLIER",
};

const LOGIC_LABELS = {
  STANDARD_TIER: "Standard Flat Tier",
  WEIGHT_RANGE: "Weight Based (Category)",
  PRICE_RANGE: "Price Based (Category)",
  WEIGHT_MULTIPLIER: "Per KG Dynamic",
  PRICE_MULTIPLIER: "Per Price Dynamic",
  ITEM_MULTIPLIER: "Per Item Dynamic",
};

const TEMPLATE_HEADERS = [
  "Name",
  "Country",
  "Zone",
  "Logic #",
  "Currency",
  "Rate",
];

const BANDS_HEADERS = ["Name", "Min", "Max", "Rate"];

const COL_COUNT = TEMPLATE_HEADERS.length;
const EMPTY_ROW = () => Array(COL_COUNT).fill("");

const INSTRUCTIONS_ROWS = [
  ["Shipofix · Bulk Edit Template"],
  [],
  ["Workflow in one minute"],
  ["1. Coverage  → on the 'Bulk Edit' sheet, mark which countries / zones a rule covers by typing the rule Name in column A."],
  ["2. Logic     → on that same first row of the rule, set Logic # and Currency."],
  ["3. Rate      → for Logic 1, 4, 5, 6 put the rate in the Rate column on the Bulk Edit sheet."],
  ["               for Logic 2 & 3 (category slabs) the rate lives on the dedicated 'Rate Bands' sheet — one row per band, same Name."],
  ["4. Save the file and upload it back into the Bulk Edit panel."],
  [],
  ["'Bulk Edit' sheet columns"],
  ["• Name      — free-form rule name. Rows sharing a Name merge into ONE rule (coverage = union of their Country / Zone)."],
  ["• Country   — country this row applies to (dropdown; pre-filled reference)."],
  ["• Zone      — state / province / division (dropdown; blank = whole country)."],
  ["• Logic #   — 1-6 picks the rate model, 0 = reset to Shopify Default, blank = no change."],
  ["• Currency  — ISO code (e.g. INR, USD). Defaults to INR if blank."],
  ["• Rate      — Logic 1 (flat) / 4 (per kg) / 5 (decimal %, e.g. 0.1) / 6 (per item). LEAVE BLANK for Logic 2 & 3 — those rates come from the Rate Bands sheet."],
  [],
  ["'Rate Bands' sheet — REQUIRED for Logic 2 & 3"],
  ["• Each row is ONE band of a rule. Logic 2 & 3 rules with no rows on this sheet will be REJECTED on upload."],
  ["• Name   — must match the rule Name used on the Bulk Edit sheet (case-sensitive)."],
  ["• Min    — lower bound of the band. Leave blank to mean 0."],
  ["• Max    — upper bound. Leave blank for the open-ended top band (= ∞)."],
  ["• Rate   — flat amount charged when the cart falls inside this band."],
  ["• Add as many rows as you need per rule. Order doesn't matter — the carrier picks the matching band by Min ≤ value < Max."],
  ["• Logic 2 reads the cart's total weight in kg. Logic 3 reads the cart total in the rule's currency."],
  ["• Edge cases: rows without a Rate are dropped. Bands assigned to a Name that has no Logic 2 / 3 rule on Bulk Edit are ignored."],
  [],
  ["Examples"],
  ["Logic 1 (Flat) — single row on Bulk Edit, Rate filled:"],
  ["", "Express AU", "Australia (AU)", "", 1, "AUD", 25],
  [],
  ["Logic 2 (Weight bands) — coverage on Bulk Edit (Rate blank) + bands on Rate Bands sheet:"],
  ["Bulk Edit row:"],
  ["", "Weight AU", "Australia (AU)", "", 2, "AUD", ""],
  ["Rate Bands rows for the same Name:"],
  ["", "Name", "Min", "Max", "Rate"],
  ["", "Weight AU", 0, 5, 50],
  ["", "Weight AU", 5, 10, 80],
  ["", "Weight AU", 10, "", 120],
  [],
  ["Logic # reference"],
  ["#", "Logic Type", "Where to put the rate", "Notes"],
  [1, "Standard Flat Tier", "Bulk Edit · Rate column", "One row per zone."],
  [2, "Weight Based (Category)", "Rate Bands sheet (one row per slab)", "Min / Max are kg. Required — error if no rows."],
  [3, "Price Based (Category)", "Rate Bands sheet (one row per slab)", "Min / Max are cart total. Required — error if no rows."],
  [4, "Per KG Dynamic", "Bulk Edit · Rate column", "Rate per kg."],
  [5, "Per Price Dynamic", "Bulk Edit · Rate column", "Decimal fraction (0.1 = 10%)."],
  [6, "Per Item Dynamic", "Bulk Edit · Rate column", "Rate per item."],
  [],
  ["Notes"],
  ["• Uploading replaces every existing bulk-edit rule for the shop — rules you leave out are reset to Shopify Default."],
  ["• Bulk Edit never creates or deletes Shopify zones — manage zones from the dashboard."],
  ["• Zone-wise rules (Configuration Logic tab) are untouched and resume the moment Bulk Edit is turned off."],
  ["• The All Regions sheet lists every country and its states / provinces for reference."],
];

/* Parse helpers for the Country / Zone cells the vendor types or picks
   from the dropdown. Tolerates "India (IN)", "IN", or "Rest of World". */
function parseCountryCell(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^rest of world$/i.test(s)) return { restOfWorld: true };
  const paren = s.match(/\(([A-Za-z0-9]{2,})\)\s*$/);
  if (paren) {
    return {
      restOfWorld: false,
      countryCode: paren[1].toUpperCase(),
      name: s.replace(/\s*\([A-Za-z0-9]{2,}\)\s*$/, "").trim(),
    };
  }
  if (/^[A-Za-z]{2}$/.test(s)) {
    return { restOfWorld: false, countryCode: s.toUpperCase(), name: s.toUpperCase() };
  }
  return null;
}

function parseProvinceCell(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const paren = s.match(/\(([A-Za-z0-9-]+)\)\s*$/);
  if (paren) {
    return {
      code: paren[1].toUpperCase(),
      name: s.replace(/\s*\([A-Za-z0-9-]+\)\s*$/, "").trim(),
    };
  }
  return { code: s.toUpperCase(), name: s };
}

/* Detect band overlaps and gaps within a single rule's bands. Returns a
   list of plain-English issue strings — used as upload warnings (not hard
   errors), since overlapping bands still work but pick whichever band the
   carrier hits first, and gaps leave certain cart ranges uncovered. */
function describeBandIssues(bands, unit) {
  const norm = bands
    .map((b) => ({
      min: b.min == null ? 0 : Number(b.min),
      max: b.max == null ? Infinity : Number(b.max),
    }))
    .sort((a, b) => a.min - b.min);
  const fmt = (v) => (v === Infinity ? "∞" : v);
  const issues = [];
  for (let i = 0; i < norm.length - 1; i++) {
    const a = norm[i];
    const b = norm[i + 1];
    if (a.max > b.min) {
      issues.push(
        `bands ${a.min}-${fmt(a.max)} ${unit} and ${b.min}-${fmt(b.max)} ${unit} overlap — checkout will use whichever band the cart hits first.`,
      );
    } else if (a.max < b.min) {
      issues.push(
        `gap between ${fmt(a.max)} ${unit} and ${b.min} ${unit} — carts inside that range will get no rate.`,
      );
    }
  }
  return issues;
}

/* Synthetic delivery-zone GID for bulk rules. Stable per rule name so
   re-uploading the same name updates the same row instead of duplicating. */
function ruleNameToGid(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `bulk:${slug || "unnamed"}`;
}

/* Shape the in-memory coverage map into the same JSON the carrier service
   already knows how to read (parseZoneCoverage in shipping.utils.js). */
function coverageToCountriesArray(g) {
  const arr = [];
  for (const [cc, entry] of g.coverage.entries()) {
    arr.push({
      countryCode: cc,
      name: entry.name,
      restOfWorld: false,
      provinces: entry.fullCountry
        ? []
        : Array.from(entry.provincesByCode.entries()).map(([code, name]) => ({
            code,
            name,
          })),
    });
  }
  if (g.hasRestOfWorld) {
    arr.push({
      countryCode: "",
      name: "Rest of World",
      restOfWorld: true,
      provinces: [],
    });
  }
  return arr;
}

/* Format helpers — embed the ISO codes inline so vendors see them while editing */
function fmtCountryLabel(country) {
  return country.code ? `${country.name} (${country.code})` : country.name;
}

function fmtProvinceLabel(p) {
  if (p.code && p.name) return `${p.name} (${p.code})`;
  return p.name || p.code || "";
}

/* Build the data rows for the Bulk Edit sheet — one row per country, or
   one row per (country × province) for countries with provinces.
   Country and Zone columns are pre-filled as reference; Name and the rule
   columns are blank for the vendor to fill in. */
function buildAllRegionRows(sortedCountries) {
  const rows = [];
  /* COL_COUNT cells per row: Name, Country, Zone, Logic #, Currency, Rate. */
  for (const country of sortedCountries) {
    const countryLabel = fmtCountryLabel(country);
    if (!country.provinces || country.provinces.length === 0) {
      rows.push(["", countryLabel, "", "", "", ""]);
    } else {
      for (const p of country.provinces) {
        rows.push(["", countryLabel, fmtProvinceLabel(p), "", "", ""]);
      }
    }
  }
  /* Rest of World row so vendors can target it explicitly */
  rows.push(["", "Rest of World", "", "", "", ""]);
  return rows;
}

/* ── Loader: template / last-upload download ────────────────────────── */

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent");

  /* Download the most recent file the vendor uploaded for this shop, exactly
     as it was uploaded. Lets them tweak a row and re-upload without having to
     regenerate the template from scratch. */
  if (intent === "last") {
    const { session } = await authenticate.admin(request);
    if (!prisma.bulkEditUpload) {
      return new Response("Storage not initialised", { status: 503 });
    }
    const last = await prisma.bulkEditUpload.findUnique({
      where: { shop: session.shop },
    });
    if (!last) return new Response("No previous upload", { status: 404 });
    return new Response(last.data, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${last.filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (intent !== "template") {
    return new Response("Not found", { status: 404 });
  }

  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  /* Fetch live zones from Shopify */
  const zoneRes = await admin.graphql(QUERY_DELIVERY_ZONES);
  const zoneJson = await zoneRes.json();
  const profiles = zoneJson?.data?.deliveryProfiles?.edges || [];

  const zoneMap = new Map();
  profiles.forEach(({ node: profile }) => {
    profile.profileLocationGroups.forEach((group) => {
      group.locationGroupZones.edges.forEach(({ node: zoneNode }) => {
        const z = zoneNode.zone;
        if (zoneMap.has(z.id)) return;
        zoneMap.set(z.id, {
          id: z.id,
          name: z.name,
          countriesDetailed: z.countries.map((c) => ({
            countryCode: c.code.countryCode,
            restOfWorld: !!c.code.restOfWorld,
            name: c.name,
            provinces: (c.provinces || []).map((p) => ({
              code: p.code,
              name: p.name,
            })),
          })),
        });
      });
    });
  });

  const sortedCountries = [...ALL_COUNTRIES].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  /* Build Bulk Edit sheet rows from the full official country/province list
     (NOT from the shop's configured zones). Country and Zone are pre-filled
     as reference; Name and the rule columns are blank for the vendor. */
  const zoneRows = [TEMPLATE_HEADERS, ...buildAllRegionRows(sortedCountries)];
  /* Trailing blanks for extra band rows */
  for (let i = 0; i < 10; i++) {
    zoneRows.push(EMPTY_ROW());
  }

  /* Build the workbook with ExcelJS so we can attach data validations
     (Name, Country, Zone, Logic # dropdowns). */
  const wb = new ExcelJS.Workbook();

  /* Sheet 1: Bulk Edit */
  const wsZones = wb.addWorksheet("Bulk Edit", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsZones.columns = [
    { width: 24 }, // Name
    { width: 26 }, // Country
    { width: 28 }, // Zone (province)
    { width: 9 },  // Logic #
    { width: 10 }, // Currency
    { width: 14 }, // Rate
  ];
  zoneRows.forEach((r) => wsZones.addRow(r));

  /* Header styling shared by both editable sheets */
  const headerStyle = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF111827" },
    },
    alignment: { vertical: "middle", horizontal: "left" },
  };
  wsZones.getRow(1).eachCell((cell) => {
    cell.font = headerStyle.font;
    cell.fill = headerStyle.fill;
    cell.alignment = headerStyle.alignment;
  });
  wsZones.getRow(1).height = 22;
  /* Header tooltips — hover the header cell for inline help. Keeps the docs
     reachable without leaving Excel. */
  wsZones.getCell("A1").note =
    "Rule name (free-form). Rows sharing a Name merge into ONE rule; coverage is the union of their Country/Zone cells. Names are case-sensitive and must match exactly on the Rate Bands sheet.";
  wsZones.getCell("B1").note =
    "Country this row applies to. Pick from the dropdown. 'Rest of World' targets every country your other rules don't cover.";
  wsZones.getCell("C1").note =
    "State / province / division (optional). Pick from the dropdown, or leave blank to apply to the whole country.";
  wsZones.getCell("D1").note =
    "1 = Standard Flat Tier · 2 = Weight Based (use Rate Bands) · 3 = Price Based (use Rate Bands) · 4 = Per KG · 5 = Per Price (decimal %, e.g. 0.1) · 6 = Per Item. 0 = reset to Shopify Default. Blank = keep existing rule.";
  wsZones.getCell("E1").note =
    "ISO currency code (e.g. INR, USD, AUD). Defaults to INR if blank. Set once on the rule's first row.";
  wsZones.getCell("F1").note =
    "Rate amount for Logic 1, 4, 5, 6. LEAVE BLANK for Logic 2 & 3 — those rates come from the Rate Bands sheet.";

  /* Conditional formatting: when Logic # is 2 or 3 on the same row, paint the
     Rate cell pink so vendors immediately see they shouldn't fill it. */
  const lastDataRow = wsZones.rowCount;
  wsZones.addConditionalFormatting({
    ref: `F2:F${lastDataRow}`,
    rules: [
      {
        type: "expression",
        formulae: ["OR($D2=2,$D2=3)"],
        priority: 1,
        style: {
          fill: {
            type: "pattern",
            pattern: "solid",
            bgColor: { argb: "FFFFE5E5" },
          },
          font: { color: { argb: "FFB91C1C" } },
        },
      },
    ],
  });

  /* Sheet 2: Rate Bands — dedicated sheet for Logic 2 / 3 slabs.
     Keeping bands out of the Bulk Edit coverage sheet lets vendors see all
     bands for a rule together and adds rows freely without juggling
     pre-filled country rows. Bands are linked to a rule by Name. */
  const wsBands = wb.addWorksheet("Rate Bands", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsBands.columns = [
    { width: 26 }, // Name
    { width: 14 }, // Min
    { width: 14 }, // Max
    { width: 14 }, // Rate
  ];
  wsBands.addRow(BANDS_HEADERS);
  wsBands.getRow(1).eachCell((cell) => {
    cell.font = headerStyle.font;
    cell.fill = headerStyle.fill;
    cell.alignment = headerStyle.alignment;
  });
  wsBands.getRow(1).height = 22;
  /* Header tooltips for Rate Bands. The Name note explicitly calls out the
     case-sensitive match against the Bulk Edit sheet — easy to miss. */
  wsBands.getCell("A1").note =
    "Must EXACTLY match a Name on the Bulk Edit sheet (case-sensitive). Orphan names — bands whose Name doesn't appear on Bulk Edit — are rejected on upload.";
  wsBands.getCell("B1").note =
    "Lower bound of this band. Leave blank to mean 0. For Logic 2 this is kg; for Logic 3 it's cart total in the rule's currency.";
  wsBands.getCell("C1").note =
    "Upper bound of this band. Leave BLANK on the top band for the open-ended range (= ∞). Must be greater than Min.";
  wsBands.getCell("D1").note =
    "Flat amount charged when the cart falls inside this band.";
  /* 100 blank rows so vendors can paste large band sets without resizing */
  for (let i = 0; i < 100; i++) {
    wsBands.addRow(["", "", "", ""]);
  }
  /* Numeric validation on Min / Max / Rate — friendly warning, not a hard
     stop, so a vendor accidentally pasting a formula isn't blocked. */
  const numericValidation = {
    type: "decimal",
    allowBlank: true,
    operator: "greaterThanOrEqual",
    formulae: [0],
    showErrorMessage: true,
    errorStyle: "warning",
    errorTitle: "Numbers only",
    error: "Min, Max and Rate must be numeric values (≥ 0). Leave Max blank for the open-ended top band.",
  };
  for (let r = 2; r <= wsBands.rowCount; r++) {
    wsBands.getCell(`B${r}`).dataValidation = numericValidation;
    wsBands.getCell(`C${r}`).dataValidation = numericValidation;
    wsBands.getCell(`D${r}`).dataValidation = numericValidation;
  }

  /* Sheet 3: All Regions — every country with every state/province/division.
     Also serves as the source for the Country/Zone dropdowns on Bulk Edit. */
  const regionRows = [
    ["Country Code", "Country Name", "Region Code", "Region Name"],
  ];
  for (const country of sortedCountries) {
    if (!country.provinces || country.provinces.length === 0) {
      regionRows.push([country.code, country.name, "", ""]);
    } else {
      country.provinces.forEach((p, idx) => {
        regionRows.push([
          idx === 0 ? country.code : "",
          idx === 0 ? country.name : "",
          p.code,
          p.name,
        ]);
      });
    }
  }
  const wsRegions = wb.addWorksheet("All Regions", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsRegions.columns = [
    { width: 14 },
    { width: 36 },
    { width: 14 },
    { width: 36 },
  ];
  regionRows.forEach((r) => wsRegions.addRow(r));

  /* Sheet 3: Instructions */
  const wsInfo = wb.addWorksheet("Instructions");
  wsInfo.columns = [
    { width: 6 },
    { width: 30 },
    { width: 26 },
    { width: 30 },
    { width: 30 },
  ];
  INSTRUCTIONS_ROWS.forEach((r) => wsInfo.addRow(r));

  /* Sheet 4: Lists — hidden helper holding the dropdown values for the
     Country and Zone columns. Kept on its own sheet so the All Regions
     reference view stays clean for humans. Name (column A in Bulk Edit) is
     intentionally free-form, so no Name list lives here. */
  const wsLists = wb.addWorksheet("Lists", { state: "hidden" });
  wsLists.columns = [
    { header: "Country", width: 36 },
    { header: "Zone", width: 36 },
  ];
  const countryLabels = [];
  const provinceLabels = [];
  for (const country of sortedCountries) {
    countryLabels.push(fmtCountryLabel(country));
    (country.provinces || []).forEach((p) => {
      const pLabel = fmtProvinceLabel(p);
      if (pLabel) provinceLabels.push(pLabel);
    });
  }
  countryLabels.push("Rest of World");
  const maxLen = Math.max(countryLabels.length, provinceLabels.length);
  for (let i = 0; i < maxLen; i++) {
    wsLists.addRow([countryLabels[i] || "", provinceLabels[i] || ""]);
  }

  /* Named ranges so the dropdown formulas stay readable */
  wb.definedNames.add(
    `Lists!$A$2:$A$${countryLabels.length + 1}`,
    "ValidCountries",
  );
  wb.definedNames.add(
    `Lists!$B$2:$B$${provinceLabels.length + 1}`,
    "ValidZones",
  );

  /* Attach data validation to Country (B), Zone (C) and Logic # (D) for
     every data row. Name (A) is intentionally free-form — vendors can type
     any value (rows whose Name doesn't match an existing zone are still
     skipped on upload, but no spreadsheet-level dropdown enforces it). */
  const lastRow = wsZones.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    wsZones.getCell(`B${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ["=ValidCountries"],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Invalid country",
      error: "Pick a country from the dropdown (matches the Lists / All Regions sheet).",
    };
    wsZones.getCell(`C${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ["=ValidZones"],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Invalid zone",
      error: "Pick a state / province / division from the dropdown, or leave blank for the whole country.",
    };
    wsZones.getCell(`D${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"0,1,2,3,4,5,6"'],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Invalid Logic #",
      error: "Logic # must be 1-6 (or 0 to reset the zone). Leave blank to keep the existing rule.",
    };
    /* Rate (column F): combined custom validation that does TWO jobs at once.
        - When Logic # in column D is 2 or 3 → the cell must be blank
          (category logic reads rates from the Rate Bands sheet). errorStyle
          'stop' makes Excel reject the entry outright.
        - Otherwise → must be a non-negative number.
       allowBlank lets users clear the cell freely. */
    wsZones.getCell(`F${r}`).dataValidation = {
      type: "custom",
      allowBlank: true,
      formulae: [
        `=IF(OR($D${r}=2,$D${r}=3),FALSE,AND(ISNUMBER(F${r}),F${r}>=0))`,
      ],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Rate not allowed here",
      error:
        "Logic 2 & 3 (category-based) read rates from the 'Rate Bands' sheet — leave Rate BLANK on this sheet for those rules. For Logic 1, 4, 5, 6 enter a non-negative number.",
    };
  }

  const buffer = await wb.xlsx.writeBuffer();

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="shipofix-bulk-edit.xlsx"',
      "Cache-Control": "no-store",
    },
  });
};

/* ── Action: upload filled template ─────────────────────────────────── */

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const setting = await prisma.appSetting.findUnique({
    where: { shop: shopDomain },
  });
  if (setting && setting.bulkEditEnabled === false) {
    return { success: false, error: "Bulk Edit is currently disabled." };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();

  /* Drop the stored last-upload file (vendor-initiated cleanup). Doesn't touch
     any zone rules — only the cached file. */
  if (intent === "delete_last") {
    if (!prisma.bulkEditUpload) {
      return { success: true, message: "Stored upload removed." };
    }
    await prisma.bulkEditUpload.deleteMany({ where: { shop: shopDomain } });
    return { success: true, message: "Stored upload removed." };
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return { success: false, error: "No file received." };
  }

  let workbook;
  let fileBuf;
  try {
    fileBuf = Buffer.from(await file.arrayBuffer());
    workbook = XLSX.read(fileBuf, { type: "buffer" });
  } catch (_e) {
    return { success: false, error: "Unable to read uploaded file. Make sure it's a valid .xlsx." };
  }

  const sheet =
    workbook.Sheets["Bulk Edit"] ||
    workbook.Sheets["Zones"] ||
    workbook.Sheets[
      workbook.SheetNames.find((n) => {
        const l = n.toLowerCase();
        return l === "bulk edit" || l === "zones";
      })
    ] ||
    workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    return { success: false, error: "Uploaded file has no readable sheet." };
  }

  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  if (!rawRows.length) {
    return { success: false, error: "Sheet is empty." };
  }

  /* Validate header row */
  const header = rawRows[0].map((h) => String(h || "").trim().toLowerCase());
  const expected = TEMPLATE_HEADERS.map((h) => h.toLowerCase());
  const headerOk = expected.every((h, i) => header[i] === h);
  if (!headerOk) {
    return {
      success: false,
      error:
        "Header row doesn't match the template. Download a fresh template and re-fill it.",
    };
  }

  /* Guard: if the file has no usable rows (no Name AND no Logic #), refuse
     the upload — applying it would silently wipe every rule for the shop
     and create nothing in return. This is what happened when the blank
     template was uploaded as-is. */
  const hasUsableRow = rawRows.slice(1).some((r) => {
    const name = String(r[0] || "").trim();
    const logic = String(r[3] ?? "").trim();
    return name !== "" || logic !== "";
  });
  if (!hasUsableRow) {
    return {
      success: false,
      error:
        "Uploaded file has no rows with a Name or Logic # filled in. Fill at least one row before uploading — otherwise the upload would wipe every existing rule.",
    };
  }

  /* Replace semantics, scoped to the bulk-edit ruleset only. Zone-wise
     rules in ZoneRule are untouched so toggling Bulk Edit off later brings
     them back exactly as they were. The wipe is deferred until AFTER full
     validation succeeds — if any rule has an error, nothing is touched. */
  if (!prisma.bulkEditRule || !prisma.bulkEditUpload) {
    return {
      success: false,
      error:
        "Bulk Edit storage isn't initialised yet. Stop the dev server, run `npx prisma generate`, then restart and try again.",
    };
  }

  /* Group rows by rule Name. A rule's coverage is the UNION of every
     Country/Zone cell that appears under that Name. */
  const groups = new Map();
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const name = String(r[0] || "").trim();
    if (!name) continue;

    if (!groups.has(name)) {
      groups.set(name, {
        name,
        /* Every Logic # encountered, deduped — used to detect conflicting
           values entered on different rows of the same Name. */
        logicValues: new Set(),
        /* Every Currency encountered, deduped. */
        currencies: new Set(),
        coverage: new Map(),   // countryCode -> { name, fullCountry, provincesByCode: Map }
        hasRestOfWorld: false,
        /* Bulk Edit Country cells that were left blank for this rule. Helps
           surface "Name set but no Country picked" as a precise error. */
        blankCountryRows: 0,
        /* Rate column entries on the Bulk Edit sheet (Logic 1 / 4 / 5 / 6). */
        rateRows: [],
        /* Rows from the Rate Bands sheet — bands keyed by Name (Logic 2 / 3). */
        bands: [],
        /* Which sheets this Name appeared on. Lets us reject orphan bands
           (Name on Rate Bands but not on Bulk Edit) with a clear message. */
        appearsOnBulkEdit: false,
        appearsOnRateBands: false,
      });
    }
    const g = groups.get(name);
    g.appearsOnBulkEdit = true;

    const logicStr = String(r[3] ?? "").trim();
    if (logicStr !== "") {
      const n = Number(logicStr);
      if (Number.isFinite(n)) g.logicValues.add(n);
    }
    const currency = String(r[4] || "").trim();
    if (currency) g.currencies.add(currency.toUpperCase());

    /* Coverage: Country / Zone columns */
    const cParsed = parseCountryCell(r[1]);
    if (!cParsed) {
      /* Name was set but Country is blank/garbage. Track so we can name the
         exact offence in the error message later. */
      g.blankCountryRows += 1;
    }
    if (cParsed) {
      if (cParsed.restOfWorld) {
        g.hasRestOfWorld = true;
      } else {
        const cc = cParsed.countryCode;
        if (!g.coverage.has(cc)) {
          g.coverage.set(cc, {
            name: cParsed.name || cc,
            fullCountry: false,
            provincesByCode: new Map(),
          });
        }
        const entry = g.coverage.get(cc);
        const pParsed = parseProvinceCell(r[2]);
        if (pParsed) {
          entry.provincesByCode.set(pParsed.code, pParsed.name || pParsed.code);
        } else {
          /* Country with no Zone listed → cover the whole country */
          entry.fullCountry = true;
        }
      }
    }

    /* Rate column entries. For non-range logic (1/4/5/6) the row's Country /
       Province acts as a per-destination override; the first unbound row is
       the fallback rate. Range types (2/3) ignore this — their bands live on
       the Rate Bands sheet. */
    const rate = r[5];
    const nonEmpty = (v) => v !== "" && v !== null && v !== undefined;
    if (nonEmpty(rate)) {
      const pParsedForBand = parseProvinceCell(r[2]);
      g.rateRows.push({
        rate,
        countryCode: cParsed?.restOfWorld
          ? null
          : cParsed?.countryCode || null,
        province: pParsedForBand?.code || null,
      });
    }
  }

  /* Pre-collect band-level row issues so we can surface them with the exact
     spreadsheet row number the vendor will see in Excel. */
  const bandRowErrors = [];

  /* Optional: dedicated Rate Bands sheet — bands keyed only by Name, with no
     country/province context. Merges into the same group's bands array.
     Skipped silently if the sheet is missing (older templates) or empty. */
  const bandsSheet =
    workbook.Sheets["Rate Bands"] ||
    workbook.Sheets[
      workbook.SheetNames.find((n) => n.toLowerCase() === "rate bands")
    ];
  if (bandsSheet) {
    const bandRows = XLSX.utils.sheet_to_json(bandsSheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });
    /* Tolerate header row variations — only require Name in column A. Rows
       before the data start (e.g. an instructional row a vendor added) are
       skipped via the same "no name" filter below. */
    const nonEmpty = (v) => v !== "" && v !== null && v !== undefined;
    const startIdx = bandRows.length && String(bandRows[0][0] || "").trim().toLowerCase() === "name" ? 1 : 0;
    const toNum = (v) => {
      if (!nonEmpty(v)) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN; /* NaN ≠ null distinguishes "non-numeric" from "blank" */
    };
    for (let i = startIdx; i < bandRows.length; i++) {
      const r = bandRows[i];
      const name = String(r[0] || "").trim();
      if (!name) continue;
      /* Spreadsheet row number the vendor sees (1-indexed; header is row 1). */
      const sheetRow = i + 1;
      const minRaw = r[1];
      const maxRaw = r[2];
      const rateRaw = r[3];
      const minN = toNum(minRaw);
      const maxN = toNum(maxRaw);
      const rateN = toNum(rateRaw);

      /* Row-level validation. Each problem becomes an actionable error
         pinned to a specific (Name, row) so vendors can fix it fast. */
      if (Number.isNaN(minN) || Number.isNaN(maxN) || Number.isNaN(rateN)) {
        bandRowErrors.push(`Rate Bands row ${sheetRow} (Name "${name}"): Min / Max / Rate must be numeric. Found Min="${minRaw}", Max="${maxRaw}", Rate="${rateRaw}".`);
        continue;
      }
      if (!nonEmpty(rateRaw)) {
        /* No rate → silently dropped (vendor left it blank intentionally). */
        continue;
      }
      if (rateN < 0) {
        bandRowErrors.push(`Rate Bands row ${sheetRow} (Name "${name}"): Rate cannot be negative (got ${rateN}).`);
        continue;
      }
      if (nonEmpty(minRaw) && minN < 0) {
        bandRowErrors.push(`Rate Bands row ${sheetRow} (Name "${name}"): Min cannot be negative (got ${minN}).`);
        continue;
      }
      if (nonEmpty(maxRaw) && maxN < 0) {
        bandRowErrors.push(`Rate Bands row ${sheetRow} (Name "${name}"): Max cannot be negative (got ${maxN}).`);
        continue;
      }
      if (nonEmpty(minRaw) && nonEmpty(maxRaw) && minN >= maxN) {
        bandRowErrors.push(`Rate Bands row ${sheetRow} (Name "${name}"): Min (${minN}) must be less than Max (${maxN}). Leave Max blank for the open-ended top band.`);
        continue;
      }

      if (!groups.has(name)) {
        /* Orphan band — the rule's coverage/logic must still come from the
           Bulk Edit sheet. Create the group so the orphan-name check below
           can fire with the correct rule Name. */
        groups.set(name, {
          name,
          logicValues: new Set(),
          currencies: new Set(),
          coverage: new Map(),
          hasRestOfWorld: false,
          blankCountryRows: 0,
          rateRows: [],
          bands: [],
          appearsOnBulkEdit: false,
          appearsOnRateBands: false,
        });
      }
      const g = groups.get(name);
      g.appearsOnRateBands = true;
      g.bands.push({ min: minRaw, max: maxRaw, rate: rateRaw });
    }
  }

  /* Two-phase apply: VALIDATE first, then COMMIT. Every group either
     contributes a row to rulesToWrite or pushes an error to summary.errors.
     Nothing is written to the DB until the whole upload validates clean —
     a single broken rule rejects the entire upload so vendors never end up
     with a half-applied ruleset (or, worse, an empty one after a wipe). */
  const summary = { updated: 0, reset: 0, skipped: 0, errors: [], warnings: [] };
  const rulesToWrite = [];
  /* Seed errors with any row-level issues already collected from the Rate
     Bands sheet. They're processed before the per-rule loop so vendors see
     spreadsheet row numbers alongside rule-level errors. */
  for (const e of bandRowErrors) summary.errors.push(e);

  for (const [name, g] of groups.entries()) {
    /* Orphan name — band rows reference a Name that isn't on Bulk Edit. The
       rule can't exist without coverage, so reject with a precise message. */
    if (!g.appearsOnBulkEdit && g.appearsOnRateBands) {
      summary.errors.push(
        `Rate Bands references Name "${name}" but that Name doesn't appear anywhere on the Bulk Edit sheet. Either add a Bulk Edit row with this Name (and a Country / Zone), or delete the orphan Rate Bands rows.`,
      );
      continue;
    }

    /* Conflicting Logic # — vendor put e.g. 2 on one row and 3 on another
       under the same Name. Can't pick one for them, so reject. */
    if (g.logicValues.size > 1) {
      summary.errors.push(
        `Rule "${name}": conflicting Logic # values (${[...g.logicValues].join(", ")}). Set the Logic # on one row of the rule and leave it blank on the others.`,
      );
      continue;
    }

    /* Conflicting Currency — same reason. */
    if (g.currencies.size > 1) {
      summary.errors.push(
        `Rule "${name}": conflicting Currency values (${[...g.currencies].join(", ")}). Set Currency on one row of the rule and leave it blank on the others.`,
      );
      continue;
    }

    const logicNum = g.logicValues.size === 1 ? [...g.logicValues][0] : null;

    /* Logic # blank → skip (keep existing rule untouched) */
    if (logicNum === null) {
      summary.skipped += 1;
      continue;
    }

    /* Logic # = 0 → reset (the wipe above already removed it). Warn if the
       vendor also filled a Rate or bands — those will be discarded. */
    if (logicNum === 0) {
      summary.reset += 1;
      if (g.rateRows.length || g.bands.length) {
        summary.warnings.push(
          `Rule "${name}": Logic # 0 (reset) — Rate / Rate Bands rows for this rule were discarded.`,
        );
      }
      continue;
    }

    const logicType = LOGIC_BY_NUMBER[logicNum];
    if (!logicType) {
      summary.errors.push(
        `Rule "${name}": Logic # ${logicNum} is not a valid type (use 1-6, or 0 to reset).`,
      );
      continue;
    }

    /* A rule needs at least one country or Rest of World to be matchable */
    if (g.coverage.size === 0 && !g.hasRestOfWorld) {
      if (g.blankCountryRows > 0) {
        summary.errors.push(
          `Rule "${name}": Name was entered on ${g.blankCountryRows} row${g.blankCountryRows === 1 ? "" : "s"} but Country is blank. Pick a Country from the dropdown on each of the rule's rows (or 'Rest of World').`,
        );
      } else {
        summary.errors.push(
          `Rule "${name}": no Country listed — add at least one country (or "Rest of World").`,
        );
      }
      continue;
    }

    /* Cross-sheet sanity — HARD errors. Mixing inputs between the two
       sheets is almost always a vendor mistake (often: Logic # flipped to
       2 / 3 after Rate was already typed). Excel-side validation blocks
       the typical entry path; this is the belt-and-braces server check. */
    const isRangeLogic = logicType === "WEIGHT_RANGE" || logicType === "PRICE_RANGE";
    if (isRangeLogic && g.rateRows.length > 0) {
      summary.errors.push(
        `Rule "${name}" (Logic ${logicNum}): the Rate column on the Bulk Edit sheet is filled but Logic 2 & 3 are category-based — their rates live on the Rate Bands sheet only. Clear the Rate cell on every Bulk Edit row for this rule.`,
      );
      continue;
    }
    if (!isRangeLogic && g.bands.length > 0) {
      summary.errors.push(
        `Rule "${name}" (Logic ${logicNum}): the Rate Bands sheet has rows for this rule, but Logic ${logicNum} reads its rate from the Bulk Edit Rate column only. Remove the Rate Bands rows for Name "${name}" (or change Logic # to 2 or 3).`,
      );
      continue;
    }
    /* Logic 5 expects a decimal (0.1 = 10%). A value > 1 is almost certainly
       a vendor mistake (10 meaning 10%, or worse). */
    if (logicType === "PRICE_MULTIPLIER") {
      const firstRate = g.rateRows[0]?.rate;
      const n = Number(firstRate);
      if (Number.isFinite(n) && n > 1) {
        summary.warnings.push(
          `Rule "${name}" (Logic 5 · Per Price Dynamic): Rate is ${n}, which is read as ${n * 100}% of cart total. If you meant 10%, enter 0.1.`,
        );
      }
    }

    /* Currency: explicit > INR. (The previous bulk-rule row isn't consulted
       because the apply phase wipes the whole bulk-edit ruleset before
       writing — there's no prior currency to inherit.) */
    const gid = ruleNameToGid(name);
    const currency = [...g.currencies][0] || "INR";

    /* Build rules JSON for the chosen logic type */
    let rulesJson;
    const num = (v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    /* Split Bulk Edit Rate rows into "location-bound" (have Country and/or
       Province → per-destination overrides) and "unbound" (no location →
       rule-wide default). Last write wins per (country, province) key. */
    const buildNonRangeRate = () => {
      const rated = g.rateRows.filter((b) => num(b.rate) !== null);
      if (rated.length === 0) return null;
      const unbound = rated.find((b) => !b.countryCode);
      const fallbackRate = num((unbound || rated[0]).rate);
      const overrideMap = new Map();
      for (const b of rated) {
        if (!b.countryCode) continue;
        const key = `${b.countryCode}::${b.province || ""}`;
        const entry = { countryCode: b.countryCode, rate: num(b.rate) };
        if (b.province) entry.province = b.province;
        overrideMap.set(key, entry);
      }
      return { rate: fallbackRate, overrides: Array.from(overrideMap.values()) };
    };

    if (logicType === "STANDARD_TIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}" (Logic 1 · Standard Flat Tier): the Rate column on the Bulk Edit sheet is empty. Put the flat amount on the rule's first row.`);
        continue;
      }
      const payload = { flat_rate: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "WEIGHT_RANGE") {
      if (g.bands.length === 0) {
        summary.errors.push(`Rule "${name}" (Logic 2 · Weight Based): no entries on the Rate Bands sheet. Logic 2 requires at least one row on Rate Bands with Name "${name}".`);
        continue;
      }
      const bands = g.bands
        .map((b) => {
          const min = num(b.min);
          const max = num(b.max);
          const rate = num(b.rate);
          if (rate === null) return null;
          return { min_kg: min ?? 0, max_kg: max, rate };
        })
        .filter(Boolean);
      if (bands.length === 0) {
        summary.errors.push(`Rule "${name}" (Logic 2 · Weight Based): every Rate Bands row for this rule is missing a numeric Rate. Fill the Rate column on at least one row.`);
        continue;
      }
      const issues = describeBandIssues(
        bands.map((b) => ({ min: b.min_kg, max: b.max_kg })),
        "kg",
      );
      for (const issue of issues) {
        summary.warnings.push(`Rule "${name}" (Logic 2): ${issue}`);
      }
      rulesJson = JSON.stringify(bands);
    } else if (logicType === "PRICE_RANGE") {
      if (g.bands.length === 0) {
        summary.errors.push(`Rule "${name}" (Logic 3 · Price Based): no entries on the Rate Bands sheet. Logic 3 requires at least one row on Rate Bands with Name "${name}".`);
        continue;
      }
      const bands = g.bands
        .map((b) => {
          const min = num(b.min);
          const max = num(b.max);
          const rate = num(b.rate);
          if (rate === null) return null;
          return { min_total: min ?? 0, max_total: max, rate };
        })
        .filter(Boolean);
      if (bands.length === 0) {
        summary.errors.push(`Rule "${name}" (Logic 3 · Price Based): every Rate Bands row for this rule is missing a numeric Rate. Fill the Rate column on at least one row.`);
        continue;
      }
      const issues = describeBandIssues(
        bands.map((b) => ({ min: b.min_total, max: b.max_total })),
        currency,
      );
      for (const issue of issues) {
        summary.warnings.push(`Rule "${name}" (Logic 3): ${issue}`);
      }
      rulesJson = JSON.stringify(bands);
    } else if (logicType === "WEIGHT_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}" (Logic 4 · Per KG Dynamic): the Rate column on the Bulk Edit sheet is empty. Fill it with the per-kg amount.`);
        continue;
      }
      const payload = { rate_per_kg: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "PRICE_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}" (Logic 5 · Per Price Dynamic): the Rate column on the Bulk Edit sheet is empty. Fill it with a decimal fraction (e.g. 0.1 for 10%).`);
        continue;
      }
      const payload = { percentage: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "ITEM_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}" (Logic 6 · Per Item Dynamic): the Rate column on the Bulk Edit sheet is empty. Fill it with the per-item amount.`);
        continue;
      }
      const payload = { rate_per_item: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else {
      summary.skipped += 1;
      continue;
    }

    const countries = JSON.stringify(coverageToCountriesArray(g));
    /* Queue up — the commit phase below writes only if validation passes
       across the entire upload. */
    rulesToWrite.push({ gid, name, countries, logicType, rulesJson, currency });
  }

  /* ── Validation gate ─────────────────────────────────────────────────
     Any error → reject the whole upload. The bulk-edit ruleset is
     untouched; the vendor sees every issue at once and re-uploads. */
  if (summary.errors.length > 0) {
    return {
      success: false,
      errors: summary.errors,
      warnings: summary.warnings,
      summary: { ...summary, wiped: 0 },
      message: `Upload rejected · ${summary.errors.length} issue${summary.errors.length === 1 ? "" : "s"} found. Nothing was saved — fix the issues below and upload again.`,
    };
  }

  /* ── Commit phase ───────────────────────────────────────────────────
     Wipe the bulk-edit ruleset only after we know every rule is valid,
     then write the queued rules. */
  const wipedCount = await prisma.bulkEditRule.deleteMany({
    where: { shop: shopDomain },
  });
  for (const r of rulesToWrite) {
    await prisma.bulkEditRule.upsert({
      where: {
        shop_deliveryZoneGid: { shop: shopDomain, deliveryZoneGid: r.gid },
      },
      update: {
        name: r.name,
        countries: r.countries,
        logicType: r.logicType,
        rulesJson: r.rulesJson,
        currency: r.currency,
      },
      create: {
        shop: shopDomain,
        deliveryZoneGid: r.gid,
        name: r.name,
        countries: r.countries,
        logicType: r.logicType,
        rulesJson: r.rulesJson,
        currency: r.currency,
      },
    });
    summary.updated += 1;
  }

  /* Cache the file so vendors can re-download exactly what they uploaded.
     Re-uploading replaces the cached copy. */
  const filename = (typeof file.name === "string" && file.name) || "bulk-edit.xlsx";
  await prisma.bulkEditUpload.upsert({
    where: { shop: shopDomain },
    update: {
      filename,
      size: fileBuf.length,
      data: fileBuf,
      uploadedAt: new Date(),
    },
    create: {
      shop: shopDomain,
      filename,
      size: fileBuf.length,
      data: fileBuf,
    },
  });

  /* Summary reflects the bulk-edit ruleset only — zone-wise rules are
     untouched. */
  const skippedOrReset = summary.reset + summary.skipped;
  const parts = [];
  if (summary.updated) parts.push(`${summary.updated} bulk rule${summary.updated === 1 ? "" : "s"} created`);
  if (skippedOrReset) parts.push(`${skippedOrReset} rule${skippedOrReset === 1 ? "" : "s"} left on default`);
  if (wipedCount.count) parts.push(`${wipedCount.count} previous bulk rule${wipedCount.count === 1 ? "" : "s"} replaced`);
  const message =
    summary.updated === 0 && skippedOrReset === 0
      ? "Upload processed — no rules were created."
      : `Bulk edit applied · ${parts.join(" · ")}.`;

  return {
    success: true,
    message,
    errors: summary.errors,
    warnings: summary.warnings,
    summary: { ...summary, wiped: wipedCount.count },
    logicLabels: LOGIC_LABELS,
  };
};
