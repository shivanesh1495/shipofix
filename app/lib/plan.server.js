/**
 * Plan / tier helpers — server-only.
 *
 * Three tiers, persisted on AppSetting.plan:
 *   - free      → up to FREE_ZONE_LIMIT zones, no bulk-edit Excel
 *   - advanced  → unlimited zones (manual one-by-one only), no bulk-edit Excel
 *   - premium   → everything, including bulk-edit Excel
 *
 * Plan choice is UI-only for now — no Shopify Billing API call. The picker
 * page (/app/subscription) writes the chosen tier to AppSetting and the rest
 * of the app reads it on every loader.
 */

import prisma from "../db.server";

export const PLANS = {
  FREE: "free",
  ADVANCED: "advanced",
  PREMIUM: "premium",
};

export const VALID_PLANS = new Set(Object.values(PLANS));

/** Max number of zones a Free-plan shop may own. */
export const FREE_ZONE_LIMIT = 2;

/**
 * Read the current plan for a shop. Returns null if the shop hasn't picked
 * one yet — callers use that to redirect into the picker.
 */
export async function getShopPlan(shop) {
  if (!shop) return null;
  const row = await prisma.appSetting.findUnique({ where: { shop } });
  const plan = row?.plan;
  return VALID_PLANS.has(plan) ? plan : null;
}

/** Write (or upsert) the plan choice. */
export async function setShopPlan(shop, plan) {
  if (!shop) throw new Error("setShopPlan: missing shop");
  if (!VALID_PLANS.has(plan)) throw new Error(`setShopPlan: invalid plan "${plan}"`);
  await prisma.appSetting.upsert({
    where: { shop },
    update: { plan },
    create: { shop, plan },
  });
}

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
