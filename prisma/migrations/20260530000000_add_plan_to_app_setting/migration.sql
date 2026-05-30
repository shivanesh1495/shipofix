-- Add the plan tier column to AppSetting.
--
-- "free" | "advanced" | "premium". NULL = the shop hasn't picked a plan yet,
-- which gates the dashboard behind /app/subscription on first load.
--
-- The previous `unify_zone_rules` migration rebuilt AppSetting without this
-- column; this migration restores it so a fresh `prisma migrate deploy`
-- produces a schema that matches schema.prisma (otherwise every getShopPlan /
-- setShopPlan call throws "no such column: plan" in production).
ALTER TABLE "AppSetting" ADD COLUMN "plan" TEXT;
