/**
 * Shared shipping utility functions.
 * Used by both the Carrier Service API and the Admin Dashboard.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/* ── Numeric parsing ─────────────────────────────────────────────────── */

/**
 * Safely parse a money value to a float.
 * Returns 0 for null/undefined/NaN.
 */
export function parseMoney(value) {
  const parsed = parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse Shopify subunit amounts (cents) to major currency units.
 * e.g. 1500 → 15.00
 */
export function parseSubunitToMajor(value) {
  const parsed = parseFloat(String(value ?? "0"));
  if (!Number.isFinite(parsed)) return 0;
  return parsed / 100;
}

/* ── Zone coverage parsing ───────────────────────────────────────────── */

/**
 * Deserialize a JSON string of country/province coverage rules
 * into a normalized array of { countryCode, restOfWorld, provinces }.
 */
export function parseZoneCoverage(countriesRaw) {
  if (!countriesRaw) return [];

  try {
    const parsed = JSON.parse(countriesRaw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((rule) => {
        if (typeof rule === "string") {
          return {
            countryCode: String(rule).toUpperCase(),
            restOfWorld: false,
            provinces: [],
          };
        }

        if (!rule || typeof rule !== "object") return null;

        const countryCode = String(rule.countryCode || "").toUpperCase();
        const restOfWorld = Boolean(rule.restOfWorld);
        const rawProvinces = Array.isArray(rule.provinces)
          ? rule.provinces
          : [];
        const provinces = rawProvinces
          .map((p) => {
            if (typeof p === "string") return p.toUpperCase();
            if (p && typeof p === "object" && p.code)
              return String(p.code).toUpperCase();
            return null;
          })
          .filter(Boolean);

        if (!countryCode && !restOfWorld) return null;

        return { countryCode, restOfWorld, provinces };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ── Zone match scoring ──────────────────────────────────────────────── */

/**
 * Score how well a set of coverage rules matches a destination.
 * Higher score = better match. Returns -1 for no match.
 *
 * Priority:
 *   100 — Exact province match
 *    60 — Country-level match (all provinces)
 *    50 — Province-level zone but no province info from Shopify
 *    10 — Rest-of-world fallback
 */
export function getZoneMatchScore(
  coverageRules,
  destinationCountry,
  destinationProvince,
) {
  let bestScore = -1;
  const destProv = (destinationProvince || "").toUpperCase().trim();

  for (const rule of coverageRules) {
    // Rest-of-world fallback — lowest priority
    if (rule.restOfWorld) {
      bestScore = Math.max(bestScore, 10);
      continue;
    }

    // Country code must match
    if (rule.countryCode !== destinationCountry) continue;

    // Province-level zone: only match if destination province is in the list
    if (rule.provinces.length > 0) {
      if (destProv && rule.provinces.includes(destProv)) {
        // Exact province match — highest priority
        bestScore = Math.max(bestScore, 100);
      } else if (!destProv) {
        // Province-level zone but Shopify didn't send province info
        bestScore = Math.max(bestScore, 50);
      }
      // If destProv is set but NOT in the list → score stays -1 (no match)
      // This is intentional: a TN order should NOT match a zone with [KA, MH, etc.]
      continue;
    }

    // Country-level match (all provinces included)
    bestScore = Math.max(bestScore, 60);
  }

  return bestScore;
}

/* ── Logger factory ──────────────────────────────────────────────────── */

/**
 * Create a tagged logger that optionally writes to a file and console.
 *
 * File logging is enabled when `process.env.DEBUG_SHIPPING` is truthy
 * (recommended: set `DEBUG_SHIPPING=true` in .env for local dev).
 *
 * @param {string} tag  - Prefix tag for console output, e.g. "[CARRIER]"
 * @returns {{ log: (msg: string | object) => Promise<void> }}
 */
export function createLogger(tag = "[CARRIER]") {
  const debugEnabled = process.env.DEBUG_SHIPPING === "true";
  const logFile = () => path.join(process.cwd(), "shipping_debug.log");

  return {
    async log(msg) {
      const line = `[${new Date().toISOString()}] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`;

      if (debugEnabled) {
        try {
          await fs.appendFile(logFile(), line);
        } catch {
          /* ignore file errors */
        }
      }

      console.log(tag, line.trim());
    },
  };
}
