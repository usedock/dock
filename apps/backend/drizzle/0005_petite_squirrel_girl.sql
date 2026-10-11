ALTER TABLE "templates" ADD COLUMN "had_connectors" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "templates" SET "had_connectors" = (jsonb_array_length("docks"."connectors") > 0) FROM "docks" WHERE "docks"."id" = "templates"."source_dock_id";
