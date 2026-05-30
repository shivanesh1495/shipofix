/**
 * Razorpay webhook endpoint  →  POST /webhooks/razorpay
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DORMANT until BILLING_ENABLED=true. While billing is off this returns 200
 *  and does nothing, so a stray/misconfigured webhook can never affect state.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is the ONLY place a paid plan is granted when billing is on, and it is
 * the security boundary: we trust an event ONLY after its HMAC signature
 * verifies against RAZORPAY_WEBHOOK_SECRET. An attacker cannot POST a fake
 * "payment succeeded" here to unlock a paid plan, because they can't forge the
 * signature without the secret.
 *
 * Register this URL in the Razorpay dashboard (Settings → Webhooks) for at
 * least these events:
 *   subscription.activated, subscription.charged,
 *   subscription.cancelled, subscription.halted, subscription.completed,
 *   subscription.pending
 */

import {
  isBillingEnabled,
  activateSubscription,
  deactivateSubscription,
  markSubscriptionPending,
  findShopBySubscriptionId,
} from "../lib/billing.server.js";
import { verifyWebhookSignature } from "../lib/razorpay.server.js";

const ok = (body = "ok") => new Response(body, { status: 200 });

export const action = async ({ request }) => {
  // Billing off → ignore silently. Never mutate state from a dormant feature.
  if (!isBillingEnabled()) return ok("billing disabled");

  // Read the RAW body — signature is computed over the exact bytes.
  const rawBody = await request.text();
  const signature = request.headers.get("X-Razorpay-Signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const event = payload?.event;
  const subEntity = payload?.payload?.subscription?.entity;
  const subscriptionId = subEntity?.id;

  // Resolve which shop this belongs to: prefer our stored mapping (the event's
  // subscription id matches the shop's CURRENT subscription), fall back to the
  // `notes.shop` we attached at creation time.
  let shop = null;
  let resolvedByCurrentId = false;
  if (subscriptionId) {
    const row = await findShopBySubscriptionId(subscriptionId);
    if (row?.shop) {
      shop = row.shop;
      resolvedByCurrentId = true;
    }
  }
  if (!shop) shop = subEntity?.notes?.shop || null;

  // No shop to act on — acknowledge so Razorpay stops retrying.
  if (!shop) return ok("no shop");

  const plan = subEntity?.notes?.plan || null;
  // Razorpay sends unix seconds; convert to Date when present.
  const periodEnd = subEntity?.current_end
    ? new Date(subEntity.current_end * 1000)
    : undefined;

  try {
    switch (event) {
      case "subscription.activated":
      case "subscription.charged":
        await activateSubscription(shop, {
          plan: plan || undefined,
          subscriptionId,
          currentPeriodEnd: periodEnd,
        });
        break;

      case "subscription.pending":
        if (plan) await markSubscriptionPending(shop, { plan, subscriptionId });
        break;

      case "subscription.halted":
      case "subscription.cancelled":
      case "subscription.completed":
        /* Only revoke if this event is for the shop's CURRENT subscription.
           Without this, a late cancellation for an OLD subscription (after the
           merchant already re-subscribed) would wrongly revoke their new,
           active plan. A notes.shop-only match isn't enough here. */
        if (resolvedByCurrentId) {
          await deactivateSubscription(shop, {
            status: event === "subscription.cancelled" ? "cancelled" : "halted",
          });
        }
        break;

      default:
        // Unhandled event — acknowledge so it isn't retried forever.
        break;
    }
  } catch (err) {
    // Log and 500 so Razorpay retries (it backs off and re-delivers).
    console.error(`[razorpay-webhook] ${event} for ${shop} failed:`, err);
    return new Response("Handler error", { status: 500 });
  }

  return ok();
};

/* No loader/GET — webhooks are POST-only. A GET returns 405 by default. */
