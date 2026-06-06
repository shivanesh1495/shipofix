/**
 * Billing layer — SERVER-ONLY. Backed entirely by the **Shopify Billing API**.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  WHY SHOPIFY BILLING (and not an off-platform processor):
 *  Apps distributed through the Shopify App Store MUST charge through Shopify
 *  App Pricing / the Shopify Billing API. Selecting a paid tier creates an
 *  AppSubscription via `billing.request` and redirects the merchant to
 *  Shopify's native approval screen — the plan is granted ONLY after Shopify
 *  confirms the charge. There is no client-trusted path that grants a paid
 *  tier without an active Shopify subscription.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  AppSetting.plan is the cached entitlement every feature gate reads through
 *  getEntitledPlan(). It is kept in sync with the merchant's real Shopify
 *  subscription state by:
 *    1. reconcileEntitlement() — runs on every dashboard / picker load, calls
 *       billing.check() and writes the authoritative plan. This is tamper-proof
 *       (the truth lives in Shopify) and self-healing (no webhook dependency).
 *    2. the app_subscriptions/update webhook — a best-effort fast path so a
 *       change made outside the app (e.g. a cancellation from the Shopify admin)
 *       is reflected promptly without waiting for the next dashboard load.
 */

import process from "node:process";
import { PLANS } from "./plan.js";
import { getShopPlan, setShopPlan } from "./plan.server.js";
import { BILLING_ADVANCED, BILLING_PREMIUM } from "../shopify.server";

/* ── Plan ↔ Shopify billing-plan-name mapping ─────────────────────────── */

/** Internal plan key → Shopify billing plan name (config key in shopify.server). */
export const BILLING_PLAN_NAMES = {
  [PLANS.ADVANCED]: BILLING_ADVANCED,
  [PLANS.PREMIUM]: BILLING_PREMIUM,
};

/** All paid Shopify plan names, highest tier last. */
const PAID_PLAN_NAMES = [BILLING_ADVANCED, BILLING_PREMIUM];

const NAME_TO_KEY = {
  [BILLING_ADVANCED]: PLANS.ADVANCED,
  [BILLING_PREMIUM]: PLANS.PREMIUM,
};

/** Shopify billing plan name for an internal paid plan key (or null). */
export function billingPlanName(planKey) {
  return BILLING_PLAN_NAMES[planKey] || null;
}

/** True for tiers that cost money (and therefore require a subscription). */
export function isPaidPlan(plan) {
  return plan === PLANS.ADVANCED || plan === PLANS.PREMIUM;
}

/* ── Test-mode switch ─────────────────────────────────────────────────── */

/**
 * Whether subscriptions are created in Shopify TEST mode (no real charge).
 *
 * Defaults to TEST so App Store reviewers and development/partner stores can
 * approve the native confirmation screen without being charged. Set
 * `BILLING_TEST=false` in production to charge live merchants for real.
 */
export function isBillingTest() {
  return process.env.BILLING_TEST !== "false";
}

/* ── Pricing config (for the picker UI; the charge itself is defined in the
      Shopify billing config in shopify.server.js) ───────────────────────── */

export const BILLING_PRICING = {
  [PLANS.ADVANCED]: { amount: 5, currency: "USD" },
  [PLANS.PREMIUM]: { amount: 10, currency: "USD" },
};

/* ── Reading Shopify's subscription state ─────────────────────────────── */

/**
 * Given a billing.check() result, return the highest paid plan key the shop
 * currently has an active subscription for, or null if none.
 */
export function activePlanFromCheck(check) {
  const subs = check?.appSubscriptions || [];
  const names = new Set(subs.map((s) => s?.name));
  // Walk highest tier first so a shop on the top plan resolves to it.
  for (let i = PAID_PLAN_NAMES.length - 1; i >= 0; i--) {
    const name = PAID_PLAN_NAMES[i];
    if (names.has(name)) return NAME_TO_KEY[name];
  }
  return null;
}

/** GraphQL fallback for contexts (webhooks) that have an admin client but no
    `billing` helper. Returns the highest active paid plan key, or null. */
const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ShipofixActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        name
        status
      }
    }
  }`;

export async function activePlanFromAdmin(admin) {
  const res = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
  const json = await res.json();
  const subs = json?.data?.currentAppInstallation?.activeSubscriptions || [];
  const names = new Set(
    subs.filter((s) => s?.status === "ACTIVE").map((s) => s?.name),
  );
  for (let i = PAID_PLAN_NAMES.length - 1; i >= 0; i--) {
    const name = PAID_PLAN_NAMES[i];
    if (names.has(name)) return NAME_TO_KEY[name];
  }
  return null;
}

/* ── Reconciliation: cache Shopify's truth into AppSetting.plan ────────── */

/**
 * Resolve the plan a shop is ENTITLED to right now by asking Shopify, and cache
 * the result in AppSetting.plan so the per-route feature gates (which read the
 * DB via getEntitledPlan) stay correct.
 *
 *   active paid subscription   → that paid tier (upgraded in DB if needed).
 *   no active subscription, but stored is paid → degrade to Free (a lapsed or
 *                                cancelled subscription can never keep paid
 *                                features).
 *   no active subscription, stored free/null  → stored verbatim (null keeps
 *                                first-time visitors on the picker).
 *
 * On a Billing API error we fall back to the stored plan rather than locking
 * the merchant out of their dashboard.
 *
 * @param {object} billing  the `billing` helper from authenticate.admin()
 * @param {string} shop     shop domain
 * @returns {Promise<string|null>} the entitled plan key
 */
export async function reconcileEntitlement(billing, shop) {
  const stored = await getShopPlan(shop);

  let check;
  try {
    check = await billing.check({
      plans: PAID_PLAN_NAMES,
      isTest: isBillingTest(),
    });
  } catch (err) {
    console.error("[billing] check failed; using stored plan:", err?.message);
    return stored;
  }

  const activePaid = activePlanFromCheck(check);

  if (activePaid) {
    if (stored !== activePaid) await setShopPlan(shop, activePaid);
    return activePaid;
  }

  // No active paid subscription — a previously-paid shop drops to Free.
  if (stored && stored !== PLANS.FREE) {
    await setShopPlan(shop, PLANS.FREE);
    return PLANS.FREE;
  }

  return stored;
}

/* ── The access resolver every feature gate uses ──────────────────────── */

/**
 * The plan a shop is entitled to, read from the cached AppSetting.plan.
 *
 * This is kept accurate by reconcileEntitlement() (run on every dashboard load)
 * and the app_subscriptions/update webhook, so the DB value is a faithful
 * mirror of the shop's live Shopify subscription. Per-route gates (zone limit,
 * bulk-upload) call this; they're always reached via a dashboard load that has
 * already reconciled, so no extra Billing API round-trip is needed here.
 *
 * @returns {Promise<string|null>}
 */
export async function getEntitledPlan(shop) {
  return getShopPlan(shop);
}
