-- Unify ZoneRule and BulkEditRule into a single ZoneRule table.
--
-- Zone-wise rules keep their real Shopify delivery-zone GIDs.
-- Bulk-edit rules carry their `bulk:<slug>` GIDs and get `source = 'bulk'`.
-- After the merge, the BulkEditRule table is dropped and AppSetting.bulkEditEnabled
-- is removed (the toggle no longer exists — both kinds of rules are always active).

-- 1. Add the `source` column to ZoneRule (default 'shopify' for everything already there).
ALTER TABLE "ZoneRule" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'shopify';

-- 2. Copy every BulkEditRule into ZoneRule, tagged as 'bulk'.
--    INSERT OR REPLACE so re-running on a partially-migrated DB is idempotent.
INSERT OR REPLACE INTO "ZoneRule" (
  "id", "shop", "deliveryZoneGid", "name", "logicType", "currency",
  "rulesJson", "countries", "source", "createdAt", "updatedAt"
)
SELECT
  "id", "shop", "deliveryZoneGid", "name", "logicType", "currency",
  "rulesJson", "countries", 'bulk', "createdAt", "updatedAt"
FROM "BulkEditRule";

-- 3. Drop the BulkEditRule table.
DROP TABLE IF EXISTS "BulkEditRule";

-- 4. Drop the `bulkEditEnabled` column from AppSetting.
--    SQLite only supports DROP COLUMN from 3.35+; the supported approach
--    everywhere is a table rebuild via a temp table.
PRAGMA foreign_keys=OFF;

CREATE TABLE "AppSetting_new" (
  "shop"      TEXT PRIMARY KEY NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "AppSetting_new" ("shop", "createdAt", "updatedAt")
SELECT "shop", "createdAt", "updatedAt" FROM "AppSetting";

DROP TABLE "AppSetting";
ALTER TABLE "AppSetting_new" RENAME TO "AppSetting";

PRAGMA foreign_keys=ON;

-- 5. Add the source index for fast filtering.
CREATE INDEX IF NOT EXISTS "ZoneRule_shop_source_idx"
  ON "ZoneRule" ("shop", "source");
