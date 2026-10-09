-- ===========================================================================
-- Client portal & wedding galleries
--
-- Adds the couple-facing side of a project: portal identities and sessions,
-- per-project galleries, ceremony sections, sub-folders, media, generated
-- renditions, per-user selections, share links, comments, requests and
-- notifications.
--
-- PostgreSQL stores structure and decisions only. Every photograph and film
-- lives with the storage provider and is reached through "files" (§22) — a
-- wedding delivery is tens of gigabytes and must never sit in a bytea column.
-- ===========================================================================

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GallerySectionStatus" AS ENUM ('UPCOMING', 'SHOOT_COMPLETED', 'EDITING', 'PREVIEW_READY', 'GALLERY_READY', 'DELIVERED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryMediaType" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryMediaCategory" AS ENUM ('PHOTOS', 'VIDEOS', 'REELS', 'HIGHLIGHTS', 'DOCUMENTS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryMediaOrientation" AS ENUM ('LANDSCAPE', 'PORTRAIT', 'SQUARE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryDerivativeKind" AS ENUM ('THUMBNAIL', 'PREVIEW', 'WATERMARKED', 'HIGH_RES');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GallerySelectionKind" AS ENUM ('FAVORITE', 'ALBUM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryShareAccess" AS ENUM ('VIEW_ONLY', 'VIEW_DOWNLOAD', 'SELECTED_ONLY', 'SECTION_ONLY', 'FULL_GALLERY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GalleryShareStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ClientPortalUserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ClientPortalCommentType" AS ENUM ('GENERAL', 'RETOUCH_REQUEST', 'ALBUM_COVER', 'REMOVE_REQUEST');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ClientPortalRequestType" AS ENUM ('PHOTO_RETOUCH', 'VIDEO_CHANGE', 'ALBUM_CHANGE', 'SONG_CHANGE', 'NAME_CORRECTION', 'DELIVERY_REQUEST', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ClientPortalRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CLIENT', 'COMPLETED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ClientPortalNotificationType" AS ENUM ('GALLERY_READY', 'SECTION_UPLOADED', 'VIDEO_READY', 'PAYMENT_DUE', 'PAYMENT_RECEIVED', 'ALBUM_ACTION', 'REQUEST_UPDATE', 'DOCUMENT_NEW', 'GENERAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE "client_portal_users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(32),
    "password_hash" VARCHAR(255),
    "avatar_file_id" UUID,
    "status" "ClientPortalUserStatus" NOT NULL DEFAULT 'INVITED',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "invited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "client_portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_sessions" (
    "id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" "LogoutReason",

    CONSTRAINT "client_portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "galleries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "welcome_message" TEXT,
    "cover_file_id" UUID,
    "status" "GalleryStatus" NOT NULL DEFAULT 'DRAFT',
    "album_selection_target" INTEGER NOT NULL DEFAULT 60,
    "expected_delivery_date" DATE,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "galleries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_sections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "event_id" UUID,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "section_date" DATE,
    "venue_name" VARCHAR(200),
    "cover_file_id" UUID,
    "status" "GallerySectionStatus" NOT NULL DEFAULT 'UPCOMING',
    "lead_photographer" VARCHAR(160),
    "cinematographer" VARCHAR(160),
    "is_visible_to_client" BOOLEAN NOT NULL DEFAULT false,
    "is_download_allowed" BOOLEAN NOT NULL DEFAULT false,
    "is_share_allowed" BOOLEAN NOT NULL DEFAULT false,
    "is_face_search_allowed" BOOLEAN NOT NULL DEFAULT false,
    "has_watermark" BOOLEAN NOT NULL DEFAULT true,
    "expected_delivery_date" DATE,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "gallery_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_sub_folders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "cover_file_id" UUID,
    "color_token" VARCHAR(32),
    "is_client_visible" BOOLEAN NOT NULL DEFAULT true,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "gallery_sub_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_media" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "sub_folder_id" UUID,
    "file_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "media_type" "GalleryMediaType" NOT NULL,
    "category" "GalleryMediaCategory" NOT NULL DEFAULT 'PHOTOS',
    "width" INTEGER,
    "height" INTEGER,
    "orientation" "GalleryMediaOrientation",
    "duration_seconds" INTEGER,
    "captured_at" TIMESTAMPTZ(6),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photographer_credit" VARCHAR(200),
    "is_client_visible" BOOLEAN NOT NULL DEFAULT true,
    "is_download_allowed" BOOLEAN NOT NULL DEFAULT true,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "gallery_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_media_derivatives" (
    "id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "kind" "GalleryDerivativeKind" NOT NULL,
    "file_id" UUID NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_media_derivatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_media_selections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "kind" "GallerySelectionKind" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_media_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_share_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "section_id" UUID,
    "token" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "access_type" "GalleryShareAccess" NOT NULL DEFAULT 'VIEW_ONLY',
    "password_hash" VARCHAR(255),
    "watermark_enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "GalleryShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6),
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "downloads_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_by_portal_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "gallery_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_share_link_media" (
    "share_link_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,

    CONSTRAINT "gallery_share_link_media_pkey" PRIMARY KEY ("share_link_id","media_id")
);

-- CreateTable
CREATE TABLE "client_portal_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "media_id" UUID,
    "portal_user_id" UUID,
    "author_user_id" UUID,
    "type" "ClientPortalCommentType" NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "client_portal_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "related_media_id" UUID,
    "type" "ClientPortalRequestType" NOT NULL DEFAULT 'OTHER',
    "status" "ClientPortalRequestStatus" NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "admin_response" TEXT,
    "assigned_to_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "client_portal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_notifications" (
    "id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "project_id" UUID,
    "type" "ClientPortalNotificationType" NOT NULL DEFAULT 'GENERAL',
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "action_path" VARCHAR(255),
    "action_label" VARCHAR(80),
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portal_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_portal_users_client_id_status_idx" ON "client_portal_users"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_users_organization_id_email_key" ON "client_portal_users"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_sessions_refresh_token_hash_key" ON "client_portal_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "client_portal_sessions_portal_user_id_status_idx" ON "client_portal_sessions"("portal_user_id", "status");

-- CreateIndex
CREATE INDEX "client_portal_sessions_expires_at_idx" ON "client_portal_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "galleries_project_id_key" ON "galleries"("project_id");

-- CreateIndex
CREATE INDEX "galleries_organization_id_status_idx" ON "galleries"("organization_id", "status");

-- CreateIndex
CREATE INDEX "gallery_sections_gallery_id_order_index_idx" ON "gallery_sections"("gallery_id", "order_index");

-- CreateIndex
CREATE INDEX "gallery_sections_gallery_id_is_visible_to_client_idx" ON "gallery_sections"("gallery_id", "is_visible_to_client");

-- CreateIndex
CREATE INDEX "gallery_sections_event_id_idx" ON "gallery_sections"("event_id");

-- CreateIndex
CREATE INDEX "gallery_sub_folders_gallery_id_order_index_idx" ON "gallery_sub_folders"("gallery_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_sub_folders_section_id_name_key" ON "gallery_sub_folders"("section_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_media_file_id_key" ON "gallery_media"("file_id");

-- CreateIndex
CREATE INDEX "gallery_media_gallery_id_order_index_idx" ON "gallery_media"("gallery_id", "order_index");

-- CreateIndex
CREATE INDEX "gallery_media_section_id_is_client_visible_idx" ON "gallery_media"("section_id", "is_client_visible");

-- CreateIndex
CREATE INDEX "gallery_media_sub_folder_id_idx" ON "gallery_media"("sub_folder_id");

-- CreateIndex
CREATE INDEX "gallery_media_derivatives_file_id_idx" ON "gallery_media_derivatives"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_media_derivatives_media_id_kind_key" ON "gallery_media_derivatives"("media_id", "kind");

-- CreateIndex
CREATE INDEX "gallery_media_selections_portal_user_id_kind_idx" ON "gallery_media_selections"("portal_user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_media_selections_media_id_portal_user_id_kind_key" ON "gallery_media_selections"("media_id", "portal_user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_share_links_token_key" ON "gallery_share_links"("token");

-- CreateIndex
CREATE INDEX "gallery_share_links_gallery_id_status_idx" ON "gallery_share_links"("gallery_id", "status");

-- CreateIndex
CREATE INDEX "gallery_share_links_expires_at_idx" ON "gallery_share_links"("expires_at");

-- CreateIndex
CREATE INDEX "gallery_share_link_media_media_id_idx" ON "gallery_share_link_media"("media_id");

-- CreateIndex
CREATE INDEX "client_portal_comments_gallery_id_is_resolved_created_at_idx" ON "client_portal_comments"("gallery_id", "is_resolved", "created_at");

-- CreateIndex
CREATE INDEX "client_portal_comments_media_id_idx" ON "client_portal_comments"("media_id");

-- CreateIndex
CREATE INDEX "client_portal_requests_organization_id_status_created_at_idx" ON "client_portal_requests"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "client_portal_requests_gallery_id_status_idx" ON "client_portal_requests"("gallery_id", "status");

-- CreateIndex
CREATE INDEX "client_portal_requests_assigned_to_id_idx" ON "client_portal_requests"("assigned_to_id");

-- CreateIndex
CREATE INDEX "client_portal_notifications_portal_user_id_is_read_created__idx" ON "client_portal_notifications"("portal_user_id", "is_read", "created_at");

-- AddForeignKey
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_avatar_file_id_fkey" FOREIGN KEY ("avatar_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_sessions" ADD CONSTRAINT "client_portal_sessions_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "galleries" ADD CONSTRAINT "galleries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "galleries" ADD CONSTRAINT "galleries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "galleries" ADD CONSTRAINT "galleries_cover_file_id_fkey" FOREIGN KEY ("cover_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sections" ADD CONSTRAINT "gallery_sections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sections" ADD CONSTRAINT "gallery_sections_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sections" ADD CONSTRAINT "gallery_sections_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sections" ADD CONSTRAINT "gallery_sections_cover_file_id_fkey" FOREIGN KEY ("cover_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sub_folders" ADD CONSTRAINT "gallery_sub_folders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sub_folders" ADD CONSTRAINT "gallery_sub_folders_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sub_folders" ADD CONSTRAINT "gallery_sub_folders_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "gallery_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_sub_folders" ADD CONSTRAINT "gallery_sub_folders_cover_file_id_fkey" FOREIGN KEY ("cover_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media" ADD CONSTRAINT "gallery_media_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media" ADD CONSTRAINT "gallery_media_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media" ADD CONSTRAINT "gallery_media_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "gallery_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media" ADD CONSTRAINT "gallery_media_sub_folder_id_fkey" FOREIGN KEY ("sub_folder_id") REFERENCES "gallery_sub_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media" ADD CONSTRAINT "gallery_media_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media_derivatives" ADD CONSTRAINT "gallery_media_derivatives_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "gallery_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media_derivatives" ADD CONSTRAINT "gallery_media_derivatives_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media_selections" ADD CONSTRAINT "gallery_media_selections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media_selections" ADD CONSTRAINT "gallery_media_selections_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "gallery_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_media_selections" ADD CONSTRAINT "gallery_media_selections_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_links" ADD CONSTRAINT "gallery_share_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_links" ADD CONSTRAINT "gallery_share_links_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_links" ADD CONSTRAINT "gallery_share_links_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "gallery_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_links" ADD CONSTRAINT "gallery_share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_link_media" ADD CONSTRAINT "gallery_share_link_media_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "gallery_share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_share_link_media" ADD CONSTRAINT "gallery_share_link_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "gallery_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "gallery_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_comments" ADD CONSTRAINT "client_portal_comments_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_related_media_id_fkey" FOREIGN KEY ("related_media_id") REFERENCES "gallery_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_requests" ADD CONSTRAINT "client_portal_requests_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_notifications" ADD CONSTRAINT "client_portal_notifications_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_notifications" ADD CONSTRAINT "client_portal_notifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "freelancer_onboarding_tokens_freelancer_id_used_at_invalidated_" RENAME TO "freelancer_onboarding_tokens_freelancer_id_used_at_invalida_idx";

-- RenameIndex
ALTER INDEX "freelancer_portfolio_items_freelancer_id_is_published_sort_orde" RENAME TO "freelancer_portfolio_items_freelancer_id_is_published_sort__idx";

-- ===========================================================================
-- DATABASE-LEVEL BUSINESS RULES
--
-- Prisma cannot express CHECK constraints, so they are declared here. These are
-- NOT duplicated application validations — they are the last line of defence
-- that holds even if a bug, a psql session or a future service bypasses the
-- service layer.
-- ===========================================================================

-- --- Comment authorship -----------------------------------------------------
-- A gallery comment is written either by the couple OR by a studio user, never
-- both and never neither.
ALTER TABLE "client_portal_comments"
  ADD CONSTRAINT "client_portal_comments_exactly_one_author"
  CHECK (num_nonnulls("portal_user_id", "author_user_id") = 1);

-- A comment is only resolved together with the moment it was resolved.
ALTER TABLE "client_portal_comments"
  ADD CONSTRAINT "client_portal_comments_resolved_consistency"
  CHECK (("is_resolved" IS FALSE AND "resolved_at" IS NULL) OR "is_resolved" IS TRUE);

-- --- Gallery integrity ------------------------------------------------------
ALTER TABLE "galleries"
  ADD CONSTRAINT "galleries_album_target_positive"
  CHECK ("album_selection_target" > 0);

ALTER TABLE "gallery_media"
  ADD CONSTRAINT "gallery_media_dimensions_positive"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));

-- Only a film carries a duration, and a film's duration is never zero.
ALTER TABLE "gallery_media"
  ADD CONSTRAINT "gallery_media_duration_videos_only"
  CHECK ("duration_seconds" IS NULL OR ("duration_seconds" > 0 AND "media_type" = 'VIDEO'));

ALTER TABLE "gallery_media"
  ADD CONSTRAINT "gallery_media_counters_non_negative"
  CHECK ("view_count" >= 0 AND "download_count" >= 0);

ALTER TABLE "gallery_media_derivatives"
  ADD CONSTRAINT "gallery_media_derivatives_dimensions_positive"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));

ALTER TABLE "gallery_sections"
  ADD CONSTRAINT "gallery_sections_order_non_negative"
  CHECK ("order_index" >= 0);

ALTER TABLE "gallery_sub_folders"
  ADD CONSTRAINT "gallery_sub_folders_order_non_negative"
  CHECK ("order_index" >= 0);

-- --- Share links ------------------------------------------------------------
ALTER TABLE "gallery_share_links"
  ADD CONSTRAINT "gallery_share_links_counters_non_negative"
  CHECK ("views_count" >= 0 AND "downloads_count" >= 0);

-- A link that expires must expire after it was made.
ALTER TABLE "gallery_share_links"
  ADD CONSTRAINT "gallery_share_links_expiry_after_creation"
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");

-- A revoked link records when it was revoked, and only a revoked link does.
ALTER TABLE "gallery_share_links"
  ADD CONSTRAINT "gallery_share_links_revoked_consistency"
  CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL));

-- --- Portal accounts --------------------------------------------------------
ALTER TABLE "client_portal_users"
  ADD CONSTRAINT "client_portal_users_failed_attempts_non_negative"
  CHECK ("failed_login_attempts" >= 0);

-- An ACTIVE portal account can sign in, so it must have a password set.
ALTER TABLE "client_portal_users"
  ADD CONSTRAINT "client_portal_users_active_requires_password"
  CHECK ("status" <> 'ACTIVE' OR "password_hash" IS NOT NULL);
