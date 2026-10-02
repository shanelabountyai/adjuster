-- CreateTable
CREATE TABLE "RuleSetVersion" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveFrom" DATE NOT NULL,
    "body" JSONB NOT NULL,
    "contentHash" TEXT,
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleSetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" UUID NOT NULL,
    "claimId" TEXT NOT NULL,
    "planVersionId" UUID NOT NULL,
    "planHash" TEXT NOT NULL,
    "opsVersionId" UUID NOT NULL,
    "opsHash" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "facts" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outputHash" TEXT NOT NULL,
    "engineSemanticsVersion" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "payableCents" INTEGER,
    "explanation" JSONB NOT NULL,
    "supersedesId" UUID,
    "overridesId" UUID,
    "overrideReasonCode" TEXT,
    "overrideReasonText" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleSetVersion_kind_product_version_key" ON "RuleSetVersion"("kind", "product", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_supersedesId_key" ON "Decision"("supersedesId");

-- CreateIndex
CREATE INDEX "Decision_claimId_idx" ON "Decision"("claimId");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "RuleSetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_opsVersionId_fkey" FOREIGN KEY ("opsVersionId") REFERENCES "RuleSetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_overridesId_fkey" FOREIGN KEY ("overridesId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below, as in 20260923100000_audit_append_only. Each rejection names its rule in the
-- error's constraint field: the constraint name for a CHECK, RAISE ... USING CONSTRAINT for a trigger.
-- TRUNCATE is left alone (row triggers do not fire on it), so tests can still empty the tables.

ALTER TABLE "RuleSetVersion"
  ADD CONSTRAINT ruleset_kind CHECK ("kind" IN ('plan', 'ops')),
  ADD CONSTRAINT ruleset_status CHECK ("status" IN ('draft', 'published', 'retired')),
  -- D2: published means content-hashed. The DB checks the hash's shape; decisions:verify checks its value.
  -- coalesce, because a CHECK that evaluates to NULL passes, and NULL ~ anything is NULL.
  ADD CONSTRAINT ruleset_published_hashed CHECK (coalesce(
    "status" = 'draft' OR ("contentHash" ~ '^[0-9a-f]{64}$' AND "publishedAt" IS NOT NULL), false));

-- VP-01 (D2): a draft is free to change or go. A published row may only be retired, nothing else in it
-- changing; a retired row is final.
CREATE FUNCTION rule_set_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'published' AND NEW."status" = 'retired'
     AND to_jsonb(NEW) - 'status' = to_jsonb(OLD) - 'status' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'RuleSetVersion % is %: published rule sets are immutable', OLD."id", OLD."status"
    USING ERRCODE = 'check_violation', CONSTRAINT = 'ruleset_immutable';
END;
$$;

CREATE TRIGGER "RuleSetVersion_immutable"
  BEFORE UPDATE OR DELETE ON "RuleSetVersion"
  FOR EACH ROW EXECUTE FUNCTION rule_set_version_immutable();

ALTER TABLE "Decision"
  ADD CONSTRAINT decision_outcome CHECK ("outcome" IN ('APPROVE', 'PARTIAL', 'DENY', 'REFER', 'PEND')),
  -- PL-04 (D11): a decision carries its trace. coalesce, because a CHECK that evaluates to NULL passes.
  -- Keyed on the trace's `rules` array; if task 1.2 reshapes the trace, this moves with it.
  ADD CONSTRAINT decision_explanation CHECK (coalesce(
    jsonb_typeof("explanation") = 'object'
    AND jsonb_typeof("explanation" -> 'rules') = 'array'
    AND "explanation" -> 'rules' <> '[]'::jsonb, false)),
  -- D14: denied means no amount; an amount is never negative
  ADD CONSTRAINT decision_denied_no_amount CHECK ("outcome" <> 'DENY' OR "payableCents" IS NULL),
  ADD CONSTRAINT decision_amount_non_negative CHECK ("payableCents" >= 0),
  -- D18: an override carries its reason code and text; an engine decision carries neither
  ADD CONSTRAINT decision_override_reason CHECK (
    ("overridesId" IS NULL) = ("overrideReasonCode" IS NULL)
    AND ("overridesId" IS NULL) = ("overrideReasonText" IS NULL)
  ),
  ADD CONSTRAINT decision_hashes CHECK (
    "planHash" ~ '^[0-9a-f]{64}$' AND "opsHash" ~ '^[0-9a-f]{64}$'
    AND "inputHash" ~ '^[0-9a-f]{64}$' AND "outputHash" ~ '^[0-9a-f]{64}$'
  );

-- D13: append-only. A correction is a superseding row.
CREATE FUNCTION decision_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Decision is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'decision_append_only';
END;
$$;

CREATE TRIGGER "Decision_append_only"
  BEFORE UPDATE OR DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_append_only();

-- A decision pins one published (or since retired) plan version and one ops version, each of its own kind.
-- A draft can still change, so nothing may be decided under one.
CREATE FUNCTION decision_pins_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RuleSetVersion" WHERE "id" = NEW."planVersionId" AND "kind" = 'plan' AND "status" <> 'draft')
     OR NOT EXISTS (SELECT 1 FROM "RuleSetVersion" WHERE "id" = NEW."opsVersionId" AND "kind" = 'ops' AND "status" <> 'draft') THEN
    RAISE EXCEPTION 'Decision % must pin a published plan version and a published ops version', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'decision_pins_published';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Decision_pins_published"
  BEFORE INSERT ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_pins_published();
