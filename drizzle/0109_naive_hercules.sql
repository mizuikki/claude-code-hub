ALTER TABLE "error_rules" ADD COLUMN IF NOT EXISTS "retry_on_match" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "reasoning_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "deepseek_reasoning_effort_preference" varchar(20);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "reasoning_output_tokens" bigint;
