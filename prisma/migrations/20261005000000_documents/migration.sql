-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "uploadedBy" UUID,
    "uploadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_claimId_type_key" ON "Document"("claimId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below, as in 20261002000000_adjudication_init: each rejection names its rule in the error's
-- constraint field. TRUNCATE is left alone, so tests and the seed can still empty the tables.

ALTER TABLE "DocumentVersion"
  -- The DB checks the hash's shape; the DocumentStore checks its value on every read.
  ADD CONSTRAINT document_version_sha256 CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT document_version_number CHECK ("version" >= 1),
  ADD CONSTRAINT document_version_source CHECK ("source" <> '');

-- Domain brief §8, D53: never overwrite or delete an upload. Both tables are insert-only; a version's status is
-- derived from later rows, never written back onto this one.
CREATE FUNCTION document_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'document_append_only';
END;
$$;

CREATE TRIGGER "Document_append_only"
  BEFORE UPDATE OR DELETE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();

CREATE TRIGGER "DocumentVersion_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION document_append_only();
