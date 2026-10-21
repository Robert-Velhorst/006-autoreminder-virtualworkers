ALTER TABLE "generation_jobs" ALTER COLUMN "status" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ALTER COLUMN "status" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ALTER COLUMN "status" SET DEFAULT 'pending';