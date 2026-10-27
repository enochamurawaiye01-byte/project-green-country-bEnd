-- AlterTable
ALTER TABLE "PlantingRecord" ADD COLUMN     "isTestData" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verificationNotes" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;

-- CreateIndex
CREATE INDEX "PlantingRecord_locationId_idx" ON "PlantingRecord"("locationId");

-- CreateIndex
CREATE INDEX "PlantingRecord_speciesId_idx" ON "PlantingRecord"("speciesId");

-- CreateIndex
CREATE INDEX "PlantingRecord_status_isTestData_verifiedAt_plantingDate_idx" ON "PlantingRecord"("status", "isTestData", "verifiedAt", "plantingDate");

-- AddForeignKey
ALTER TABLE "PlantingRecord" ADD CONSTRAINT "PlantingRecord_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
