CREATE TABLE "connector_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_deliveries_kind_delivery_id_unique" UNIQUE("kind","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"trigger_key" text NOT NULL,
	"organization_id" uuid,
	"agent" text DEFAULT 'opencode' NOT NULL,
	"model" text,
	"gateway_token_hash" text,
	"reply" jsonb NOT NULL,
	"dock_id" uuid,
	"completion_token_hash" text NOT NULL,
	"summary" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "webhook_secret" jsonb;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "vendor_user_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "vendor_org" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "allowed_users" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "triggers_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_deliveries_received_at_idx" ON "connector_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "connector_runs_workspace_id_idx" ON "connector_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "connector_runs_state_idx" ON "connector_runs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_kind_external_id_unique" ON "connectors" USING btree ("kind","external_id") WHERE "connectors"."external_id" is not null;