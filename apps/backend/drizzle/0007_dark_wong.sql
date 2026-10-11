CREATE TABLE "connector_repo_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"repo" text NOT NULL,
	"installation_id" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_repo_links_workspace_kind_scope_unique" UNIQUE("workspace_id","kind","scope")
);
--> statement-breakpoint
CREATE TABLE "connector_run_repos" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"installation_id" integer NOT NULL,
	"base_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"branch" text NOT NULL,
	"title" text NOT NULL,
	"subject_url" text,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_repo_links" ADD CONSTRAINT "connector_repo_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_repo_links" ADD CONSTRAINT "connector_repo_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_run_repos" ADD CONSTRAINT "connector_run_repos_run_id_connector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."connector_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_run_repos" ADD CONSTRAINT "connector_run_repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_run_repos_workspace_id_idx" ON "connector_run_repos" USING btree ("workspace_id");