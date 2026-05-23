/*
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Grid,
  Box,
  Divider,
  Icon,
  Badge,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useLoaderData, useFetcher } from "react-router";

export const loader = async ({ request }) => {
  const { admin, billing } = await authenticate.admin(request);
  
  // Fetch current active subscriptions
  const billingCheck = await billing.check({
    isTest: true,
  });

  return {
    activeSubscriptions: billingCheck.appSubscriptions,
  };
};

export const action = async ({ request }) => {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan");

  if (plan === "Standard") {
    // If they select Standard, we cancel any existing subscription
    const billingCheck = await billing.check({ isTest: true });
    if (billingCheck.appSubscriptions.length > 0) {
      const subscription = billingCheck.appSubscriptions[0];
      await billing.cancel({
        subscriptionId: subscription.id,
        isTest: true,
      });
    }
    return { success: true };
  }

  // Use the built-in billing request helper
  return await billing.request({
    plan,
    isTest: true,
  });
};

export default function SubscriptionPage() {
  const { activeSubscriptions } = useLoaderData();
  const fetcher = useFetcher();

  const currentPlan = activeSubscriptions.length > 0 
    ? activeSubscriptions[0].name 
    : "Standard";

  const plans = [
    {
      name: "Standard",
      price: "$0",
      description: "Perfect for starting out small",
      features: [
        "1 dynamic shipping zone",
        "Standard rate logic",
        "Amazing feature",
        "24/7 Customer Support",
      ],
      isPopular: false,
    },
    {
      name: "Advanced",
      price: "$5",
      description: "Scale your business with ease",
      features: [
        "3 dynamic shipping zones",
        "Advanced rate logic",
        "Amazing feature",
        "24/7 Customer Support",
      ],
      isPopular: true,
    },
    {
      name: "Premium",
      price: "$20",
      description: "Full power for large operations",
      features: [
        "Unlimited shipping zones",
        "Priority rate processing",
        "Amazing feature",
        "24/7 Customer Support",
      ],
      isPopular: false,
    },
  ];

  return (
    <Page title="Shipofix Subscription" backAction={{ content: "Home", url: "/app" }}>
      <Box paddingBlockEnd="800">
        <BlockStack gap="500">
          <Box paddingBlockEnd="400" textAlign="center">
            <Text variant="headingXl" as="h1">
              Choose the right plan for your store
            </Text>
            <Box paddingBlockStart="200">
              <Text variant="bodyLg" tone="subdued">
                Scale your shipping logic as your business grows.
              </Text>
            </Box>
          </Box>

          <Grid>
            {plans.map((plan) => (
              <Grid.Cell key={plan.name} columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4 }}>
                <div style={{
                  height: '100%',
                  position: 'relative',
                  border: plan.isPopular ? '2px solid #D5F5E3' : '1px solid #E1E3E5',
                  borderRadius: '12px',
                  backgroundColor: 'white',
                  boxShadow: plan.isPopular ? '0 10px 20px rgba(0,0,0,0.05)' : 'none',
                  transition: 'all 0.2s ease',
                  padding: '1px'
                }}>
                  {plan.isPopular && (
                    <div style={{
                      position: 'absolute',
                      top: '-12px',
                      left: '50%',
                      transform: 'translateX(-50%)',
                    }}>
                      <Badge tone="success">Most Popular</Badge>
                    </div>
                  )}
                  
                  <Box padding="600">
                    <BlockStack gap="400">
                      <BlockStack gap="100">
                        <Text variant="headingLg" as="h2">{plan.name}</Text>
                        <Text variant="bodyMd" tone="subdued">{plan.description}</Text>
                      </BlockStack>

                      <InlineStack align="start" blockAlign="baseline" gap="100">
                        <Text variant="heading2xl" as="p">{plan.price}</Text>
                        <Text variant="bodyMd" tone="subdued">/ month</Text>
                      </InlineStack>

                      <Divider />

                      <BlockStack gap="300">
                        {plan.features.map((feature) => (
                          <InlineStack key={feature} gap="200" align="start">
                            <span style={{ color: '#008060' }}>
                              <Icon source={CheckIcon} />
                            </span>
                            <Text variant="bodyMd">{feature}</Text>
                          </InlineStack>
                        ))}
                      </BlockStack>

                      <Box paddingBlockStart="400">
                        <fetcher.Form method="POST">
                          <input type="hidden" name="plan" value={plan.name} />
                          <Button
                            fullWidth
                            size="large"
                            variant={plan.isPopular ? "primary" : "secondary"}
                            disabled={currentPlan === plan.name}
                            submit
                            loading={fetcher.state === "submitting" && fetcher.formData?.get("plan") === plan.name}
                          >
                            {currentPlan === plan.name ? "Current Plan" : "Select Plan"}
                          </Button>
                        </fetcher.Form>
                      </Box>
                    </BlockStack>
                  </Box>
                </div>
              </Grid.Cell>
            ))}
          </Grid>
        </BlockStack>
      </Box>
    </Page>
  );
}
*/

export default function SubscriptionDisabled() {
  return null;
}

