-- Fix migration: Add the missing `codex_image_generation_preference` column to the `providers` table.
--
-- Background: Migration `0106_calm_firebird` was modified after execution on the remote database,
-- resulting in the `codex_image_generation_preference` column not actually being written to the database.
-- This migration independently adds the column and ensures idempotency.
ALTER TABLE "providers"
ADD COLUMN IF NOT EXISTS "codex_image_generation_preference" varchar(10);
