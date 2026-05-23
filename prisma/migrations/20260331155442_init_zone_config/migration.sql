-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "ZoneConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "zoneName" TEXT NOT NULL,
    "calculationMode" TEXT NOT NULL DEFAULT 'DEFAULT',
    "countries" TEXT,
    "flatRateAmount" REAL,
    "ratePerKg" REAL,
    "priceMultiplier" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Slab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneConfigId" TEXT NOT NULL,
    "min" REAL NOT NULL,
    "max" REAL NOT NULL,
    "rate" REAL NOT NULL,
    CONSTRAINT "Slab_zoneConfigId_fkey" FOREIGN KEY ("zoneConfigId") REFERENCES "ZoneConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoneConfig_shop_zoneId_key" ON "ZoneConfig"("shop", "zoneId");
