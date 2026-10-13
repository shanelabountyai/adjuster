-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "decisionId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "providerRef" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "paidBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_decisionId_key" ON "Payment"("decisionId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below, as in 20261005000000_documents.

-- D60: a payment is money that went out; nothing and a refund are not payments.
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount CHECK ("amountCents" > 0);

-- D60: a payment that was made is never edited or removed.
CREATE TRIGGER "Payment_append_only"
  BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
