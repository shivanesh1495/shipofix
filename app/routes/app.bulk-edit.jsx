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
  "Min",
  "Max",
  "Rate",
];

const COL_COUNT = TEMPLATE_HEADERS.length;
const EMPTY_ROW = () => Array(COL_COUNT).fill("");

const INSTRUCTIONS_ROWS = [
  ["Shipofix · Bulk Edit Template"],
  [],
  ["Sheet layout"],
  ["• Name      — the shipping zone name this row applies to. Free-form; type any value."],
  ["• Country   — country this row applies to (pre-filled as reference)."],
  ["• Zone      — specific state / province / division (pre-filled, blank for countries with none)."],
  ["• Logic #   — 1-6 picks the rate model, 0 = reset to Shopify Default, blank = no change."],
  ["• Currency  — ISO code (e.g. INR, USD). Defaults to INR if blank."],
  ["• Min/Max   — used by range types (2 & 3) only; ignored otherwise."],
  ["• Rate      — flat rate / per-band rate / per-unit value depending on the logic type."],
  [],
  ["How to fill the template"],
  ["1.  Country and Zone columns are pre-populated with every official country/region. They're informational and ignored on upload — leave them as-is."],
  ["2.  For each row you want to apply, type the zone Name in column A. Must match an existing Shopify shipping zone exactly — unknown names are skipped on upload."],
  ["3.  Set Logic # and Currency on the FIRST row of each zone. Leave them blank on other rows of the same zone."],
  ["4.  For types 1, 4, 5, 6 — put the Rate on the first row of the zone."],
  ["5.  For types 2 & 3 — fill Min / Max / Rate per band. Bands can share zone rows or be added as new rows with the same Name."],
  ["6.  Rows with Name left blank are skipped. Save as .xlsx and upload it back into the Bulk Edit panel."],
  [],
  ["Logic # reference"],
  ["#", "Logic Type", "Min column", "Max column", "Rate column"],
  [1, "Standard Flat Tier", "—", "—", "Flat rate"],
  [2, "Weight Based (Category)", "Min weight (kg)", "Max weight (kg, blank = ∞)", "Rate per band"],
  [3, "Price Based (Category)", "Min cart total", "Max cart total (blank = ∞)", "Rate per band"],
  [4, "Per KG Dynamic", "—", "—", "Rate per kg"],
  [5, "Per Price Dynamic", "—", "—", "Decimal % (0.1 = 10%)"],
  [6, "Per Item Dynamic", "—", "—", "Rate per item"],
  [],
  ["Notes"],
  ["• Name must match an existing Shopify shipping zone exactly. Unknown / blank names are skipped on upload."],
  ["• Uploading replaces every existing rule for the shop — zones left out are reset to Shopify Default."],
  ["• Bulk Edit never creates or deletes zones — manage zones from the dashboard."],
  ["• The All Regions sheet lists every country and its states/provinces for reference."],
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
  for (const country of sortedCountries) {
    const countryLabel = fmtCountryLabel(country);
    if (!country.provinces || country.provinces.length === 0) {
      rows.push(["", countryLabel, "", "", "", "", "", ""]);
    } else {
      for (const p of country.provinces) {
        rows.push(["", countryLabel, fmtProvinceLabel(p), "", "", "", "", ""]);
      }
    }
  }
  /* Rest of World row so vendors can target it explicitly */
  rows.push(["", "Rest of World", "", "", "", "", "", ""]);
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
    { width: 12 }, // Min
    { width: 12 }, // Max
    { width: 14 }, // Rate
  ];
  zoneRows.forEach((r) => wsZones.addRow(r));

  /* Sheet 2: All Regions — every country with every state/province/division.
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
     them back exactly as they were. */
  if (!prisma.bulkEditRule || !prisma.bulkEditUpload) {
    return {
      success: false,
      error:
        "Bulk Edit storage isn't initialised yet. Stop the dev server, run `npx prisma generate`, then restart and try again.",
    };
  }
  const wipedCount = await prisma.bulkEditRule.deleteMany({
    where: { shop: shopDomain },
  });

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
        logicNum: null,
        currency: "",
        coverage: new Map(),   // countryCode -> { name, fullCountry, provincesByCode: Map }
        hasRestOfWorld: false,
        bands: [],
      });
    }
    const g = groups.get(name);

    const logicStr = String(r[3] ?? "").trim();
    if (logicStr !== "" && g.logicNum === null) {
      const n = Number(logicStr);
      if (Number.isFinite(n)) g.logicNum = n;
    }
    const currency = String(r[4] || "").trim();
    if (currency && !g.currency) g.currency = currency.toUpperCase();

    /* Coverage: Country / Zone columns */
    const cParsed = parseCountryCell(r[1]);
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

    /* Bands: any row that carries rate data contributes. Track the row's
       Country / Province so non-range types can build per-destination
       overrides; range types ignore the location fields. */
    const min = r[5];
    const max = r[6];
    const rate = r[7];
    const nonEmpty = (v) => v !== "" && v !== null && v !== undefined;
    if (nonEmpty(rate) || nonEmpty(min) || nonEmpty(max)) {
      const pParsedForBand = parseProvinceCell(r[2]);
      g.bands.push({
        min,
        max,
        rate,
        countryCode: cParsed?.restOfWorld
          ? null
          : cParsed?.countryCode || null,
        province: pParsedForBand?.code || null,
      });
    }
  }

  /* Apply changes */
  const summary = { updated: 0, reset: 0, skipped: 0, errors: [] };

  for (const [name, g] of groups.entries()) {
    /* Logic # blank → skip (keep existing rule untouched) */
    if (g.logicNum === null) {
      summary.skipped += 1;
      continue;
    }

    /* Logic # = 0 → reset (the wipe above already removed it) */
    if (g.logicNum === 0) {
      summary.reset += 1;
      continue;
    }

    const logicType = LOGIC_BY_NUMBER[g.logicNum];
    if (!logicType) {
      summary.errors.push(
        `Rule "${name}": Logic # ${g.logicNum} is not a valid type (use 1-6, or 0 to reset).`,
      );
      continue;
    }

    /* A rule needs at least one country or Rest of World to be matchable */
    if (g.coverage.size === 0 && !g.hasRestOfWorld) {
      summary.errors.push(
        `Rule "${name}": no Country listed — add at least one country (or "Rest of World").`,
      );
      continue;
    }

    /* Currency: explicit > previous upsert > INR */
    const gid = ruleNameToGid(name);
    const prevBulk = await prisma.bulkEditRule.findUnique({
      where: {
        shop_deliveryZoneGid: { shop: shopDomain, deliveryZoneGid: gid },
      },
    });
    const currency = g.currency || prevBulk?.currency || "INR";

    /* Build rules JSON for the chosen logic type */
    let rulesJson;
    const firstBand = g.bands[0] || {};
    const num = (v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    /* Split bands into "location-bound" (have Country and/or Province) and
       "unbound" (no location → applies as the rule-wide default). The
       location-bound ones become per-destination overrides. Last write
       wins per (country, province) key so re-entering a row updates it. */
    const buildNonRangeRate = () => {
      const rated = g.bands.filter((b) => num(b.rate) !== null);
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
        summary.errors.push(`Rule "${name}": Rate is required for Standard Flat Tier.`);
        continue;
      }
      const payload = { flat_rate: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "WEIGHT_RANGE") {
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
        summary.errors.push(`Rule "${name}": Weight Based needs at least one row with Rate filled.`);
        continue;
      }
      rulesJson = JSON.stringify(bands);
    } else if (logicType === "PRICE_RANGE") {
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
        summary.errors.push(`Rule "${name}": Price Based needs at least one row with Rate filled.`);
        continue;
      }
      rulesJson = JSON.stringify(bands);
    } else if (logicType === "WEIGHT_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}": Per KG Dynamic needs a Rate value.`);
        continue;
      }
      const payload = { rate_per_kg: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "PRICE_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}": Per Price Dynamic needs a Rate (decimal, e.g. 0.1).`);
        continue;
      }
      const payload = { percentage: built.rate };
      if (built.overrides.length) payload.overrides = built.overrides;
      rulesJson = JSON.stringify(payload);
    } else if (logicType === "ITEM_MULTIPLIER") {
      const built = buildNonRangeRate();
      if (built === null) {
        summary.errors.push(`Rule "${name}": Per Item Dynamic needs a Rate per item.`);
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
    await prisma.bulkEditRule.upsert({
      where: {
        shop_deliveryZoneGid: { shop: shopDomain, deliveryZoneGid: gid },
      },
      update: { name, countries, logicType, rulesJson, currency },
      create: {
        shop: shopDomain,
        deliveryZoneGid: gid,
        name,
        countries,
        logicType,
        rulesJson,
        currency,
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
    summary: { ...summary, wiped: wipedCount.count },
    logicLabels: LOGIC_LABELS,
  };
};
