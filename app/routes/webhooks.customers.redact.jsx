import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR compliance webhook: customers/redact.
 *
 * Shopify sends this when a store customer requests deletion of their data.
 * Shipofix does not store any customer personal data, so there is nothing to
 * erase. We verify the HMAC and acknowledge.
 */
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop} — no customer data to redact`);

  return new Response();
};
