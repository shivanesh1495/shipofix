/**
 * Razorpay integration — SERVER-ONLY, REST-based (no `razorpay` npm package).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DORMANT BY DEFAULT. Nothing in here runs unless the billing layer is
 *  switched on with BILLING_ENABLED=true (see app/lib/billing.server.js).
 *  When billing is off, this module is never imported into a live code path,
 *  so the app behaves exactly as it does today.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * We talk to Razorpay over its HTTPS REST API using `fetch` + HTTP Basic auth
 * (key_id:key_secret). That keeps the dependency surface at zero — no SDK to
 * install, audit, or keep patched — and signature verification uses Node's
 * built-in crypto. This is the same wire protocol the official SDK uses.
 *
 * Docs: https://razorpay.com/docs/api/  ·  Subscriptions:
 *       https://razorpay.com/docs/api/payments/subscriptions/
 *
 * Required environment variables (only when BILLING_ENABLED=true):
 *   RAZORPAY_KEY_ID         - API key id          (rzp_live_xxx / rzp_test_xxx)
 *   RAZORPAY_KEY_SECRET     - API key secret       (kept server-side only)
 *   RAZORPAY_WEBHOOK_SECRET - Webhook signing secret you set in the dashboard
 *   RAZORPAY_PLAN_ADVANCED  - Plan id for the $5 tier  (plan_xxx)
 *   RAZORPAY_PLAN_PREMIUM   - Plan id for the $10 tier (plan_xxx)
 */

import crypto from "crypto";
import { Buffer } from "node:buffer";
import process from "node:process";

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/* ── Config helpers ───────────────────────────────────────────────────── */

/** Throw a clear error if a required Razorpay env var is missing. */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[razorpay] Missing required env var ${name}. Billing is enabled but Razorpay isn't fully configured.`,
    );
  }
  return v;
}

export function getKeyId() {
  return requireEnv("RAZORPAY_KEY_ID");
}

/** Map an internal paid plan name to its configured Razorpay Plan id. */
export function getRazorpayPlanId(plan) {
  if (plan === "advanced") return requireEnv("RAZORPAY_PLAN_ADVANCED");
  if (plan === "premium") return requireEnv("RAZORPAY_PLAN_PREMIUM");
  throw new Error(`[razorpay] No Razorpay plan id configured for "${plan}".`);
}

/* ── Low-level REST call ──────────────────────────────────────────────── */

/**
 * Make an authenticated Razorpay REST call.
 * @param {string} path   - e.g. "/subscriptions"
 * @param {object} [opts] - { method, body }
 * @returns {Promise<object>} parsed JSON
 * @throws on non-2xx with the Razorpay error message
 */
async function razorpayFetch(path, { method = "GET", body } = {}) {
  const keyId = requireEnv("RAZORPAY_KEY_ID");
  const keySecret = requireEnv("RAZORPAY_KEY_SECRET");
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  const res = await fetch(`${RAZORPAY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.error?.description || json?.error?.reason || `HTTP ${res.status}`;
    throw new Error(`[razorpay] ${method} ${path} failed: ${msg}`);
  }
  return json;
}

/* ── Subscriptions API ────────────────────────────────────────────────── */

/**
 * Create a recurring subscription for a paid plan. Razorpay returns a
 * `short_url` we redirect the merchant to so they can authorise the mandate
 * and make the first payment. We attach `notes.shop` so the webhook can
 * reconcile the event back to the shop even if our DB write raced.
 *
 * @param {object} args
 * @param {string} args.plan  - "advanced" | "premium"
 * @param {string} args.shop  - shop domain, stored in notes for reconciliation
 * @param {number} [args.totalCount] - number of billing cycles (default 120 = 10y)
 * @returns {Promise<{ id: string, short_url: string, status: string }>}
 */
export async function createSubscription({ plan, shop, totalCount = 120 }) {
  const planId = getRazorpayPlanId(plan);
  const sub = await razorpayFetch("/subscriptions", {
    method: "POST",
    body: {
      plan_id: planId,
      total_count: totalCount,
      customer_notify: 1,
      notes: { shop, plan },
    },
  });
  return sub;
}

/** Fetch a subscription's current state from Razorpay. */
export async function fetchSubscription(subscriptionId) {
  return razorpayFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/**
 * Cancel a subscription. `cancelAtCycleEnd: false` cancels immediately;
 * pass true to let the merchant keep access until the period they paid for
 * ends.
 */
export async function cancelSubscription(subscriptionId, { cancelAtCycleEnd = false } = {}) {
  return razorpayFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: "POST",
    body: { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 },
  });
}

/* ── Signature verification (the security boundary) ───────────────────── */

/** Constant-time compare of two hex/base64 strings. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a Razorpay WEBHOOK signature.
 * Razorpay signs the raw request body with the webhook secret (HMAC-SHA256,
 * hex). Reject anything that doesn't match — this is what stops an attacker
 * POSTing a fake "payment succeeded" event to grant themselves a paid plan.
 *
 * @param {string} rawBody          - exact raw request body string
 * @param {string} signatureHeader  - value of `X-Razorpay-Signature`
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, signatureHeader);
}

/**
 * Verify a Razorpay CHECKOUT callback signature for subscriptions.
 * After the merchant pays, Razorpay's checkout returns razorpay_payment_id,
 * razorpay_subscription_id and razorpay_signature. The signature is
 * HMAC-SHA256(payment_id + "|" + subscription_id, key_secret), hex.
 *
 * @returns {boolean}
 */
export function verifySubscriptionPaymentSignature({ paymentId, subscriptionId, signature }) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret || !paymentId || !subscriptionId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${paymentId}|${subscriptionId}`, "utf8")
    .digest("hex");
  return safeEqual(expected, signature);
}
