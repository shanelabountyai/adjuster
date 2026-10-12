-- CreateTable
CREATE TABLE "TierAssignment" (
    "id" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "tier" TEXT,
    "assignedBy" UUID,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TierAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TierAssignment_userId_id_idx" ON "TierAssignment"("userId", "id");


-- Hand-written below, as in 20261005000000_documents.

-- A null tier takes the user's tier away; an empty one is a mistake.
ALTER TABLE "TierAssignment" ADD CONSTRAINT tier_assignment_tier CHECK ("tier" <> '');

-- D58: who held which tier, and when, is never edited or removed. A change is a new row.
CREATE TRIGGER "TierAssignment_append_only"
  BEFORE UPDATE OR DELETE ON "TierAssignment"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
