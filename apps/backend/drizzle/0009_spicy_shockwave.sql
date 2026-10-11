ALTER TABLE "environment_versions" ADD COLUMN "egress_allow" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "features" jsonb DEFAULT '[]'::jsonb NOT NULL;