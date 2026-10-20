CREATE INDEX "task_schedule_history_assignment_created_idx" ON "task_schedule_history" USING btree ("assignmentId","createdAt");
--> statement-breakpoint
-- Port the data changes from legacy MySQL 0035/0039/0041/0042/0044/0045.
-- Ambiguous tenant ownership stays NULL and therefore inaccessible to worker queries.
UPDATE "workspace_evidence_items"
SET "vaId" = substring("sourceContainerId" from 8)::integer
WHERE "vaId" IS NULL AND CASE
  WHEN "sourceContainerId" ~ '^worker:[0-9]{1,10}$'
  THEN substring("sourceContainerId" from 8)::numeric <= 2147483647
  ELSE false END;
--> statement-breakpoint
UPDATE "workspace_evidence_items"
SET "vaId" = (SELECT min("userId") FROM "va_profiles")
WHERE "vaId" IS NULL AND (SELECT count(*) FROM "va_profiles") = 1;
--> statement-breakpoint
UPDATE "communication_evidence"
SET "vaId" = (SELECT min("userId") FROM "va_profiles")
WHERE "vaId" IS NULL AND (SELECT count(*) FROM "va_profiles") = 1;
--> statement-breakpoint
UPDATE "compliance_card_evidence" SET "assignedToWorker" = "assignedToJoyce";
--> statement-breakpoint
UPDATE "compliance_card_evidence"
SET "vaId" = (SELECT min("userId") FROM "va_profiles")
WHERE "vaId" IS NULL AND (SELECT count(*) FROM "va_profiles") = 1;
--> statement-breakpoint
UPDATE "compliance_communication_evidence"
SET "vaId" = (SELECT min("userId") FROM "va_profiles")
WHERE "vaId" IS NULL AND (SELECT count(*) FROM "va_profiles") = 1;
--> statement-breakpoint
UPDATE "compliance_clarification_requests"
SET "vaId" = (SELECT min("userId") FROM "va_profiles")
WHERE "vaId" IS NULL AND (SELECT count(*) FROM "va_profiles") = 1;
--> statement-breakpoint
UPDATE "task_schedule_history" AS history
SET "founderId" = scope."founderId", "assignmentId" = scope."assignmentId"
FROM (
  SELECT "taskId", min("founderId") AS "founderId", min("id") AS "assignmentId"
  FROM "task_assignments" GROUP BY "taskId" HAVING count(DISTINCT "founderId") = 1
) AS scope
WHERE scope."taskId" = history."taskId" AND history."founderId" IS NULL;
--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'trello_comment_token';
--> statement-breakpoint
UPDATE "app_settings"
SET "value" = 'sha256hex:' || encode(sha256(convert_to("value", 'UTF8')), 'hex')
WHERE ("key" = 'browserTabCollectorToken' OR "key" LIKE 'browserTabCollectorToken:%')
  AND "value" NOT LIKE 'sha256:%' AND "value" NOT LIKE 'sha256hex:%';
--> statement-breakpoint
INSERT INTO "aptlss_manager_queue_slots" ("id") VALUES (1), (2), (3), (4)
ON CONFLICT ("id") DO NOTHING;
