import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory GDPR compliance webhook: shop/redact.
 *
 * Shopify sends this 48 hours after a store uninstalls the app, requesting
 * erasure of the shop's data. We verify the HMAC and delete everything Shipofix
 * stored for this shop.
 */
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop} — erasing shop data`);

  await db.session.deleteMany({ where: { shop } });
  await db.zoneRule.deleteMany({ where: { shop } });
  await db.appSetting.deleteMany({ where: { shop } });
  await db.bulkEditUpload.deleteMany({ where: { shop } });

  return new Response();
};
