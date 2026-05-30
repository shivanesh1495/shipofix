-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN "billingCurrentPeriodEnd" DATETIME;
ALTER TABLE "AppSetting" ADD COLUMN "billingPlan" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "billingStatus" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "billingUpdatedAt" DATETIME;
ALTER TABLE "AppSetting" ADD COLUMN "razorpayCustomerId" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "razorpaySubscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "AppSetting_razorpaySubscriptionId_idx" ON "AppSetting"("razorpaySubscriptionId");
