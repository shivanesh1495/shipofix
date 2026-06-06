# Billing — Shopify Billing API

Shipofix charges **exclusively through the Shopify Billing API**. Off-platform
billing is not used (and is not allowed for App Store apps). Selecting a paid
tier creates an `AppSubscription` and redirects the merchant to Shopify's
**native approval/confirmation screen** — the plan is granted only after Shopify
confirms the charge.

## Tiers

| Plan | Price | What it unlocks |
|------|-------|-----------------|
| Free | $0 | Up to 2 shipping zones, all 7 pricing models, manual editing. |
| Advanced | $5/mo | Unlimited zones, manual editing. |
| Premium | $10/mo | Everything, including the Excel bulk-edit workflow. |

The prices and plan names live in **one place**: the `billing` config in
[`app/shopify.server.js`](../app/shopify.server.js) (plan names `Advanced` /
`Premium`). The picker UI mirrors them via `BILLING_PRICING` in
[`app/lib/billing.server.js`](../app/lib/billing.server.js).

## How it works

1. **Picker** (`/app/subscription`): selecting a paid tier calls
   `billing.request({ plan, isTest })`, which creates the subscription and
   throws a redirect (out of the embedded iframe, via App Bridge) to Shopify's
   confirmation URL. Selecting **Free** cancels any active subscription and is
   granted instantly.
2. **Approval**: the merchant approves (or declines) on Shopify's screen.
3. **Return**: Shopify returns the merchant to the embedded app. The dashboard
   loader runs `reconcileEntitlement()`, which calls `billing.check()` and
   writes the authoritative plan to `AppSetting.plan`.
4. **Webhook**: `app_subscriptions/update` (registered in
   [`shopify.app.toml`](../shopify.app.toml)) keeps the cached plan in sync when
   a change happens outside the app (e.g. a cancellation from the Shopify
   admin), via `activePlanFromAdmin()`.

`AppSetting.plan` is the cached entitlement every feature gate reads through
`getEntitledPlan()`. Because it is reconciled from Shopify on every dashboard
load, a lapsed/cancelled/spoofed paid plan can never unlock paid features — the
truth always lives in Shopify, not in a client-trusted path.

## Test mode

By default subscriptions are created in **Shopify TEST mode** (`isTest = true`),
so App Store reviewers and development/partner stores can approve the native
confirmation screen without a real charge.

| `BILLING_TEST` | Behaviour |
|----------------|-----------|
| unset / anything but `false` (default) | Test charges — no real money moves. |
| `false` | Live charges — production merchants are billed for real. |

Set `BILLING_TEST=false` in the production environment when you're ready to
charge live. No code change is required.

## Notes for reviewers / QA

- Install on a development store, open the app, and click **Choose Advanced** or
  **Choose Premium** on the plan page. You are redirected to Shopify's native
  subscription approval screen (not an in-app toggle).
- Approving returns you to the dashboard with the new tier active; the Bulk
  Edit (Excel) tab appears on Premium.
- Choosing **Free** cancels the subscription and returns you to Free instantly.
