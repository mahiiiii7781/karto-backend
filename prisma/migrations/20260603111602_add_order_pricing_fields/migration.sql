-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cgstAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cgstRate" DECIMAL(5,2) NOT NULL DEFAULT 2.5,
ADD COLUMN     "platformFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgstAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgstRate" DECIMAL(5,2) NOT NULL DEFAULT 2.5;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aadhaarImageUrl" TEXT,
ADD COLUMN     "aadhaarNumber" TEXT,
ADD COLUMN     "drivingLicense" TEXT,
ADD COLUMN     "isOnline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kycStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "lastSeen" TIMESTAMP(3),
ADD COLUMN     "licenseImageUrl" TEXT;

-- CreateTable
CREATE TABLE "RiderIncentive" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "targetOrders" INTEGER NOT NULL,
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiderIncentive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiderIncentive_riderId_idx" ON "RiderIncentive"("riderId");

-- CreateIndex
CREATE INDEX "RiderIncentive_isCompleted_idx" ON "RiderIncentive"("isCompleted");

-- CreateIndex
CREATE INDEX "RiderIncentive_startDate_idx" ON "RiderIncentive"("startDate");

-- CreateIndex
CREATE INDEX "RiderIncentive_endDate_idx" ON "RiderIncentive"("endDate");

-- AddForeignKey
ALTER TABLE "RiderIncentive" ADD CONSTRAINT "RiderIncentive_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
