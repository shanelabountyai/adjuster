-- CreateTable
CREATE TABLE "OverrideReason" (
    "code" TEXT NOT NULL,

    CONSTRAINT "OverrideReason_pkey" PRIMARY KEY ("code")
);

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "overrideTier" TEXT,
ADD COLUMN "overrideTotalIncurredCents" INTEGER,
ADD COLUMN "overrideBy" UUID;

-- Hand-written below, as in 20261005010000_document_status.

-- D59: the reasons an override may give. Data: an override can name only a row of this table, and a third is an INSERT.
INSERT INTO "OverrideReason" ("code") VALUES
  ('SIGN_OFF'), ('FLAG_CLEARED');

-- AddForeignKey (after the seed; no stored decision is an override yet)
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_overrideReasonCode_fkey" FOREIGN KEY ("overrideReasonCode") REFERENCES "OverrideReason"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Decision"
  -- D48: an override stores who made it, the tier they held and the total incurred it was tested on; an engine decision none of them
  ADD CONSTRAINT decision_override_authority CHECK (
    ("overridesId" IS NULL) = ("overrideTier" IS NULL)
    AND ("overridesId" IS NULL) = ("overrideTotalIncurredCents" IS NULL)
    AND ("overridesId" IS NULL) = ("overrideBy" IS NULL)
  ),
  -- D48: a reason of spaces is no reason (NULL, on an engine decision, passes)
  ADD CONSTRAINT decision_override_text CHECK (btrim("overrideReasonText") <> '');
