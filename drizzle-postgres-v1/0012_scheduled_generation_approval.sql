ALTER TABLE "scheduled_jobs" ADD COLUMN "approvedByUserId" integer;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "approvedSessionEpoch" bigint;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "approvedAt" timestamp;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "approvalHash" varchar(64);--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_approval_complete" CHECK ((
  "scheduled_jobs"."approvedByUserId" IS NULL AND "scheduled_jobs"."approvedSessionEpoch" IS NULL
  AND "scheduled_jobs"."approvedAt" IS NULL AND "scheduled_jobs"."approvalHash" IS NULL
) OR (
  "scheduled_jobs"."approvedByUserId" IS NOT NULL AND "scheduled_jobs"."approvedSessionEpoch" IS NOT NULL
  AND "scheduled_jobs"."approvedAt" IS NOT NULL AND "scheduled_jobs"."approvalHash" IS NOT NULL
  AND "scheduled_jobs"."approvedByUserId" > 0 AND "scheduled_jobs"."approvedSessionEpoch" >= 0
  AND "scheduled_jobs"."approvalHash" ~ '^[0-9a-fA-F]{64}$'
));