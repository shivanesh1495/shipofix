/**
 * Plan / tier helpers — SERVER-ONLY (imports prisma).
 *
 * The pure constants and capability checks live in `./plan.js` so the client
 * bundle can use them without dragging prisma in. This module adds the two
 * helpers that actually touch the database — read and write the chosen tier —
 * and re-exports the shared pieces so server code can import everything from
 * one place if it prefers.
 *
 * Plan choice is UI-only for now — no Shopify Billing API call. The picker
 * page (/app/subscription) writes the chosen tier to AppSetting and the rest
 * of the app reads it on every loader.
 */

import prisma from "../db.server";
import { VALID_PLANS } from "./plan.js";

export {
  PLANS,
  VALID_PLANS,
  FREE_ZONE_LIMIT,
  canBulkEdit,
  canCreateAnotherZone,
  zoneLimitFor,
} from "./plan.js";

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
