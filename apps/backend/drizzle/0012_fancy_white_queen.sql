CREATE TABLE "dock_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dock_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"image" text NOT NULL,
	"cpus" integer NOT NULL,
	"memory_mib" integer NOT NULL,
	"disk_gib" integer NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"base_image" text,
	"store_snapshot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dock_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" varchar(100),
	"image" text NOT NULL,
	"cpus" integer NOT NULL,
	"memory_mib" integer NOT NULL,
	"disk_gib" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"store_snapshot_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"mode" text NOT NULL,
	"part_size" bigint NOT NULL,
	"part_count" integer NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"error" text,
	"dock_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dock_exports_expires_at_idx" ON "dock_exports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "dock_exports_dock_id_idx" ON "dock_exports" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "dock_imports_expires_at_idx" ON "dock_imports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "dock_imports_organization_id_idx" ON "dock_imports" USING btree ("organization_id");