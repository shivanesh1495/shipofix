/**
 * Plan / tier definitions and capability checks — ISOMORPHIC (safe on both
 * client and server).
 *
 * This module holds ONLY pure data and pure functions: no prisma, no Node
 * APIs, no secrets. That's deliberate — both server loaders/actions AND the
 * client components (the Plan strip, the subscription picker, tab gating)
 * need these constants and capability checks, so they must live in a module
 * that survives the client bundle. The prisma-backed read/write helpers live
 * separately in `plan.server.js`.
 *
 * Three tiers, persisted on AppSetting.plan:
 *   - free      → up to FREE_ZONE_LIMIT zones, no bulk-edit Excel
 *   - advanced  → unlimited zones (manual one-by-one only), no bulk-edit Excel
 *   - premium   → everything, including bulk-edit Excel
 *
 * Plan choice is UI-only for now — no Shopify Billing API call.
 */

export const PLANS = {
  FREE: "free",
  ADVANCED: "advanced",
  PREMIUM: "premium",
};

export const VALID_PLANS = new Set(Object.values(PLANS));

/** Max number of zones a Free-plan shop may own. */
export const FREE_ZONE_LIMIT = 2;

/* ── Capability checks — single source of truth for tier gating ────────── */

export function canBulkEdit(plan) {
  return plan === PLANS.PREMIUM;
}

export function canCreateAnotherZone(plan, currentZoneCount) {
  if (plan === PLANS.FREE) return currentZoneCount < FREE_ZONE_LIMIT;
  return plan === PLANS.ADVANCED || plan === PLANS.PREMIUM;
}

export function zoneLimitFor(plan) {
  return plan === PLANS.FREE ? FREE_ZONE_LIMIT : null; // null = unlimited
}
