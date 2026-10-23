-- AlterTable
ALTER TABLE "quotation_items" ADD COLUMN "inclusions" TEXT[] DEFAULT ARRAY[]::TEXT[];
