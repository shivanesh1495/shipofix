/**
 * Shipping rate calculator strategy map.
 *
 * Each calculator is a pure function:
 *   (rules, totalKg, totalPrice, totalItems) => { rate, serviceName, serviceCode, description }
 *
 * Returns `null` for `rate` when no matching band is found.
 */

/* ── Helpers ──────────────────────────────────────────────────────────── */

function parseOptionalMax(value) {
  if (value === null || value === undefined || value === "") return Infinity;
  return parseFloat(value);
}

/** Format a number for display (e.g. 10583.16 → "10,583.16") */
function fmt(n) {
  if (n === null || n === undefined) return "0";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ── Calculators ─────────────────────────────────────────────────────── */

const calculators = {
  STANDARD_TIER(rules /*, totalKg, totalPrice */) {
    const rate = parseFloat(rules.flat_rate || 0);
    return {
      rate,
      serviceName: "Standard Shipping",
      serviceCode: "standard_tier",
      description: `Flat rate: ${fmt(rate)}`,
    };
  },

  WEIGHT_RANGE(rules, totalKg /*, totalPrice */) {
    const bands = Array.isArray(rules) ? rules : [];
    const matchedBand = bands.find((b) => {
      const min = parseFloat(b.min_kg || 0);
      const max = parseOptionalMax(b.max_kg);
      return totalKg >= min && totalKg <= max;
    });

    const rate = matchedBand ? parseFloat(matchedBand.rate || 0) : null;
    const minKg = matchedBand ? parseFloat(matchedBand.min_kg || 0) : 0;
    const maxKg = matchedBand ? parseOptionalMax(matchedBand.max_kg) : 0;
    const maxLabel = maxKg === Infinity ? "+" : `–${maxKg}`;
    return {
      rate,
      serviceName: "Weight Based Shipping",
      serviceCode: "weight_range",
      description: rate !== null
        ? `Weight ${totalKg.toFixed(2)}kg (slab ${minKg}${maxLabel}kg) = ${fmt(rate)}`
        : `No slab for ${totalKg.toFixed(2)}kg`,
    };
  },

  PRICE_RANGE(rules, _totalKg, totalPrice) {
    const bands = Array.isArray(rules) ? rules : [];
    const matchedBand = bands.find((b) => {
      const min = parseFloat(b.min_total || 0);
      const max = parseOptionalMax(b.max_total);
      return totalPrice >= min && totalPrice <= max;
    });

    const rate = matchedBand ? parseFloat(matchedBand.rate || 0) : null;
    const minT = matchedBand ? parseFloat(matchedBand.min_total || 0) : 0;
    const maxT = matchedBand ? parseOptionalMax(matchedBand.max_total) : 0;
    const maxLabel = maxT === Infinity ? "+" : `–${fmt(maxT)}`;
    return {
      rate,
      serviceName: "Price Based Shipping",
      serviceCode: "price_range",
      description: rate !== null
        ? `Order ${fmt(totalPrice)} (slab ${fmt(minT)}${maxLabel}) = ${fmt(rate)}`
        : `No slab for ${fmt(totalPrice)}`,
    };
  },

  WEIGHT_RANGE_PER_KG(rules, totalKg /*, totalPrice */) {
    const bands = Array.isArray(rules) ? rules : [];
    const matchedBand = bands.find((b) => {
      const min = parseFloat(b.min_kg || 0);
      const max = parseOptionalMax(b.max_kg);
      return totalKg >= min && totalKg <= max;
    });

    if (!matchedBand) {
      return {
        rate: null,
        serviceName: "Weight Tiered Per-KG Shipping",
        serviceCode: "weight_range_per_kg",
        description: `No slab for ${totalKg.toFixed(2)}kg`,
      };
    }

    const ratePerKg = parseFloat(matchedBand.rate_per_kg || 0);
    const minKg = parseFloat(matchedBand.min_kg || 0);
    const maxKg = parseOptionalMax(matchedBand.max_kg);
    const maxLabel = maxKg === Infinity ? "+" : `–${maxKg}`;
    const rate = totalKg * ratePerKg;
    return {
      rate,
      serviceName: "Weight Tiered Per-KG Shipping",
      serviceCode: "weight_range_per_kg",
      description: `${totalKg.toFixed(2)}kg (slab ${minKg}${maxLabel}kg) × ${fmt(ratePerKg)}/kg = ${fmt(rate)}`,
    };
  },

  WEIGHT_MULTIPLIER(rules, totalKg /*, totalPrice */) {
    const ratePerKg = parseFloat(rules.rate_per_kg || 0);
    const rate = totalKg * ratePerKg;
    return {
      rate,
      serviceName: "Calculated Shipping(Based on Weight)",
      serviceCode: "weight_multiplier",
      description: `${totalKg.toFixed(2)}kg × ${fmt(ratePerKg)}/kg = ${fmt(rate)}`,
    };
  },

  PRICE_MULTIPLIER(rules, _totalKg, totalPrice) {
    const percentage = parseFloat(rules.percentage || 0);
    const pct = (percentage * 100).toFixed(1).replace(/\.0$/, "");
    const rate = totalPrice * percentage;
    return {
      rate,
      serviceName: "Calculated Shipping(Based on TotalPrice)",
      serviceCode: "price_multiplier",
      description: `${fmt(totalPrice)} × ${pct}% = ${fmt(rate)}`,
    };
  },

  ITEM_MULTIPLIER(rules, _totalKg, _totalPrice, totalItems) {
    const ratePerItem = parseFloat(rules.rate_per_item || 0);
    const rate = totalItems * ratePerItem;
    return {
      rate,
      serviceName: "Calculated Shipping(Based on No. of Items)",
      serviceCode: "item_multiplier",
      description: `${totalItems} item${totalItems !== 1 ? "s" : ""} × ${fmt(ratePerItem)}/item = ${fmt(rate)}`,
    };
  },
};

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * The set of logicType values that have a real calculator behind them.
 * Anything else (e.g. the "DEFAULT" placeholder auto-created for un-priced
 * Shopify zones, or a stale/unknown type) can only ever return a null rate,
 * so it must NOT participate in checkout matching — otherwise it can shadow a
 * properly-configured rule and leave the customer with no shipping option.
 */
export const PRICEABLE_LOGIC_TYPES = new Set(Object.keys(calculators));

/** @returns {boolean} true if `logicType` maps to a real rate calculator. */
export function isPriceableLogicType(logicType) {
  return PRICEABLE_LOGIC_TYPES.has(logicType);
}

/**
 * Calculate a shipping rate for the given logic type.
 *
 * @param {string} logicType  - One of the keys in `calculators`
 * @param {object|Array} rules - Parsed rulesJson for the matched zone rule
 * @param {number} totalKg    - Total cart weight in kilograms
 * @param {number} totalPrice - Total cart price in major currency units
 * @param {number} totalItems - Total number of items in the cart
 * @returns {{ rate: number|null, serviceName: string, serviceCode: string, description: string } | null}
 */
export function calculateRate(logicType, rules, totalKg, totalPrice, totalItems) {
  const calc = calculators[logicType];
  if (!calc) return null;
  return calc(rules, totalKg, totalPrice, totalItems);
}
