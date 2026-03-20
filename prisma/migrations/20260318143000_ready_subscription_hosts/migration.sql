CREATE TABLE "ready_subscription_hosts" (
    "host_uuid" UUID NOT NULL,
    "preset_uuid" UUID NOT NULL,
    "auto_replace" BOOLEAN NOT NULL DEFAULT true,
    "active_node_limit" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ready_subscription_hosts_pkey" PRIMARY KEY ("host_uuid")
);

CREATE TABLE "ready_subscription_host_nodes" (
    "host_uuid" UUID NOT NULL,
    "dedupe_key" VARCHAR(64) NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "view_position" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ready_subscription_host_nodes_pkey" PRIMARY KEY ("host_uuid","dedupe_key")
);

CREATE INDEX "ready_subscription_hosts_preset_uuid_idx" ON "ready_subscription_hosts"("preset_uuid");
CREATE INDEX "ready_subscription_host_nodes_host_uuid_view_position_idx" ON "ready_subscription_host_nodes"("host_uuid", "view_position");

ALTER TABLE "ready_subscription_hosts"
ADD CONSTRAINT "ready_subscription_hosts_host_uuid_fkey"
FOREIGN KEY ("host_uuid") REFERENCES "hosts"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ready_subscription_hosts"
ADD CONSTRAINT "ready_subscription_hosts_preset_uuid_fkey"
FOREIGN KEY ("preset_uuid") REFERENCES "external_vless_presets"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ready_subscription_host_nodes"
ADD CONSTRAINT "ready_subscription_host_nodes_host_uuid_fkey"
FOREIGN KEY ("host_uuid") REFERENCES "ready_subscription_hosts"("host_uuid") ON DELETE CASCADE ON UPDATE CASCADE;
