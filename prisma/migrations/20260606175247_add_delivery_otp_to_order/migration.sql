-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryOtp" TEXT,
ADD COLUMN     "deliveryOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "deliveryOtpVerified" BOOLEAN NOT NULL DEFAULT false;
