-- One-time invite and password-reset tokens for client-portal users.
CREATE TYPE "PortalTokenType" AS ENUM ('INVITE', 'RESET_PASSWORD');

CREATE TABLE "portal_tokens" (
    "id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "type" "PortalTokenType" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "portal_tokens_token_hash_key" ON "portal_tokens"("token_hash");
CREATE INDEX "portal_tokens_portal_user_id_type_idx" ON "portal_tokens"("portal_user_id", "type");

ALTER TABLE "portal_tokens" ADD CONSTRAINT "portal_tokens_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "client_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
