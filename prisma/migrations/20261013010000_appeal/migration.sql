-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "appealBy" UUID,
ADD COLUMN "appealTier" TEXT;

-- Hand-written below, as in 20261012020000_override_authority.

ALTER TABLE "Decision"
  -- D75, D79: the decision of an appeal is an engine row that supersedes the denial, and it stores who decided the
  -- appeal and the tier they held; no other row stores either
  ADD CONSTRAINT decision_appeal CHECK (
    ("appealBy" IS NULL) = ("appealTier" IS NULL)
    AND ("appealBy" IS NULL OR ("overridesId" IS NULL AND "supersedesId" IS NOT NULL))
  );

-- D75: a claim is appealed once
CREATE UNIQUE INDEX "Decision_one_appeal" ON "Decision" ("claimId") WHERE "appealBy" IS NOT NULL;
