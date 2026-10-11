CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"credentials" jsonb NOT NULL,
	"account_label" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_workspace_id_kind_unique" UNIQUE("workspace_id","kind")
);
--> statement-breakpoint
ALTER TABLE "docks" ADD COLUMN "connectors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docks" ADD COLUMN "connector_token_hash" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connectors_workspace_id_idx" ON "connectors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "docks_connector_token_idx" ON "docks" USING btree ("connector_token_hash");