ALTER TABLE "external_vless_nodes"
ADD COLUMN "custom_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
