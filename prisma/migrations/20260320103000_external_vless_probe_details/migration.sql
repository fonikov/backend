ALTER TABLE "external_vless_nodes"
ADD COLUMN "tcp_latency_ms" INTEGER,
ADD COLUMN "transport_latency_ms" INTEGER,
ADD COLUMN "transport_probe" VARCHAR(20) NOT NULL DEFAULT 'NONE';
