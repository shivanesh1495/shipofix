# App Store review — testing instructions & credentials

Paste the relevant parts of this into **Partner Dashboard → your app → App
listing → App review → Testing instructions** before submitting. Keep it up to
date (review requirements 4.5.4 / 4.5.5).

## Authentication / credentials

Shipofix has **no separate login** — it authenticates via Shopify OAuth when
installed on a store. There is no username/password to manage. To review the
full feature set, install the app on a **development store** (which can approve
test charges for free):

- Test store URL: `https://<your-dev-store>.myshopify.com/admin`
- Staff account email: `<reviewer-access-email>`
- Staff account password: `<reviewer-access-password>`

> Fill the three placeholders above with a real development-store staff account
> that has the app installed and full permissions. Double-check they work before
> submitting (requirement 4.5.5 — credentials must grant full access).

## Billing (Shopify Billing API)

Charges go through the **Shopify Billing API** in **test mode**
(`BILLING_TEST` is not set to `false`), so approving a paid plan on a
development store does **not** create a real charge.

Steps to verify the billing flow:

1. Open the app → you land on **Choose your Shipofix plan**.
2. Click **Choose Advanced — confirm on Shopify** (or Premium).
3. You are redirected to **Shopify's native subscription approval screen**
   (not an in-app toggle). Approve it.
4. You return to the dashboard with the tier active. The plan badge updates,
   and on **Premium** the **Bulk edit (Excel)** tab appears.
5. Click **Change plan → Start free** to cancel the subscription and return to
   the Free tier instantly.

## Feature set to review

- **All rates** tab: create a shipping zone, pick one of the 7 pricing models,
  set rates. Rates are returned at checkout via a Carrier Service.
- **Bulk edit (Excel)** tab (Premium only): download the template, edit many
  rules at once, upload.
- **Disconnect / Reconnect**: hands shipping back to Shopify's native rates and
  restores Shipofix rates.

## Going live

Set `BILLING_TEST=false` in the production environment to charge real merchants.
No code change required. See [BILLING.md](BILLING.md).
