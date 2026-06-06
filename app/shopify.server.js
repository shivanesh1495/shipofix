import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  BillingInterval,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Shopify Billing API plans. These names are the SOURCE OF TRUTH for the paid
 * tiers — the same strings are used as `appSubscription.name` in Shopify and
 * are mapped back to internal plan keys in app/lib/billing.server.js.
 *
 * Charges go through the Shopify Billing API exclusively (App Store requirement
 * — off-platform billing is not allowed). Selecting a paid tier creates an
 * AppSubscription and redirects the merchant to Shopify's native approval
 * screen; the plan is only granted once Shopify confirms the charge.
 */
export const BILLING_ADVANCED = "Advanced";
export const BILLING_PREMIUM = "Premium";

export const billing = {
  [BILLING_ADVANCED]: {
    lineItems: [
      {
        amount: 5,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days,
      },
    ],
  },
  [BILLING_PREMIUM]: {
    lineItems: [
      {
        amount: 10,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days,
      },
    ],
  },
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
