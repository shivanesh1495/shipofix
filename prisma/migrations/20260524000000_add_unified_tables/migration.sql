-- Bridge migration.
--
-- The ZoneRule and BulkEditRule tables were originally introduced with
-- `prisma db push`, so they never got a migration of their own. The later
-- `unify_zone_rules` migration assumes ZoneRule already exists (it runs
-- `ALTER TABLE "ZoneRule" ...`), which makes a fresh `prisma migrate deploy`
-- fail with "no such table: ZoneRule". This migration restores the missing
-- table-creation step in the right place in history (before unify).
--
-- Every statement is guarded with IF NOT EXISTS so it is a no-op on databases
-- that already have these tables (e.g. ones built via db push), and is marked
-- as already-applied on those databases via `prisma migrate resolve`.

CREATE TABLE IF NOT EXISTS "ZoneRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "deliveryZoneGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logicType" TEXT NOT NULL DEFAULT 'STANDARD_TIER',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rulesJson" TEXT NOT NULL DEFAULT '{}',
    "countries" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ZoneRule_shop_deliveryZoneGid_key" ON "ZoneRule"("shop", "deliveryZoneGid");
CREATE INDEX IF NOT EXISTS "ZoneRule_shop_updatedAt_idx" ON "ZoneRule"("shop", "updatedAt");

CREATE TABLE IF NOT EXISTS "BulkEditRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "deliveryZoneGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logicType" TEXT NOT NULL DEFAULT 'STANDARD_TIER',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rulesJson" TEXT NOT NULL DEFAULT '{}',
    "countries" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
