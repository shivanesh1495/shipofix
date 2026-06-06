/**
 * Shopify Billing webhook  →  POST /webhooks/app/subscriptions_update
 *
 * Topic: app_subscriptions/update — fires whenever an AppSubscription's status
 * changes (created/approved, cancelled, declined, expired, frozen, …).
 *
 * This is a best-effort fast path that keeps AppSetting.plan in sync when a
 * change happens OUTSIDE the app — e.g. the merchant cancels the subscription
 * from the Shopify admin, or a renewal fails. The authoritative reconcile still
 * runs on every dashboard load (reconcileEntitlement), so even if this webhook
 * is missed the entitlement self-heals on the next visit.
 *
 * `authenticate.webhook` verifies the HMAC signature, so an attacker cannot
 * forge a "subscription active" event to unlock a paid plan.
 */

import { authenticate } from "../shopify.server";
import { setShopPlan } from "../lib/plan.server.js";
import { activePlanFromAdmin } from "../lib/billing.server.js";
import { PLANS } from "../lib/plan.js";

export const action = async ({ request }) => {
  const { shop, admin, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  /* The webhook payload only describes the single subscription that changed,
     which can be stale relative to the shop's real state (e.g. a late
     cancellation for an OLD subscription after the merchant re-subscribed). To
     stay correct, ask Shopify for the shop's CURRENT active subscriptions and
     cache the resulting plan. Without an admin client (no stored session) we
     can't query — skip and let the next dashboard load reconcile. */
  if (admin) {
    try {
      const activePaid = await activePlanFromAdmin(admin);
      await setShopPlan(shop, activePaid || PLANS.FREE);
    } catch (err) {
      console.error(
        `[app_subscriptions/update] reconcile for ${shop} failed:`,
        err?.message,
      );
    }
  }

  return new Response();
};
