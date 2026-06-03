-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
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
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "deliveryZoneGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logicType" TEXT NOT NULL DEFAULT 'STANDARD_TIER',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rulesJson" TEXT NOT NULL DEFAULT '{}',
    "countries" TEXT,
    "source" TEXT NOT NULL DEFAULT 'shopify',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "shop" TEXT NOT NULL,
    "plan" TEXT,
    "billingStatus" TEXT,
    "billingPlan" TEXT,
    "razorpaySubscriptionId" TEXT,
    "razorpayCustomerId" TEXT,
    "billingCurrentPeriodEnd" TIMESTAMP(3),
    "billingUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "BulkEditUpload" (
    "shop" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkEditUpload_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "ZoneRule_shop_updatedAt_idx" ON "ZoneRule"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "ZoneRule_shop_source_idx" ON "ZoneRule"("shop", "source");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneRule_shop_deliveryZoneGid_key" ON "ZoneRule"("shop", "deliveryZoneGid");

-- CreateIndex
CREATE INDEX "AppSetting_razorpaySubscriptionId_idx" ON "AppSetting"("razorpaySubscriptionId");
