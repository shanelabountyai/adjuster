-- CreateTable
CREATE TABLE "ClaimReminder" (
    "id" UUID NOT NULL,
    "decisionId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "asOf" DATE NOT NULL,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReminder_decisionId_level_key" ON "ClaimReminder"("decisionId", "level");

-- AddForeignKey
ALTER TABLE "ClaimReminder" ADD CONSTRAINT "ClaimReminder_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below, as in 20261005000000_documents.

ALTER TABLE "ClaimReminder" ADD CONSTRAINT claim_reminder_level CHECK ("level" >= 1);

-- D57: a reminder that was sent is never edited or removed.
CREATE TRIGGER "ClaimReminder_append_only"
  BEFORE UPDATE OR DELETE ON "ClaimReminder"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
