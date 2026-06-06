/**
 * /app/subscription — plan picker page.
 *
 * Shown automatically as the "first page" when a shop hasn't selected a plan
 * yet (the /app loader redirects here). Plans are charged through the
 * **Shopify Billing API**:
 *
 *   • Free      — granted instantly (no charge). Any active paid subscription
 *                 is cancelled first.
 *   • Advanced/ — `billing.request` creates an AppSubscription and the merchant
 *     Premium     is redirected to Shopify's NATIVE approval/confirmation
 *                 screen. The tier is granted only after Shopify confirms the
 *                 charge (reconciled on return + via the
 *                 app_subscriptions/update webhook).
 *
 * There is no off-platform billing and no client-trusted "switch the plan on
 * the UI" path — selecting a paid tier always leaves the app for Shopify's
 * approval screen.
 */

import { redirect, useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Divider,
  Icon,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { setShopPlan } from "../lib/plan.server.js";
import { FREE_ZONE_LIMIT, PLANS, VALID_PLANS } from "../lib/plan.js";
import {
  isBillingTest,
  billingPlanName,
  BILLING_PRICING,
  reconcileEntitlement,
} from "../lib/billing.server.js";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  /* Reconcile against Shopify so the "Current plan" badge reflects the real
     subscription state (e.g. after returning from the approval screen). */
  const currentPlan = await reconcileEntitlement(billing, session.shop);
  return { currentPlan, pricing: BILLING_PRICING };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "").trim();

  if (!VALID_PLANS.has(plan)) {
    return { success: false, error: `Unknown plan "${plan}".` };
  }

  /* Preserve the embedded ?shop=&host=&embedded= so the iframe keeps Shopify
     context on any in-app redirect. */
  const search = new URL(request.url).search;
  const isTest = isBillingTest();

  /* ── Free → cancel any paid subscription, then grant Free instantly. ──── */
  if (plan === PLANS.FREE) {
    try {
      const check = await billing.check({
        plans: [billingPlanName(PLANS.ADVANCED), billingPlanName(PLANS.PREMIUM)],
        isTest,
      });
      for (const sub of check.appSubscriptions || []) {
        await billing.cancel({ subscriptionId: sub.id, isTest, prorate: true });
      }
    } catch (err) {
      console.error("[subscription] cancel on downgrade failed:", err?.message);
    }
    await setShopPlan(shop, PLANS.FREE);
    return redirect(`/app${search}`);
  }

  /* ── Paid tier ──────────────────────────────────────────────────────── */
  // Already subscribed to this exact tier → just sync and go to the dashboard.
  try {
    const check = await billing.check({
      plans: [billingPlanName(plan)],
      isTest,
    });
    if (check.hasActivePayment) {
      await setShopPlan(shop, plan);
      return redirect(`/app${search}`);
    }
  } catch (err) {
    console.error("[subscription] pre-check failed:", err?.message);
  }

  /* Create the subscription and hand off to Shopify's NATIVE approval screen.
     `billing.request` THROWS a redirect (out of the embedded iframe, via App
     Bridge) to the confirmation URL — it never returns. The plan is NOT granted
     here; it's granted on return once Shopify confirms the charge. */
  return billing.request({
    plan: billingPlanName(plan),
    isTest,
    // returnUrl omitted → defaults to the embedded app home, which reconciles
    // the now-active subscription into AppSetting.plan on load.
  });
};

const PLAN_CARDS = [
  {
    id: PLANS.FREE,
    name: "Free",
    blurb: "Try Shipofix on a small set of zones.",
    features: [
      `Up to ${FREE_ZONE_LIMIT} shipping zones`,
      "All 7 pricing models",
      "Edit each zone manually",
      "No Excel bulk editing",
    ],
    cta: "Start free",
    badge: null,
  },
  {
    id: PLANS.ADVANCED,
    name: "Advanced",
    blurb: "Unlimited zones — manual editing only.",
    features: [
      "Unlimited shipping zones",
      "All 7 pricing models",
      "Edit each zone manually",
      "No Excel bulk editing",
    ],
    cta: "Choose Advanced",
    badge: "Most popular",
  },
  {
    id: PLANS.PREMIUM,
    name: "Premium",
    blurb: "Everything — including the Excel bulk-edit workflow.",
    features: [
      "Unlimited shipping zones",
      "All 7 pricing models",
      "Edit each zone manually",
      "Excel bulk edit (download · edit · upload)",
    ],
    cta: "Choose Premium",
    badge: null,
  },
];

/** Render a price from a {amount(dollars), currency} config. */
function formatPrice(cfg) {
  if (!cfg) return "$0";
  const symbol = cfg.currency === "USD" ? "$" : `${cfg.currency} `;
  return `${symbol}${cfg.amount}`;
}

export default function SubscriptionPage() {
  const { currentPlan, pricing } = useLoaderData();
  const fetcher = useFetcher();

  const submittingPlan =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("plan") || "")
      : null;

  const checkoutError = fetcher.data?.success === false ? fetcher.data.error : null;

  return (
    <Page>
      <Box paddingBlockEnd="800">
        <BlockStack gap="500">
          <Box paddingBlockEnd="200">
            <BlockStack gap="100">
              <Text variant="headingXl" as="h1">
                Choose your Shipofix plan
              </Text>
              <Text tone="subdued" variant="bodyLg">
                Pick a tier to unlock the matching set of features. Paid plans
                are billed monthly through Shopify — choosing one takes you to
                Shopify&apos;s secure approval screen to confirm the
                subscription. You can change or cancel any time.
              </Text>
            </BlockStack>
          </Box>

          {checkoutError && (
            <Banner tone="critical" title="Couldn't start checkout">
              <p>{checkoutError}</p>
            </Banner>
          )}

          <div className="plan-card-grid">
            {PLAN_CARDS.map((p) => {
              const isCurrent = currentPlan === p.id;
              const isPopular = p.badge === "Most popular";
              const priceLabel =
                p.id === PLANS.FREE ? "$0" : formatPrice(pricing?.[p.id]);
              return (
                <div
                  key={p.id}
                  className={
                    "plan-card" + (isPopular ? " plan-card--popular" : "")
                  }
                >
                  {p.badge && (
                    <div className="plan-card-badge">
                      <Badge tone="success">{p.badge}</Badge>
                    </div>
                  )}
                  <Box padding="600">
                    <BlockStack gap="400">
                      <BlockStack gap="100">
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                        >
                          <Text variant="headingLg" as="h2">
                            {p.name}
                          </Text>
                          {isCurrent && <Badge tone="info">Current plan</Badge>}
                        </InlineStack>
                        <Text tone="subdued" variant="bodyMd">
                          {p.blurb}
                        </Text>
                      </BlockStack>

                      <InlineStack
                        align="start"
                        blockAlign="baseline"
                        gap="100"
                      >
                        <Text variant="heading2xl" as="p">
                          {priceLabel}
                        </Text>
                        <Text tone="subdued" variant="bodyMd">
                          / month
                        </Text>
                      </InlineStack>

                      <Divider />

                      <BlockStack gap="200">
                        {p.features.map((f) => (
                          <InlineStack key={f} gap="200" align="start">
                            <span style={{ color: "#008060" }}>
                              <Icon source={CheckIcon} />
                            </span>
                            <Text variant="bodyMd">{f}</Text>
                          </InlineStack>
                        ))}
                      </BlockStack>

                      <Box paddingBlockStart="200">
                        <fetcher.Form method="POST">
                          <input type="hidden" name="plan" value={p.id} />
                          <Button
                            submit
                            fullWidth
                            size="large"
                            variant={isPopular ? "primary" : "secondary"}
                            disabled={isCurrent || submittingPlan !== null}
                            loading={submittingPlan === p.id}
                          >
                            {isCurrent
                              ? "You're on this plan"
                              : p.id !== PLANS.FREE
                                ? `${p.cta} — confirm on Shopify`
                                : p.cta}
                          </Button>
                        </fetcher.Form>
                      </Box>
                    </BlockStack>
                  </Box>
                </div>
              );
            })}
          </div>

          <Box paddingBlockStart="400">
            <Text tone="subdued" variant="bodySm">
              Plans control how many shipping zones you can create and whether
              the Excel bulk-edit workflow is available. The carrier service,
              all 7 pricing models, and your existing zones stay available
              regardless of tier — only new actions are gated.
            </Text>
          </Box>
        </BlockStack>
      </Box>
    </Page>
  );
}
