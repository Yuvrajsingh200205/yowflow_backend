-- CreateEnum
CREATE TYPE "CatalogItemKind" AS ENUM ('PACKAGE', 'ADDON');


-- CreateEnum
CREATE TYPE "CatalogPricingType" AS ENUM ('FIXED', 'PER_DAY', 'PER_PERSON');


-- CreateEnum
CREATE TYPE "QuotationItemKind" AS ENUM ('PACKAGE', 'ADDON', 'CUSTOM');


-- CreateEnum
CREATE TYPE "EnquiryQuoteMode" AS ENUM ('OFF', 'APPROVAL', 'AUTO');


-- CreateEnum
CREATE TYPE "QuotationEventType" AS ENUM ('CREATED', 'APPROVED', 'SENT', 'VIEWED', 'REVISED', 'ACCEPTED', 'DECLINED', 'MESSAGE_RECEIVED', 'REMINDER_SENT', 'EXPIRED', 'BOOKED');


-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "guest_count" INTEGER,
ADD COLUMN     "interested_package_id" UUID;


-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "advance_percent" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "balance_due_days_before" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "bank_account_name" VARCHAR(160),
ADD COLUMN     "bank_account_number" VARCHAR(40),
ADD COLUMN     "bank_ifsc" VARCHAR(16),
ADD COLUMN     "bank_name" VARCHAR(120),
ADD COLUMN     "brand_color" VARCHAR(7),
ADD COLUMN     "capacity_per_day" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "default_terms" TEXT,
ADD COLUMN     "max_advance_days" INTEGER NOT NULL DEFAULT 730,
ADD COLUMN     "min_lead_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quote_valid_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "reminders_email_clients" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reminders_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "upi_id" VARCHAR(120);


-- AlterTable
ALTER TABLE "quotation_items" ADD COLUMN     "allow_quantity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "catalog_item_id" UUID,
ADD COLUMN     "is_optional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_selected" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" "QuotationItemKind" NOT NULL DEFAULT 'CUSTOM',
ADD COLUMN     "max_quantity" INTEGER,
ADD COLUMN     "min_quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "pricing_type" "CatalogPricingType" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "unit_label" VARCHAR(30);


-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "accepted_by_name" VARCHAR(160),
ADD COLUMN     "accepted_ip" VARCHAR(64),
ADD COLUMN     "accepted_user_agent" VARCHAR(512),
ADD COLUMN     "advance_percent" INTEGER,
ADD COLUMN     "auto_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "balance_due_days_before" INTEGER,
ADD COLUMN     "customer_email" VARCHAR(160),
ADD COLUMN     "customer_name" VARCHAR(160),
ADD COLUMN     "customer_phone" VARCHAR(32),
ADD COLUMN     "decline_reason" VARCHAR(500),
ADD COLUMN     "declined_at" TIMESTAMPTZ(6),
ADD COLUMN     "event_date" DATE,
ADD COLUMN     "event_days" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "event_type" "ProjectType",
ADD COLUMN     "first_viewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "guest_count" INTEGER,
ADD COLUMN     "last_viewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "lead_id" UUID,
ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "public_token" VARCHAR(64),
ADD COLUMN     "sent_at" TIMESTAMPTZ(6),
ADD COLUMN     "sent_via" VARCHAR(20),
ADD COLUMN     "venue_city" VARCHAR(80),
ADD COLUMN     "venue_name" VARCHAR(200),
ADD COLUMN     "view_count" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "client_id" DROP NOT NULL;


-- CreateTable
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "CatalogItemKind" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(60),
    "inclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricing_type" "CatalogPricingType" NOT NULL DEFAULT 'FIXED',
    "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unit_label" VARCHAR(30),
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "allow_quantity" BOOLEAN NOT NULL DEFAULT false,
    "min_quantity" INTEGER NOT NULL DEFAULT 1,
    "max_quantity" INTEGER,
    "event_types" "ProjectType"[] DEFAULT ARRAY[]::"ProjectType"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_popular" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "enquiry_pages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "headline" VARCHAR(160),
    "intro" TEXT,
    "thank_you_message" TEXT,
    "auto_quote_mode" "EnquiryQuoteMode" NOT NULL DEFAULT 'APPROVAL',
    "show_prices" BOOLEAN NOT NULL DEFAULT true,
    "ask_guest_count" BOOLEAN NOT NULL DEFAULT false,
    "ask_venue" BOOLEAN NOT NULL DEFAULT true,
    "event_types" "ProjectType"[] DEFAULT ARRAY[]::"ProjectType"[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enquiry_pages_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "blocked_dates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" VARCHAR(200),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_dates_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "quotation_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "type" "QuotationEventType" NOT NULL,
    "actor_type" VARCHAR(10) NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_events_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "reminder_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "meta" JSONB,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_logs_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "catalog_items_organization_id_kind_is_active_idx" ON "catalog_items"("organization_id", "kind", "is_active");


-- CreateIndex
CREATE INDEX "catalog_items_organization_id_sort_order_idx" ON "catalog_items"("organization_id", "sort_order");


-- CreateIndex
CREATE UNIQUE INDEX "enquiry_pages_organization_id_key" ON "enquiry_pages"("organization_id");


-- CreateIndex
CREATE INDEX "blocked_dates_organization_id_start_date_end_date_idx" ON "blocked_dates"("organization_id", "start_date", "end_date");


-- CreateIndex
CREATE INDEX "quotation_events_quotation_id_created_at_idx" ON "quotation_events"("quotation_id", "created_at");


-- CreateIndex
CREATE INDEX "quotation_events_organization_id_created_at_idx" ON "quotation_events"("organization_id", "created_at");


-- CreateIndex
CREATE UNIQUE INDEX "reminder_logs_dedupe_key_key" ON "reminder_logs"("dedupe_key");


-- CreateIndex
CREATE INDEX "reminder_logs_organization_id_sent_at_idx" ON "reminder_logs"("organization_id", "sent_at");


-- CreateIndex
CREATE INDEX "quotation_items_catalog_item_id_idx" ON "quotation_items"("catalog_item_id");


-- CreateIndex
CREATE UNIQUE INDEX "quotations_public_token_key" ON "quotations"("public_token");


-- CreateIndex
CREATE INDEX "quotations_lead_id_idx" ON "quotations"("lead_id");


-- CreateIndex
CREATE INDEX "quotations_organization_id_status_valid_until_idx" ON "quotations"("organization_id", "status", "valid_until");


-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_interested_package_id_fkey" FOREIGN KEY ("interested_package_id") REFERENCES "catalog_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "enquiry_pages" ADD CONSTRAINT "enquiry_pages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "blocked_dates" ADD CONSTRAINT "blocked_dates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "quotation_events" ADD CONSTRAINT "quotation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "quotation_events" ADD CONSTRAINT "quotation_events_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data integrity (not expressible in the Prisma schema)
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_unit_price_check" CHECK ("unit_price" >= 0);
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tax_rate_check" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_quantity_check" CHECK ("min_quantity" >= 1 AND ("max_quantity" IS NULL OR "max_quantity" >= "min_quantity"));
ALTER TABLE "blocked_dates" ADD CONSTRAINT "blocked_dates_range_check" CHECK ("end_date" >= "start_date");
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_advance_percent_check" CHECK ("advance_percent" >= 0 AND "advance_percent" <= 100);
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_sales_defaults_check" CHECK ("quote_valid_days" BETWEEN 1 AND 365 AND "balance_due_days_before" BETWEEN 0 AND 365);
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_availability_check" CHECK ("capacity_per_day" BETWEEN 1 AND 50 AND "min_lead_days" BETWEEN 0 AND 365 AND "max_advance_days" BETWEEN 30 AND 1825);
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_event_days_check" CHECK ("event_days" >= 1 AND "event_days" <= 60);
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_advance_percent_check" CHECK ("advance_percent" IS NULL OR ("advance_percent" >= 0 AND "advance_percent" <= 100));
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quantity_check" CHECK ("min_quantity" >= 1 AND ("max_quantity" IS NULL OR "max_quantity" >= "min_quantity"));
