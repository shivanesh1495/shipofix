import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR compliance webhook: customers/data_request.
 *
 * Shopify sends this when a store customer requests their data. Shipofix does
 * not collect or store any customer personal data (it only reads the country
 * and province at checkout to calculate a rate, and stores none of it), so
 * there is no customer data to return. We verify the HMAC and acknowledge.
 */
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop} — no customer data stored`);

  return new Response();
};
