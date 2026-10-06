-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "documentVersions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ClaimFact" (
    "id" UUID NOT NULL,
    "claimId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "documentVersionId" UUID,
    "enteredBy" UUID,
    "enteredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "ClaimFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimFact_claimId_idx" ON "ClaimFact"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimFact_documentVersionId_factId_key" ON "ClaimFact"("documentVersionId", "factId");

-- AddForeignKey
ALTER TABLE "ClaimFact" ADD CONSTRAINT "ClaimFact_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimFact" ADD CONSTRAINT "ClaimFact_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below, as in 20261005000000_documents.

-- Prisma makes a list column nullable; a null list would not hash.
ALTER TABLE "Decision" ADD CONSTRAINT decision_document_versions CHECK ("documentVersions" IS NOT NULL);

ALTER TABLE "ClaimFact"
  ADD CONSTRAINT claim_fact_id CHECK ("factId" <> ''),
  -- Unknown is the absence of a row, never a stored null (non-negotiable 6).
  ADD CONSTRAINT claim_fact_value CHECK ("value" <> 'null'::jsonb),
  -- D55: a fact with no document behind it has to name the person who vouches for it.
  ADD CONSTRAINT claim_fact_attributed CHECK ("documentVersionId" IS NOT NULL OR "enteredBy" IS NOT NULL);

-- D55: an entered fact is never edited or removed; a correction is a later row.
CREATE TRIGGER "ClaimFact_append_only"
  BEFORE UPDATE OR DELETE ON "ClaimFact"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
