CREATE TABLE "external_vless_presets" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "view_position" SERIAL NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "source_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "include_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "required_security" VARCHAR(20),
    "selection_limit" INTEGER NOT NULL DEFAULT 5,
    "country_mode" VARCHAR(20) NOT NULL DEFAULT 'ANY',
    "unique_countries" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_vless_presets_pkey" PRIMARY KEY ("uuid")
);

CREATE TABLE "external_vless_nodes" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "preset_uuid" UUID NOT NULL,
    "dedupe_key" VARCHAR(64) NOT NULL,
    "raw_uri" TEXT NOT NULL,
    "source_position" INTEGER NOT NULL DEFAULT 0,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "original_remark" TEXT NOT NULL,
    "alias_remark" TEXT,
    "remark_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "credential" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "resolved_address" TEXT,
    "country_code" VARCHAR(2),
    "country_name" TEXT,
    "display_country" TEXT,
    "port" INTEGER NOT NULL,
    "network" VARCHAR(20) NOT NULL DEFAULT 'tcp',
    "security" VARCHAR(20) NOT NULL DEFAULT 'none',
    "host" TEXT,
    "path" TEXT,
    "service_name" TEXT,
    "authority" TEXT,
    "sni" TEXT,
    "alpn" TEXT,
    "fingerprint" TEXT,
    "public_key" TEXT,
    "short_id" TEXT,
    "spider_x" TEXT,
    "flow" TEXT,
    "encryption" TEXT,
    "is_alive" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_vless_nodes_pkey" PRIMARY KEY ("uuid")
);

CREATE UNIQUE INDEX "external_vless_presets_slug_key" ON "external_vless_presets"("slug");
CREATE UNIQUE INDEX "external_vless_nodes_preset_uuid_dedupe_key_key" ON "external_vless_nodes"("preset_uuid", "dedupe_key");
CREATE INDEX "external_vless_nodes_preset_uuid_is_enabled_is_pinned_idx" ON "external_vless_nodes"("preset_uuid", "is_enabled", "is_pinned");
CREATE INDEX "external_vless_nodes_preset_uuid_is_alive_latency_ms_idx" ON "external_vless_nodes"("preset_uuid", "is_alive", "latency_ms");

ALTER TABLE "external_vless_nodes"
ADD CONSTRAINT "external_vless_nodes_preset_uuid_fkey"
FOREIGN KEY ("preset_uuid") REFERENCES "external_vless_presets"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;
