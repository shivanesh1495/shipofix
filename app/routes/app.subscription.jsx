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

import { redirect, useFetcher, useLoaderData } from "react-router";
import {
  Badge,
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
import {
  FREE_ZONE_LIMIT,
  PLANS,
  VALID_PLANS,
  getShopPlan,
  setShopPlan,
} from "../lib/plan.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentPlan = await getShopPlan(session.shop);
  return { currentPlan };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "").trim();

  if (!VALID_PLANS.has(plan)) {
    return { success: false, error: `Unknown plan "${plan}".` };
  }

  await setShopPlan(session.shop, plan);
  /* After picking, drop the user on the main dashboard. Preserve the
     embedded ?shop=&host=&embedded= so the iframe keeps Shopify context. */
  const search = new URL(request.url).search;
  return redirect(`/app${search}`);
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

export default function SubscriptionPage() {
  const { currentPlan } = useLoaderData();
  const fetcher = useFetcher();

  const submittingPlan =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("plan") || "")
      : null;

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
                Pick a tier to unlock the matching set of features. You can
                change plans at any time from this screen — no billing is
                charged.
              </Text>
            </BlockStack>
          </Box>

          <div className="plan-card-grid">
            {PLAN_CARDS.map((p) => {
              const isCurrent = currentPlan === p.id;
              const isPopular = p.badge === "Most popular";
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
                          {p.price}
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
