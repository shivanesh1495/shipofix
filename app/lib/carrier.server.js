/**
 * Carrier service registration & management — server-only module.
 * Extracted from app._index.jsx loader/action helpers.
 */

import process from "node:process";
import {
  QUERY_CARRIER_SERVICES,
  MUTATION_CREATE_CARRIER,
  MUTATION_UPDATE_CARRIER,
} from "./graphql.js";

/* ── Constants ────────────────────────────────────────────────────────── */

export const CARRIER_SERVICE_NAME = "Custom Carrier Shipping Engine";

export const STALE_CARRIER_NAMES = [
  "PerKg Billing Shipping Engine",
  "Standard Shipping Provider",
  "Custom Carrier Shipping Engine",
];

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Build the carrier service callback URL from environment.
 * @returns {string|null}
 */
export function getCallbackUrl() {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) return null;
  return `${appUrl.replace(/\/$/, "")}/api/shipping`;
}

/* ── Main ─────────────────────────────────────────────────────────────── */

/**
 * Ensure the carrier service is registered with the current tunnel URL.
 * Creates, updates, or no-ops as needed.
 *
 * @param {object} admin - Shopify Admin API client
 * @returns {Promise<{ state: string, message: string, staleServices?: Array }>}
 */
export async function ensureCarrierService(admin) {
  const callbackUrl = getCallbackUrl();
  if (!callbackUrl)
    return {
      state: "info",
      message:
        "Shipofix isn't fully connected yet — your developer needs to set the app URL before checkout can fetch rates.",
    };

  try {
    const queryResponse = await admin.graphql(QUERY_CARRIER_SERVICES);
    const queryJson = await queryResponse.json();
    const services =
      queryJson?.data?.carrierServices?.edges?.map((e) => e.node) || [];

    const exactMatch = services.find((s) => s.callbackUrl === callbackUrl);
    const ownStale = services.find(
      (s) => s.name === CARRIER_SERVICE_NAME && s.callbackUrl !== callbackUrl,
    );
    const otherStale = services.filter(
      (s) =>
        s.callbackUrl !== callbackUrl &&
        s.name !== CARRIER_SERVICE_NAME &&
        STALE_CARRIER_NAMES.includes(s.name),
    );

    if (exactMatch) {
      return {
        state: "success",
        message:
          "Shipofix is connected to your checkout — customers will see the rates you configure here.",
        staleServices: otherStale,
      };
    }

    // Update stale URL in-place to preserve zone attachments
    if (ownStale) {
      const updateResponse = await admin.graphql(MUTATION_UPDATE_CARRIER, {
        variables: {
          input: { id: ownStale.id, callbackUrl, active: true },
        },
      });
      const updateJson = await updateResponse.json();
      const updateErrors =
        updateJson?.data?.carrierServiceUpdate?.userErrors || [];
      if (updateErrors.length > 0) {
        throw new Error(updateErrors.map((error) => error.message).join(", "));
      }
      return {
        state: "success",
        message: "Shipofix reconnected to your checkout.",
        staleServices: otherStale,
      };
    }

    // Create fresh
    await admin.graphql(MUTATION_CREATE_CARRIER, {
      variables: {
        input: {
          name: CARRIER_SERVICE_NAME,
          callbackUrl,
          active: true,
          supportsServiceDiscovery: true,
        },
      },
    });
    return {
      state: "success",
      message:
        "Shipofix is now connected to your checkout — rates you configure here will be used.",
      staleServices: otherStale,
    };
  } catch (error) {
    return {
      state: "warning",
      message: `We couldn't connect Shipofix to your checkout: ${error.message}. Try refreshing — if it keeps happening, contact support.`,
      staleServices: [],
    };
  }
}
