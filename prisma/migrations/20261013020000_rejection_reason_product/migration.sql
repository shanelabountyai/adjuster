-- Hand-written. D85 (task 4.7): a rejection reason belongs to a product, so the key is (product, code) and a review
-- names both. Every row and every review so far is the first product's.

ALTER TABLE "DocumentReview" DROP CONSTRAINT "DocumentReview_reasonCode_fkey";

ALTER TABLE "DocumentRejectionReason" DROP CONSTRAINT "DocumentRejectionReason_pkey", ADD COLUMN "product" TEXT;
UPDATE "DocumentRejectionReason" SET "product" = 'electronics';
ALTER TABLE "DocumentRejectionReason" ALTER COLUMN "product" SET NOT NULL,
  ADD CONSTRAINT "DocumentRejectionReason_pkey" PRIMARY KEY ("product", "code");

-- The whole list, one statement, so a test whose reset emptied the table puts it back by running this again.
-- Electronics' five are domain brief §8's (D54); furniture's are §12's, item mismatch in place of serial mismatch (V4).
INSERT INTO "DocumentRejectionReason" ("product", "code") VALUES
  ('electronics', 'illegible'), ('electronics', 'wrong_document'), ('electronics', 'serial_mismatch'), ('electronics', 'date_inconsistent'), ('electronics', 'incomplete'),
  ('furniture', 'illegible'), ('furniture', 'wrong_document'), ('furniture', 'item_mismatch'), ('furniture', 'date_inconsistent'), ('furniture', 'incomplete')
  ON CONFLICT DO NOTHING;

-- The review is insert-only (D53), so the one backfill it will ever get is made with its trigger off.
ALTER TABLE "DocumentReview" ADD COLUMN "reasonProduct" TEXT;
ALTER TABLE "DocumentReview" DISABLE TRIGGER "DocumentReview_append_only";
UPDATE "DocumentReview" SET "reasonProduct" = 'electronics' WHERE "reasonCode" IS NOT NULL;
ALTER TABLE "DocumentReview" ENABLE TRIGGER "DocumentReview_append_only";

ALTER TABLE "DocumentReview"
  -- the old name, so a reason that is not on the product's list is refused as an unknown one always was
  ADD CONSTRAINT "DocumentReview_reasonCode_fkey" FOREIGN KEY ("reasonProduct", "reasonCode")
    REFERENCES "DocumentRejectionReason"("product", "code") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- MATCH SIMPLE skips a key with a null in it: a reason with no product would be checked against nothing
  ADD CONSTRAINT document_review_reason_product CHECK (("reasonCode" IS NULL) = ("reasonProduct" IS NULL));
