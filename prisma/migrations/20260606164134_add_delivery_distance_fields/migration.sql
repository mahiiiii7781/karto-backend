-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "distanceKm" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "longitude" DECIMAL(10,7);
