CREATE TABLE IF NOT EXISTS "recovery_probe_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" integer NOT NULL,
	"scope_hash" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(21, 15),
	"cost_unknown" boolean DEFAULT false NOT NULL,
	"succeeded" boolean NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "recovery_probe_ledger" ADD CONSTRAINT "recovery_probe_ledger_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recovery_probe_ledger_provider_created_at" ON "recovery_probe_ledger" USING btree ("provider_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recovery_probe_ledger_scope_created_at" ON "recovery_probe_ledger" USING btree ("scope_hash","created_at" DESC NULLS LAST);
