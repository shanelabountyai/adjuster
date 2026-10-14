-- Hand-written. D89 b (task 4.13): a rejection reason carries the words a claimant reads, so a pend letter can say why
-- a document they sent was not accepted. The letter completes "The copy you sent was not accepted because ...".
-- Wording is reference data, not code, and it is frozen once written: a letter renders the same bytes for ever.

ALTER TABLE "DocumentRejectionReason" ADD COLUMN "claimantText" TEXT;

-- The whole list, one statement, so a test whose reset emptied the table puts it back by running this again.
INSERT INTO "DocumentRejectionReason" ("product", "code", "claimantText") VALUES
  ('electronics', 'illegible', 'we could not read it'),
  ('electronics', 'wrong_document', 'it is not the document we asked for'),
  ('electronics', 'serial_mismatch', 'the serial number on it is not the one on your contract'),
  ('electronics', 'date_inconsistent', 'the dates on it do not match the dates of your claim'),
  ('electronics', 'incomplete', 'part of it is missing'),
  ('furniture', 'illegible', 'we could not read it'),
  ('furniture', 'wrong_document', 'it is not the document we asked for'),
  ('furniture', 'item_mismatch', 'the item on it is not the one on your contract'),
  ('furniture', 'date_inconsistent', 'the dates on it do not match the dates of your claim'),
  ('furniture', 'incomplete', 'part of it is missing')
  ON CONFLICT ("product", "code") DO UPDATE SET "claimantText" = EXCLUDED."claimantText";

ALTER TABLE "DocumentRejectionReason" ALTER COLUMN "claimantText" SET NOT NULL;

-- A changed row would change every letter already rendered from it. New wording is a new code.
CREATE FUNCTION rejection_reason_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'DocumentRejectionReason % / % is frozen', OLD."product", OLD."code"; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentRejectionReason_frozen"
  BEFORE UPDATE ON "DocumentRejectionReason"
  FOR EACH ROW EXECUTE FUNCTION rejection_reason_frozen();
