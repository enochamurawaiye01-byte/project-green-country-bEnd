-- Proposed additive migration for growth observations.
-- Review against the live schema and migration history before applying.

CREATE TYPE "GrowthStage" AS ENUM (
  'NEWLY_PLANTED',
  'SEEDLING_ESTABLISHMENT',
  'EARLY_GROWTH',
  'ESTABLISHED_GROWTH',
  'MATURE'
);

CREATE TYPE "GrowthCondition" AS ENUM (
  'HEALTHY',
  'FAIR',
  'POOR',
  'PEST_AFFECTED',
  'DISEASE_AFFECTED',
  'DEAD'
);

CREATE TYPE "GrowthUpdateStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED'
);

CREATE TABLE "GrowthUpdate" (
  "id" TEXT NOT NULL,
  "plantingRecordId" TEXT,
  "locationId" TEXT,
  "observationDate" TIMESTAMP(3) NOT NULL,
  "growthStage" "GrowthStage" NOT NULL,
  "condition" "GrowthCondition" NOT NULL,
  "treesInspected" INTEGER NOT NULL,
  "treesSurviving" INTEGER,
  "treesDead" INTEGER,
  "averageHeightCm" DECIMAL(8,2),
  "notes" TEXT,
  "photoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "latitude" DECIMAL(10,7),
  "longitude" DECIMAL(10,7),
  "submittedById" TEXT NOT NULL,
  "status" "GrowthUpdateStatus" NOT NULL DEFAULT 'PENDING',
  "isPublic" BOOLEAN NOT NULL DEFAULT false,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNotes" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GrowthUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GrowthUpdate_plantingRecordId_observationDate_idx"
  ON "GrowthUpdate"("plantingRecordId", "observationDate");
CREATE INDEX "GrowthUpdate_locationId_observationDate_idx"
  ON "GrowthUpdate"("locationId", "observationDate");
CREATE INDEX "GrowthUpdate_status_isPublic_observationDate_idx"
  ON "GrowthUpdate"("status", "isPublic", "observationDate");
CREATE INDEX "GrowthUpdate_submittedById_createdAt_idx"
  ON "GrowthUpdate"("submittedById", "createdAt");

ALTER TABLE "GrowthUpdate"
  ADD CONSTRAINT "GrowthUpdate_plantingRecordId_fkey"
  FOREIGN KEY ("plantingRecordId") REFERENCES "PlantingRecord"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GrowthUpdate"
  ADD CONSTRAINT "GrowthUpdate_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "PlantingLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GrowthUpdate"
  ADD CONSTRAINT "GrowthUpdate_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GrowthUpdate"
  ADD CONSTRAINT "GrowthUpdate_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
