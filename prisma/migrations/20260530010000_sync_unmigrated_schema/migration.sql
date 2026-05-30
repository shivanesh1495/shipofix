-- Reconcile the remaining `prisma db push` drift with migration history so a
-- fresh `prisma migrate deploy` ends up matching schema.prisma exactly.
--
-- 1. BulkEditUpload — stores the last uploaded .xlsx blob per shop. Added via
--    db push, so it was missing from migrations; without it the bulk-edit
--    download/upload features crash on a freshly-deployed database.
-- 2. ZoneConfig / Slab — the original v1 tables, replaced by the unified
--    ZoneRule model and removed from schema.prisma, but still created by the
--    init migration. Drop them so the deployed schema has no orphan tables.
--
-- All statements are guarded (IF NOT EXISTS / IF EXISTS) so this is a no-op on
-- databases already in the correct final state.

CREATE TABLE IF NOT EXISTS "BulkEditUpload" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BLOB NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS "Slab";
DROP TABLE IF EXISTS "ZoneConfig";
