# Razorpay Billing — Setup & Operations

Billing is **off by default**. The app runs exactly as it does today (every plan
free, picker grants instantly) until you flip one switch. Nothing is commented
out — the whole system is gated by the `BILLING_ENABLED` environment variable,
so turning it on is a single config change with no code edits.

| State | `BILLING_ENABLED` | Behaviour |
|-------|-------------------|-----------|
| Now (default) | unset / `false` | Free-for-all. Razorpay never contacted. |
| Enforced | `true` | Advanced ($5/mo) and Premium ($10/mo) require a verified Razorpay subscription. No payment → no paid features. |

## How enforcement works (why the routes are safe)

A paid tier is written to `AppSetting.plan` **only** by the signature-verified
Razorpay webhook (`/webhooks/razorpay`). Because every gate in the app already
reads the plan through `getEntitledPlan()`, a shop with no active subscription
is transparently treated as **Free** — on the dashboard loader, the zone-limit
check, and the bulk-upload check alike. There is no client-trusted path: the
subscription action can only *start* a checkout, never grant access. An attacker
cannot forge a webhook without `RAZORPAY_WEBHOOK_SECRET`.

`getEntitledPlan()` also degrades a *lapsed* paid plan to Free, so a cancelled or
failed-renewal subscription loses paid features on the next request.

## Credentials & environment variables

Set these only when enabling billing:

| Variable | Required | What it is / where to get it |
|----------|----------|------------------------------|
| `BILLING_ENABLED` | yes | `true` to enforce billing. |
| `RAZORPAY_KEY_ID` | yes | Razorpay Dashboard → Settings → **API Keys** (`rzp_live_…` / `rzp_test_…`). |
| `RAZORPAY_KEY_SECRET` | yes | Shown once when you generate the API key. Server-side only — never expose. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | A secret **you choose** when creating the webhook (Settings → Webhooks). Used to verify webhook authenticity. |
| `RAZORPAY_PLAN_ADVANCED` | yes | Plan id (`plan_…`) of the $5/mo plan you create. |
| `RAZORPAY_PLAN_PREMIUM` | yes | Plan id (`plan_…`) of the $10/mo plan you create. |
| `BILLING_CURRENCY` | no | Defaults to `USD`. |
| `BILLING_ADVANCED_AMOUNT` | no | Display/verification amount in cents. Default `500`. |
| `BILLING_PREMIUM_AMOUNT` | no | Display/verification amount in cents. Default `1000`. |

> The **authoritative** price is the Razorpay Plan you create; the `*_AMOUNT`
> vars are only for what the picker shows and sanity checks.

## One-time setup checklist

1. **Razorpay account** — for USD charging, enable **International Payments**
   (Dashboard → Settings → Configuration). Without it, use `BILLING_CURRENCY=INR`
   and INR plan amounts instead.
2. **Create two Plans** (Dashboard → Subscriptions → Plans): monthly, USD,
   `$5.00` and `$10.00`. Copy each `plan_…` id → `RAZORPAY_PLAN_ADVANCED` /
   `RAZORPAY_PLAN_PREMIUM`.
3. **API Keys** (Settings → API Keys) → `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`.
4. **Webhook** (Settings → Webhooks): URL = `https://<your-app-url>/webhooks/razorpay`,
   set a secret → `RAZORPAY_WEBHOOK_SECRET`, and subscribe to:
   `subscription.activated`, `subscription.charged`, `subscription.pending`,
   `subscription.halted`, `subscription.cancelled`, `subscription.completed`.
5. **Apply DB + client**: the billing columns are already migrated; in
   production run `npx prisma migrate deploy && npx prisma generate` (the
   `npm run setup` script does this). In dev, restart so the client regenerates.
6. Set all env vars + `BILLING_ENABLED=true`, restart the app.

## Going live: grandfathered shops

If any shop already has `plan = 'advanced' | 'premium'` stored from the current
free era, it will keep paid access when you enable billing. To force everyone to
subscribe, run once before enabling:

```sql
UPDATE "AppSetting"
SET plan = 'free', "billingStatus" = NULL, "billingPlan" = NULL
WHERE plan IN ('advanced','premium');
```

## Test mode

Use `rzp_test_…` keys and Razorpay test cards. The webhook must be reachable
from the public internet (use the tunnel URL from `npm run dev`, or a staging
deploy) for subscription activation to complete.
