/**
 * Billing enforcement layer — SERVER-ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THE MASTER SWITCH IS `BILLING_ENABLED`.
 *
 *    BILLING_ENABLED unset / "false"  → app works EXACTLY as today. Every
 *        function here degrades to "allow everything"; Razorpay is never
 *        contacted; the picker grants plans for free. This is the default.
 *
 *    BILLING_ENABLED = "true"          → paid tiers (advanced/premium) require
 *        a verified Razorpay subscription. A paid plan is written to
 *        AppSetting.plan ONLY after Razorpay confirms payment (webhook /
 *        verified callback), so every existing `getShopPlan` gate across the
 *        app — dashboard access, zone limits, bulk-edit — automatically
 *        enforces payment. No per-route trust required.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * To turn billing on:
 *   1. Set BILLING_ENABLED=true and the RAZORPAY_* vars (see razorpay.server.js).
 *   2. Run `npx prisma generate` (the billing columns are already migrated).
 *   3. Create the Razorpay Plans ($5 / $10 USD, monthly) and put their ids in
 *      RAZORPAY_PLAN_ADVANCED / RAZORPAY_PLAN_PREMIUM.
 *   4. Register the webhook (POST {APP_URL}/webhooks/razorpay) in the Razorpay
 *      dashboard for subscription.* and payment.* events, using
 *      RAZORPAY_WEBHOOK_SECRET.
 */

import process from "node:process";
import prisma from "../db.server";
import { PLANS } from "./plan.js";
import { getShopPlan } from "./plan.server.js";

/* ── Master switch ────────────────────────────────────────────────────── */

export function isBillingEnabled() {
  return process.env.BILLING_ENABLED === "true";
}

/* ── Pricing config (USD, monthly) ────────────────────────────────────── */

/**
 * Display/verification pricing. The authoritative amount lives on the Razorpay
 * Plan you create in the dashboard; these mirror it for UI and sanity checks.
 * Amounts are in the currency's smallest unit (USD cents).
 */
export const BILLING_PRICING = {
  [PLANS.ADVANCED]: {
    amount: Number(process.env.BILLING_ADVANCED_AMOUNT || 500), // $5.00
    currency: process.env.BILLING_CURRENCY || "USD",
  },
  [PLANS.PREMIUM]: {
    amount: Number(process.env.BILLING_PREMIUM_AMOUNT || 1000), // $10.00
    currency: process.env.BILLING_CURRENCY || "USD",
  },
};

/** True for tiers that cost money (and therefore require a subscription). */
export function isPaidPlan(plan) {
  return plan === PLANS.ADVANCED || plan === PLANS.PREMIUM;
}

/* ── Billing state (DB) ───────────────────────────────────────────────── */

/**
 * Read the raw billing columns for a shop.
 * @returns {Promise<{billingStatus, billingPlan, razorpaySubscriptionId, razorpayCustomerId, billingCurrentPeriodEnd}|null>}
 */
export async function getBillingState(shop) {
  if (!shop) return null;
  return prisma.appSetting.findUnique({
    where: { shop },
    select: {
      billingStatus: true,
      billingPlan: true,
      razorpaySubscriptionId: true,
      razorpayCustomerId: true,
      billingCurrentPeriodEnd: true,
    },
  });
}

/** True if the shop currently has an active subscription for `plan`. */
export async function hasActiveSubscription(shop, plan) {
  const st = await getBillingState(shop);
  return st?.billingStatus === "active" && st?.billingPlan === plan;
}

/* ── State transitions (only called from verified server paths) ───────── */

/**
 * Record that a subscription was created and is awaiting first payment.
 * Does NOT grant the plan — entitlement comes only on activation.
 */
export async function markSubscriptionPending(shop, { plan, subscriptionId, customerId }) {
  await prisma.appSetting.upsert({
    where: { shop },
    update: {
      billingStatus: "pending",
      billingPlan: plan,
      razorpaySubscriptionId: subscriptionId,
      razorpayCustomerId: customerId ?? undefined,
      billingUpdatedAt: new Date(),
    },
    create: {
      shop,
      billingStatus: "pending",
      billingPlan: plan,
      razorpaySubscriptionId: subscriptionId,
      razorpayCustomerId: customerId ?? null,
      billingUpdatedAt: new Date(),
    },
  });
}

/**
 * Grant the paid plan after Razorpay confirms payment. This is the ONLY place
 * a paid tier is written to AppSetting.plan when billing is on.
 */
export async function activateSubscription(shop, { plan, subscriptionId, currentPeriodEnd } = {}) {
  // upsert (not update) so a webhook that arrives before any AppSetting row
  // exists for the shop still succeeds instead of throwing.
  await prisma.appSetting.upsert({
    where: { shop },
    update: {
      plan,
      billingStatus: "active",
      billingPlan: plan,
      ...(subscriptionId ? { razorpaySubscriptionId: subscriptionId } : {}),
      ...(currentPeriodEnd ? { billingCurrentPeriodEnd: currentPeriodEnd } : {}),
      billingUpdatedAt: new Date(),
    },
    create: {
      shop,
      plan,
      billingStatus: "active",
      billingPlan: plan,
      razorpaySubscriptionId: subscriptionId ?? null,
      billingCurrentPeriodEnd: currentPeriodEnd ?? null,
      billingUpdatedAt: new Date(),
    },
  });
}

/**
 * Revoke paid access (cancellation / failed renewal / halt). Drops the shop to
 * the Free tier so they keep basic access rather than being locked out.
 */
export async function deactivateSubscription(shop, { status = "cancelled" } = {}) {
  await prisma.appSetting.update({
    where: { shop },
    data: {
      plan: PLANS.FREE,
      billingStatus: status,
      billingUpdatedAt: new Date(),
    },
  });
}

/** Find the shop a Razorpay subscription belongs to (webhook reconciliation). */
export async function findShopBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  const row = await prisma.appSetting.findFirst({
    where: { razorpaySubscriptionId: subscriptionId },
    select: { shop: true, billingPlan: true },
  });
  return row;
}

/* ── The access resolver every loader should use ──────────────────────── */

/**
 * Resolve the plan a shop is actually ENTITLED to right now.
 *
 *   billing off            → the stored plan, verbatim (current behaviour).
 *   billing on, free/null  → as stored.
 *   billing on, paid tier  → that tier ONLY if a matching subscription is
 *                            active; otherwise gracefully degrade to Free so a
 *                            lapsed/spoofed paid plan can never unlock paid
 *                            features.
 *
 * Use this instead of getShopPlan in loaders/actions that gate features so the
 * enforcement is centralised and tamper-proof.
 *
 * @returns {Promise<string|null>}
 */
export async function getEntitledPlan(shop) {
  const stored = await getShopPlan(shop);
  if (!isBillingEnabled()) return stored;
  if (!stored || stored === PLANS.FREE) return stored;
  // Paid tier requires a live subscription.
  return (await hasActiveSubscription(shop, stored)) ? stored : PLANS.FREE;
}
