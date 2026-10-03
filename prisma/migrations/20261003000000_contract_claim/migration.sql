-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "planVersionId" UUID NOT NULL,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "paymentStatus" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "RuleSetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below, as in 20261002000000_adjudication_init: each rejection names its rule in the error's
-- constraint field. TRUNCATE is left alone, so tests and the seed can still empty the tables.

-- Domain brief §7. The legal moves between them are a table in code (task 2.5).
ALTER TABLE "Claim"
  ADD CONSTRAINT claim_status CHECK ("status" IN ('OPEN', 'PENDING_EVIDENCE', 'IN_REVIEW', 'REFERRED', 'DECIDED',
    'PAYMENT_PENDING', 'PAID', 'CLOSED', 'CLOSED_NO_RESPONSE', 'WITHDRAWN', 'UNDER_APPEAL', 'REOPENED')),
  -- D36: the minimum the lifecycle names; Phase 3's mock payment may add to it.
  ADD CONSTRAINT claim_payment_status CHECK ("paymentStatus" IN ('NONE', 'PENDING', 'PAID'));

-- D36: a contract is seeded, then read-only. Its terms are the bargain (D3).
CREATE FUNCTION contract_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Contract % is read-only', OLD."id"
    USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_read_only';
END;
$$;

CREATE TRIGGER "Contract_read_only"
  BEFORE UPDATE OR DELETE ON "Contract"
  FOR EACH ROW EXECUTE FUNCTION contract_read_only();

-- D3, D36: the pin is a published (or since retired) plan version. Not checked against the day of sale:
-- GC-08's contract predates plan-v1's effectiveFrom, and asOf is what VERSION_NOT_EFFECTIVE checks.
CREATE FUNCTION contract_pins_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RuleSetVersion" WHERE "id" = NEW."planVersionId" AND "kind" = 'plan' AND "status" <> 'draft') THEN
    RAISE EXCEPTION 'Contract % must pin a published plan version', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_pins_plan';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Contract_pins_plan"
  BEFORE INSERT ON "Contract"
  FOR EACH ROW EXECUTE FUNCTION contract_pins_plan();
