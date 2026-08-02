CREATE TABLE IF NOT EXISTS "degraded_recovery_evidence" (
	"scope_hash" varchar(64) PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"failure_class" varchar(64) NOT NULL,
	"source_instance_id" varchar(128) NOT NULL,
	"evidence_count" integer DEFAULT 1 NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keys" ADD COLUMN "session_failback_mode_override" varchar(20);--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "recovery_settings" jsonb;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "recovery_probe_budgets" jsonb;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "recovery_authority_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "session_binding_authority_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "recovery_settings" jsonb;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "recovery_probe_budgets" jsonb;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "session_failback_settings" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_degraded_recovery_evidence_pending" ON "degraded_recovery_evidence" USING btree ("reconciled_at","observed_at");
