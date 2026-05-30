/**
 * /app/subscription — plan picker page.
 *
 * Shown automatically as the "first page" when a shop hasn't selected a
 * plan yet (the /app loader redirects here). Once a tier is picked, the
 * choice is written to AppSetting.plan and the user lands on /app.
 *
 * No real billing call — this is a pure UI gate that drives feature
 * availability across the rest of the app.
 */

import { useEffect } from "react";
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
import { getShopPlan, setShopPlan } from "../lib/plan.server.js";
import { FREE_ZONE_LIMIT, PLANS, VALID_PLANS } from "../lib/plan.js";
import {
  isBillingEnabled,
  isPaidPlan,
  BILLING_PRICING,
  getBillingState,
  hasActiveSubscription,
  markSubscriptionPending,
} from "../lib/billing.server.js";
import { createSubscription, cancelSubscription } from "../lib/razorpay.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentPlan = await getShopPlan(session.shop);
  /* When billing is on the cards show real prices; off → "$0" as today. */
  return {
    currentPlan,
    billingEnabled: isBillingEnabled(),
    pricing: BILLING_PRICING,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "").trim();

  if (!VALID_PLANS.has(plan)) {
    return { success: false, error: `Unknown plan "${plan}".` };
  }

  /* ── Billing OFF → original behaviour: grant the plan immediately, free. ── */
  if (!isBillingEnabled()) {
    await setShopPlan(shop, plan);
    /* Preserve the embedded ?shop=&host=&embedded= so the iframe keeps
       Shopify context. */
    const search = new URL(request.url).search;
    return redirect(`/app${search}`);
  }

  /* ── Billing ON ──────────────────────────────────────────────────────── */
  const search = new URL(request.url).search;

  // Free is always granted instantly; cancel any paid subscription first.
  if (plan === PLANS.FREE) {
    const st = await getBillingState(shop);
    if (st?.razorpaySubscriptionId && st?.billingStatus === "active") {
      try {
        await cancelSubscription(st.razorpaySubscriptionId);
      } catch (err) {
        console.error("[subscription] cancel on downgrade failed:", err);
      }
    }
    await setShopPlan(shop, PLANS.FREE);
    return redirect(`/app${search}`);
  }

  // Paid tier already active → nothing to pay, go to the dashboard.
  if (isPaidPlan(plan) && (await hasActiveSubscription(shop, plan))) {
    return redirect(`/app${search}`);
  }

  // Switching tiers (or retrying): cancel any existing subscription first so
  // the merchant can never end up paying for two subscriptions at once.
  const prior = await getBillingState(shop);
  if (prior?.razorpaySubscriptionId) {
    try {
      await cancelSubscription(prior.razorpaySubscriptionId);
    } catch (err) {
      console.error("[subscription] cancel of prior subscription failed:", err);
    }
  }

  // Start a Razorpay subscription and hand the checkout URL back to the
  // client. The plan is NOT granted here — only the verified webhook
  // (subscription.activated/charged) grants it.
  try {
    const sub = await createSubscription({ plan, shop });
    await markSubscriptionPending(shop, { plan, subscriptionId: sub.id });
    return { success: true, redirectUrl: sub.short_url };
  } catch (err) {
    console.error("[subscription] create failed:", err);
    return {
      success: false,
      error: "Couldn't start checkout right now. Please try again, or contact support.",
    };
  }
};

const PLAN_CARDS = [
  {
    id: PLANS.FREE,
    name: "Free",
    price: "$0",
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
    price: "$0",
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
    price: "$0",
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

/** Render a price from a {amount(cents), currency} config. */
function formatPrice(cfg) {
  if (!cfg) return "$0";
  const symbol = cfg.currency === "USD" ? "$" : `${cfg.currency} `;
  return `${symbol}${(cfg.amount / 100).toFixed(2).replace(/\.00$/, "")}`;
}

export default function SubscriptionPage() {
  const { currentPlan, billingEnabled, pricing } = useLoaderData();
  const fetcher = useFetcher();

  const submittingPlan =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("plan") || "")
      : null;

  /* When billing is on, a paid-tier selection comes back with a Razorpay
     hosted-checkout URL instead of redirecting. Open it at the top level so we
     escape the Shopify admin iframe (Razorpay blocks being framed). In a fully
     embedded flow you'd use App Bridge's Redirect.Action.REMOTE; window.open is
     used here to keep the dormant feature dependency-free. */
  useEffect(() => {
    if (fetcher.data?.redirectUrl) {
      window.open(fetcher.data.redirectUrl, "_blank", "noopener,noreferrer");
    }
  }, [fetcher.data]);

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
                {billingEnabled
                  ? "Pick a tier to unlock the matching set of features. Paid plans are billed monthly through Razorpay; you can change or cancel any time."
                  : "Pick a tier to unlock the matching set of features. You can change plans at any time from this screen — no billing is charged."}
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
              /* Price shown: free always $0; paid tiers show their real price
                 only when billing is enabled, otherwise $0 (current free mode). */
              const priceLabel =
                billingEnabled && p.id !== PLANS.FREE
                  ? formatPrice(pricing?.[p.id])
                  : "$0";
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
                            {isCurrent ? "You're on this plan" : p.cta}
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
