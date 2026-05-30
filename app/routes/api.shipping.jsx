import crypto from "crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import prisma from "../db.server";
import {
  parseMoney,
  parseSubunitToMajor,
  parseZoneCoverage,
  getZoneMatchScore,
  createLogger,
} from "../lib/shipping.utils.js";
import { calculateRate, isPriceableLogicType } from "../lib/rate-calculators.js";

/**
 * Carrier Service callback endpoint.
 * Shopify POSTs here during checkout to get custom shipping rates.
 */

const { log } = createLogger("[CARRIER]");

/* ── Helpers ──────────────────────────────────────────────────────────── */

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const emptyRates = () => jsonResponse({ rates: [] });

/* ── GET handler — health check ──────────────────────────────────────── */

export const loader = async () =>
  jsonResponse({
    status: "ok",
    service: "shipofix-carrier",
    timestamp: new Date().toISOString(),
  });

/* ── POST handler — Shopify checkout callback ────────────────────────── */

export const action = async ({ request }) => {
  try {
    const rawBody = await request.text();
    await log("=== INCOMING CARRIER REQUEST ===");

    /* ── HMAC verification ── */
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET;
    const generatedHmac = crypto
      .createHmac("sha256", secret || "")
      .update(rawBody, "utf8")
      .digest("base64");

    /* Constant-time compare to avoid leaking the signature via timing.
       timingSafeEqual throws on length mismatch, so guard that first. */
    const hmacMatch = (() => {
      if (!hmacHeader) return false;
      const a = Buffer.from(hmacHeader);
      const b = Buffer.from(generatedHmac);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();

    await log({
      event: "HMAC_DEBUG",
      hmacMatch,
      secretLoaded: !!secret,
    });

    if (!hmacMatch) {
      await log("HMAC verification FAILED — returning 401 Unauthorized");
      return new Response("Unauthorized", { status: 401 });
    }

    await log("HMAC verification PASSED");

    /* ── Parse request ── */
    const payload = JSON.parse(rawBody);
    const { rate } = payload;
    const shopDomain = request.headers.get("X-Shopify-Shop-Domain");

    await log({
      event: "REQUEST_PARSED",
      shop: shopDomain,
      destination: {
        country: rate?.destination?.country,
        province: rate?.destination?.province,
        province_code: rate?.destination?.province_code,
      },
      itemCount: rate?.items?.length,
      currency: rate?.currency,
    });

    if (!shopDomain || !rate) {
      await log("Missing shopDomain or rate — returning empty");
      return emptyRates();
    }

    /* ── Destination & cart ── */
    const destinationCountry = String(rate.destination?.country || "").toUpperCase();
    const destinationProvince = String(
      rate.destination?.province_code || rate.destination?.province || "",
    ).toUpperCase();
    const items = Array.isArray(rate.items) ? rate.items : [];

    if (!destinationCountry || items.length === 0) {
      await log(`No destination (${destinationCountry}) or empty cart — returning empty`);
      return emptyRates();
    }

    const totalGrams = items.reduce(
      (sum, item) => sum + (parseFloat(String(item.grams || 0)) || 0) * (item.quantity || 1),
      0,
    );
    const totalKg = totalGrams / 1000;
    const totalItems = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const lineItemTotalPrice = items.reduce(
      (sum, item) => sum + parseMoney(item.price) * (item.quantity || 1),
      0,
    );
    const subtotalFromOrderTotals = parseSubunitToMajor(rate.order_totals?.subtotal_price);
    const totalPrice = subtotalFromOrderTotals > 0 ? subtotalFromOrderTotals : lineItemTotalPrice;

    await log({ event: "CART_TOTALS", totalKg: totalKg.toFixed(3), totalItems, totalPrice, currency: rate.currency });

    /* ── Match candidate rules ──
       Every rule lives in a single ZoneRule table — both zone-wise rules
       (source = 'shopify') and Excel-uploaded rules (source = 'bulk') are
       always active and matched against incoming requests by country
       coverage. Use a countryCode-specific contains pattern to avoid false
       positives — e.g. US/Indiana has province code "IN" which would
       otherwise falsely match India "IN". */
    const candidates = await prisma.zoneRule.findMany({
      where: {
        shop: shopDomain,
        OR: [
          { countries: { contains: `"countryCode":"${destinationCountry}"` } },
          { countries: { contains: '"restOfWorld":true' } },
        ],
      },
    });

    await log({ event: "DB_CANDIDATES", count: candidates.length, rules: candidates.map(r => ({ name: r.name, logic: r.logicType, gid: r.deliveryZoneGid, source: r.source })) });

    let matchedRule = null;
    let matchedScore = -1;

    /* Only rules with a real calculator can win. Placeholder "DEFAULT" rules
       (auto-created for un-priced Shopify zones) and any unknown/stale type
       can only return null, so excluding them here stops them shadowing a
       properly-configured rule that also covers this destination. */
    const priceableCandidates = candidates.filter((r) =>
      isPriceableLogicType(r.logicType),
    );

    await log({ event: "PRICEABLE_CANDIDATES", count: priceableCandidates.length, skipped: candidates.length - priceableCandidates.length });

    for (const rule of priceableCandidates) {
      const coverageRules = parseZoneCoverage(rule.countries);
      const score = getZoneMatchScore(coverageRules, destinationCountry, destinationProvince);
      await log({ event: "SCORE_CHECK", ruleName: rule.name, gid: rule.deliveryZoneGid, score, destinationCountry, destinationProvince });

      // Pick highest score; on tie, prefer the most recently updated rule
      if (score > matchedScore || (score === matchedScore && score > 0 && matchedRule && rule.updatedAt > matchedRule.updatedAt)) {
        matchedScore = score;
        matchedRule = rule;
      }
    }

    if (!matchedRule || matchedScore < 0) {
      await log(`MATCH_FAILED: country=${destinationCountry} province=${destinationProvince}`);
      return emptyRates();
    }

    await log({ event: "MATCH_SUCCESS", ruleName: matchedRule.name, gid: matchedRule.deliveryZoneGid, logicType: matchedRule.logicType, score: matchedScore });

    /* ── Rate calculation via strategy ──
       Non-range rules can carry `overrides` — a list of per-destination
       rates that replace the default for the matched country/province.
       Range types (band lists) don't use overrides; their array shape
       has no `.overrides` field. */
    const rules = JSON.parse(matchedRule.rulesJson || "{}");
    if (!Array.isArray(rules) && Array.isArray(rules.overrides)) {
      const exact = rules.overrides.find(
        (o) =>
          o.countryCode === destinationCountry &&
          o.province && o.province === destinationProvince,
      );
      const countryLevel = rules.overrides.find(
        (o) => o.countryCode === destinationCountry && !o.province,
      );
      const ov = exact || countryLevel;
      if (ov && Number.isFinite(Number(ov.rate))) {
        const r = Number(ov.rate);
        switch (matchedRule.logicType) {
          case "STANDARD_TIER": rules.flat_rate = r; break;
          case "WEIGHT_MULTIPLIER": rules.rate_per_kg = r; break;
          case "PRICE_MULTIPLIER": rules.percentage = r; break;
          case "ITEM_MULTIPLIER": rules.rate_per_item = r; break;
        }
        await log({ event: "RATE_OVERRIDE_APPLIED", country: destinationCountry, province: destinationProvince, rate: r });
      }
    }
    const result = calculateRate(matchedRule.logicType, rules, totalKg, totalPrice, totalItems);

    if (!result) {
      await log(`UNKNOWN_LOGIC_TYPE: ${matchedRule.logicType}`);
      return emptyRates();
    }

    const { rate: calculatedRate, serviceName, serviceCode, description } = result;

    await log({ event: "RATE_CALCULATED", calculatedRate, serviceName, serviceCode });

    if (calculatedRate !== null && Number.isFinite(calculatedRate) && calculatedRate >= 0) {
      const currency = rate.currency || matchedRule.currency || "USD";
      const rateInSubunits = Math.round(calculatedRate * 100).toString();

      const responseBody = {
        rates: [
          {
            service_name: serviceName,
            service_code: serviceCode,
            total_price: rateInSubunits,
            currency,
            description,
            min_delivery_date: "",
            max_delivery_date: "",
          },
        ],
      };

      await log({ event: "RESPONSE_SENT", rates: responseBody.rates });
      return jsonResponse(responseBody);
    }

    await log("RATE_NULL — returning empty rates");
    return emptyRates();
  } catch (error) {
    console.error("Shipping Rate calculation error:", error);
    const { log: errorLog } = createLogger("[CARRIER-ERROR]");
    await errorLog(`FATAL ERROR: ${error.message}\n${error.stack}`);
    return emptyRates();
  }
};
