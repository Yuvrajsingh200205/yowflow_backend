-- Ready-made templates: remember where a price-list item came from, and whether its price is still only an example.
ALTER TABLE "catalog_items" ADD COLUMN "is_example" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "catalog_items" ADD COLUMN "template_key" VARCHAR(60);
