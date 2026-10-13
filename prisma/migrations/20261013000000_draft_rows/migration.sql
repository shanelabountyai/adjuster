-- AlterTable
ALTER TABLE "RuleSetVersion" ADD COLUMN     "authoredBy" UUID,
ADD COLUMN     "basedOnId" UUID,
ADD COLUMN     "publishedBy" UUID;

-- AddForeignKey
ALTER TABLE "RuleSetVersion" ADD CONSTRAINT "RuleSetVersion_basedOnId_fkey" FOREIGN KEY ("basedOnId") REFERENCES "RuleSetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below (task 4.2, D70).

-- The content that goes live was last written by one person and approved by another. Either may be null (a version
-- loaded from a file has neither), and a comparison with NULL passes a CHECK, which is what is wanted here.
ALTER TABLE "RuleSetVersion"
  ADD CONSTRAINT ruleset_author_not_publisher CHECK ("authoredBy" <> "publishedBy");

-- One open draft per kind and product.
CREATE UNIQUE INDEX "RuleSetVersion_one_draft" ON "RuleSetVersion"("kind", "product") WHERE "status" = 'draft';
