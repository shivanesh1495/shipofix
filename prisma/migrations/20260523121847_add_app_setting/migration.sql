-- CreateTable
CREATE TABLE "AppSetting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "bulkEditEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
