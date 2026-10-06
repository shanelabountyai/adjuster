-- CreateTable
CREATE TABLE "DocumentRejectionReason" (
    "code" TEXT NOT NULL,

    CONSTRAINT "DocumentRejectionReason_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "DocumentReview" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentWaiver" (
    "id" UUID NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "waivedBy" UUID,
    "waivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentReview_versionId_key" ON "DocumentReview"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentWaiver_claimId_type_key" ON "DocumentWaiver"("claimId", "type");

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_reasonCode_fkey" FOREIGN KEY ("reasonCode") REFERENCES "DocumentRejectionReason"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentWaiver" ADD CONSTRAINT "DocumentWaiver_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written below, as in 20261005000000_documents: each rejection names its rule in the error's constraint field.

-- Domain brief §8's five reasons (D54). Data: a review can name only a row of this table, and a sixth is an INSERT.
INSERT INTO "DocumentRejectionReason" ("code") VALUES
  ('illegible'), ('wrong_document'), ('serial_mismatch'), ('date_inconsistent'), ('incomplete');

ALTER TABLE "DocumentReview"
  ADD CONSTRAINT document_review_result CHECK ("result" IN ('accepted', 'rejected')),
  -- a rejection names its reason and an acceptance has none ("result" is NOT NULL, so this is never NULL)
  ADD CONSTRAINT document_review_reason CHECK (("result" = 'rejected') = ("reasonCode" IS NOT NULL));

ALTER TABLE "DocumentWaiver"
  ADD CONSTRAINT document_waiver_reason CHECK ("reasonText" <> ''),
  ADD CONSTRAINT document_waiver_tier CHECK ("tier" <> '');

-- D54: where an upload came from. The brief stores a source and never lists them; these are who can hand one in.
ALTER TABLE "DocumentVersion"
  DROP CONSTRAINT document_version_source,
  ADD CONSTRAINT document_version_source CHECK ("source" IN ('claimant', 'servicer', 'staff'));

-- D53: a status is never written back. A review and a waiver are rows like a version is, so they are insert-only too.
CREATE TRIGGER "DocumentReview_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentReview"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();

CREATE TRIGGER "DocumentWaiver_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentWaiver"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
