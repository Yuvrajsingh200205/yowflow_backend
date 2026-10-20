-- API keys for programmatic access.
CREATE TYPE "ApiKeyScope" AS ENUM ('READ_ONLY', 'FULL');

CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(20) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "scope" "ApiKeyScope" NOT NULL DEFAULT 'READ_ONLY',
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
