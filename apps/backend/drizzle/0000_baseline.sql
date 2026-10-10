CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(60) DEFAULT '' NOT NULL,
	"avatar_url" text,
	"bio" varchar(280) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"dock_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_keys_user_fingerprint_unique" UNIQUE("user_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" text NOT NULL,
	"seats" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_organization_id_slug_unique" UNIQUE("organization_id","slug")
);
--> statement-breakpoint
CREATE TABLE "docks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(100),
	"cpus" integer DEFAULT 2 NOT NULL,
	"memory_mib" integer DEFAULT 4096 NOT NULL,
	"disk_gib" integer DEFAULT 20 NOT NULL,
	"image" text DEFAULT 'ubuntu-24.04' NOT NULL,
	"runtime" text DEFAULT 'microvm' NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"ttl_seconds" integer,
	"environment" text DEFAULT 'base' NOT NULL,
	"env_version_pin" text,
	"no_env" boolean DEFAULT false NOT NULL,
	"env_bound_at" timestamp with time zone,
	"env" jsonb NOT NULL,
	"from_template" text,
	"ip" text,
	"host_id" text,
	"created_by" uuid,
	"llm_token_hash" text,
	"setup_status" text DEFAULT 'pending' NOT NULL,
	"setup_error" text,
	"last_snapshot_at" timestamp with time zone,
	"disk_bytes" bigint DEFAULT 0 NOT NULL,
	"live_since" timestamp with time zone,
	"billing_paused_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dock_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dock_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" real DEFAULT 0 NOT NULL,
	"mem_bytes" bigint DEFAULT 0 NOT NULL,
	"mem_limit" bigint DEFAULT 0 NOT NULL,
	"disk_bytes" bigint DEFAULT 0 NOT NULL,
	"rx_bytes" bigint DEFAULT 0 NOT NULL,
	"tx_bytes" bigint DEFAULT 0 NOT NULL,
	"containers" jsonb,
	"source" text DEFAULT 'host' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dock_ports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dock_id" uuid NOT NULL,
	"port" integer NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dock_ports_label_unique" UNIQUE("label"),
	CONSTRAINT "dock_ports_dock_port_unique" UNIQUE("dock_id","port")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dock_id" uuid NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"manifest" jsonb NOT NULL,
	"store_snapshot_id" text,
	"cpu_family" text,
	"runtime" text,
	"kernel_release" text,
	"base_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"source_dock_id" uuid,
	"status" text DEFAULT 'saving' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"snapshot_ref" text,
	"store_snapshot_id" text,
	"cpu_family" text,
	"runtime" text,
	"base_fingerprint" text,
	"saving_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_id" text NOT NULL,
	"organization_id" uuid,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_display_id_unique" UNIQUE("display_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"body_hash" text NOT NULL,
	"dock_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"zdr_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_closures" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"purge_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"subscription_canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"base_fee_cents" integer NOT NULL,
	"included_usage_cents" integer NOT NULL,
	"concurrency_cap" integer NOT NULL,
	"fast_run_concurrency_cap" integer DEFAULT 0 NOT NULL,
	"retention_days" integer NOT NULL,
	"included_seats" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_plan_version_unique" UNIQUE("plan","version")
);
--> statement-breakpoint
CREATE TABLE "metering_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"dock_id" uuid,
	"runtime_id" text,
	"unit" text NOT NULL,
	"execution_target" text DEFAULT 'dock' NOT NULL,
	"cpus" integer DEFAULT 2 NOT NULL,
	"memory_mib" integer DEFAULT 4096 NOT NULL,
	"disk_gib" integer DEFAULT 20 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" text DEFAULT 'developer' NOT NULL,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"pending_plan" text,
	"pending_plan_version" integer,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "environment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"safe_for_third_parties" boolean DEFAULT false NOT NULL,
	"pass_github" boolean DEFAULT true NOT NULL,
	"pass_secrets" boolean DEFAULT true NOT NULL,
	"pass_dock_credentials" boolean DEFAULT false NOT NULL,
	"pass_agents_credentials" boolean DEFAULT true NOT NULL,
	"repos" jsonb NOT NULL,
	"env_vars" jsonb NOT NULL,
	"secret_files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_versions_environment_id_version_unique" UNIQUE("environment_id","version")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"secrets_access" text DEFAULT 'members' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"cpu_family" text NOT NULL,
	"kernel" text NOT NULL,
	"runtime" text DEFAULT 'microvm' NOT NULL,
	"kernel_release" text,
	"vcpu_total" integer DEFAULT 0 NOT NULL,
	"mem_total_bytes" bigint DEFAULT 0 NOT NULL,
	"mem_budget_bytes" bigint,
	"disk_total_bytes" bigint DEFAULT 0 NOT NULL,
	"max_docks" integer NOT NULL,
	"used_docks" integer DEFAULT 0 NOT NULL,
	"running" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_fingerprints" jsonb,
	"credential_hash" text,
	"state" text DEFAULT 'online' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_token" text NOT NULL,
	"deadline_ms" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "host_generations" (
	"generation_id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event_id_endpoint_id_unique" UNIQUE("event_id","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"secret" jsonb NOT NULL,
	"secret_prefix" varchar(8) NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"dock_id" uuid NOT NULL,
	"organization_id" uuid,
	"workspace_id" uuid,
	"state" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent" text DEFAULT 'opencode' NOT NULL,
	"test_command" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_run_artifacts_run_name_unique" UNIQUE("run_id","name")
);
--> statement-breakpoint
CREATE TABLE "github_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"organization_id" uuid,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"trigger_comment_id" integer NOT NULL,
	"delivery_guid" text NOT NULL,
	"hook_id" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"base_sha" text,
	"dock_id" uuid,
	"execution_target" text DEFAULT 'dock' NOT NULL,
	"requested_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_capabilities" jsonb,
	"attempt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"runtime_id" text,
	"runtime_host_id" text,
	"artifact_status" text DEFAULT 'pending' NOT NULL,
	"artifact_error" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"failure_reason" text,
	"sealed_token" jsonb,
	"agent" text DEFAULT 'opencode' NOT NULL,
	"test_command" text,
	"prompt_version" text,
	"envelope_hash" text,
	"envelope" jsonb,
	"instruction_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"branch" text,
	"completion_token_hash" text,
	"gateway_token_hash" text,
	"model" text,
	"llm_user_id" uuid,
	"completion_consumed" boolean DEFAULT false NOT NULL,
	"completion_status" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_runs_trigger_comment_id_unique" UNIQUE("trigger_comment_id")
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hook_id" text NOT NULL,
	"delivery_guid" text NOT NULL,
	"event" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"run_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_webhook_deliveries_hook_guid_unique" UNIQUE("hook_id","delivery_guid")
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_keys_organization_id_provider_unique" UNIQUE("organization_id","provider")
);
--> statement-breakpoint
CREATE TABLE "chatgpt_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text,
	"email" text,
	"plan_type" text,
	"status" text DEFAULT 'active' NOT NULL,
	"secret" jsonb NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatgpt_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_edges" (
	"organization_id" uuid NOT NULL,
	"edge_key" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_edges_organization_id_edge_key_pk" PRIMARY KEY("organization_id","edge_key")
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"dock_id" uuid,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_path" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_inbox_event_id_user_id_unique" UNIQUE("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_org_prefs" (
	"organization_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_org_prefs_organization_id_alert_type_pk" PRIMARY KEY("organization_id","alert_type")
);
--> statement-breakpoint
CREATE TABLE "notification_user_prefs" (
	"user_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_user_prefs_user_id_alert_type_pk" PRIMARY KEY("user_id","alert_type")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docks" ADD CONSTRAINT "docks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docks" ADD CONSTRAINT "docks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dock_stats" ADD CONSTRAINT "dock_stats_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dock_ports" ADD CONSTRAINT "dock_ports_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_closures" ADD CONSTRAINT "account_closures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering_windows" ADD CONSTRAINT "metering_windows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_versions" ADD CONSTRAINT "environment_versions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_run_artifacts" ADD CONSTRAINT "github_run_artifacts_run_id_github_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."github_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runs" ADD CONSTRAINT "github_runs_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runs" ADD CONSTRAINT "github_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runs" ADD CONSTRAINT "github_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runs" ADD CONSTRAINT "github_runs_llm_user_id_users_id_fk" FOREIGN KEY ("llm_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_run_id_github_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."github_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatgpt_connections" ADD CONSTRAINT "chatgpt_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_edges" ADD CONSTRAINT "notification_edges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_org_prefs" ADD CONSTRAINT "notification_org_prefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_user_prefs" ADD CONSTRAINT "notification_user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_dock_id_idx" ON "api_keys" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "ssh_keys_user_id_idx" ON "ssh_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ssh_keys_fingerprint_idx" ON "ssh_keys" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "organization_members_user_id_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_pending_idx" ON "organization_invitations" USING btree ("organization_id","email") WHERE "organization_invitations"."accepted_at" IS NULL AND "organization_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "workspaces_organization_id_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "docks_workspace_id_state_idx" ON "docks" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "docks_state_idx" ON "docks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "docks_llm_token_idx" ON "docks" USING btree ("llm_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "docks_workspace_id_name_unique" ON "docks" USING btree ("workspace_id","name") WHERE "docks"."name" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dock_stats_dock_id_at_idx" ON "dock_stats" USING btree ("dock_id","at");--> statement-breakpoint
CREATE INDEX "snapshots_dock_id_idx" ON "snapshots" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "snapshots_dock_id_created_at_idx" ON "snapshots" USING btree ("dock_id","created_at");--> statement-breakpoint
CREATE INDEX "templates_organization_id_idx" ON "templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "operations_status_idx" ON "operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "operations_organization_idx" ON "operations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "billing_plans_plan_current_idx" ON "billing_plans" USING btree ("plan","is_current");--> statement-breakpoint
CREATE INDEX "metering_windows_org_opened_idx" ON "metering_windows" USING btree ("organization_id","opened_at");--> statement-breakpoint
CREATE INDEX "metering_windows_dock_idx" ON "metering_windows" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "metering_windows_runtime_idx" ON "metering_windows" USING btree ("runtime_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metering_windows_open_dock_idx" ON "metering_windows" USING btree ("dock_id") WHERE "metering_windows"."closed_at" IS NULL AND "metering_windows"."dock_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_customer_idx" ON "subscriptions" USING btree ("provider_customer_id") WHERE "subscriptions"."provider_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "environment_versions_environment_id_idx" ON "environment_versions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "environments_organization_id_idx" ON "environments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "hosts_state_idx" ON "hosts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_credential_hash_idx" ON "hosts" USING btree ("credential_hash");--> statement-breakpoint
CREATE INDEX "host_commands_poll_idx" ON "host_commands" USING btree ("host_id","state","created_at");--> statement-breakpoint
CREATE INDEX "host_commands_state_created_idx" ON "host_commands" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "host_commands_dedupe_idx" ON "host_commands" USING btree ("host_id","idempotency_token");--> statement-breakpoint
CREATE UNIQUE INDEX "host_generations_command_idx" ON "host_generations" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "webhook_attempts_event_idx" ON "webhook_attempts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_attempts_endpoint_idx" ON "webhook_attempts" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "github_installations_workspace_idx" ON "github_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_run_artifacts_run_idx" ON "github_run_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "github_runs_repo_issue_idx" ON "github_runs" USING btree ("repo","issue_number","state");--> statement-breakpoint
CREATE INDEX "github_runs_installation_idx" ON "github_runs" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_runs_gateway_token_idx" ON "github_runs" USING btree ("gateway_token_hash");--> statement-breakpoint
CREATE INDEX "provider_keys_organization_id_idx" ON "provider_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_events_org_idx" ON "notification_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_inbox_user_idx" ON "notification_inbox" USING btree ("user_id");