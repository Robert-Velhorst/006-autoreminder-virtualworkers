CREATE TYPE "public"."enum_role_1pxhzfx" AS ENUM('user', 'admin', 'worker');--> statement-breakpoint
CREATE TYPE "public"."enum_status_wan32x" AS ENUM('active', 'inactive', 'on_leave');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1lxmq9j" AS ENUM('assigned', 'in_progress', 'completed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."enum_dependencytype_skc5j1" AS ENUM('finish_to_start', 'start_to_start', 'finish_to_finish');--> statement-breakpoint
CREATE TYPE "public"."enum_priority_ft1gbc" AS ENUM('normal', 'high', 'urgent', 'drop_everything');--> statement-breakpoint
CREATE TYPE "public"."enum_priority_1c7376r" AS ENUM('standard', 'priority', 'vip');--> statement-breakpoint
CREATE TYPE "public"."enum_messagetype_a9il17" AS ENUM('question', 'decision', 'update', 'handoff', 'feedback');--> statement-breakpoint
CREATE TYPE "public"."enum_briefingtype_1wphl0a" AS ENUM('morning', 'end_of_day', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1xo8rhz" AS ENUM('pending_review', 'approved', 'needs_revision', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."enum_source_1xgs10d" AS ENUM('trello', 'upwork');--> statement-breakpoint
CREATE TYPE "public"."enum_status_mga0dt" AS ENUM('pending', 'replied', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."enum_resolvedby_2vjpz9" AS ENUM('manual', 'auto_demerit');--> statement-breakpoint
CREATE TYPE "public"."enum_category_1fxje1r" AS ENUM('financial', 'non_financial');--> statement-breakpoint
CREATE TYPE "public"."enum_status_pz903i" AS ENUM('pending', 'processed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."enum_extractionstatus_13v80fg" AS ENUM('pending', 'processing', 'success', 'failed', 'unreadable');--> statement-breakpoint
CREATE TYPE "public"."enum_complexity_1emaez6" AS ENUM('simple', 'medium', 'complex');--> statement-breakpoint
CREATE TYPE "public"."enum_status_ylcf2g" AS ENUM('pending', 'processing', 'complete', 'needs_review', 'insufficient_info');--> statement-breakpoint
CREATE TYPE "public"."enum_jobtype_1p9mw8f" AS ENUM('full_sync', 'incremental', 'workspace', 'board', 'card');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1vi2wdv" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."enum_notificationmode_1rzjyge" AS ENUM('disabled', 'daily_digest', 'priority_only');--> statement-breakpoint
CREATE TYPE "public"."enum_notificationtype_1qmsts8" AS ENUM('task_assigned', 'task_due_soon', 'task_overdue', 'task_completed', 'daily_digest', 'general');--> statement-breakpoint
CREATE TYPE "public"."enum_channel_fc1yc1" AS ENUM('in_app', 'email', 'both');--> statement-breakpoint
CREATE TYPE "public"."enum_deliverystatus_n7og9t" AS ENUM('pending', 'sent', 'failed', 'queued_for_digest');--> statement-breakpoint
CREATE TYPE "public"."enum_status_rxw27b" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."enum_modeltype_qwfz3m" AS ENUM('board', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."enum_responsestatus_1lkx6am" AS ENUM('success', 'failed', 'pending');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1j54ed2" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."enum_source_vprdy3" AS ENUM('manual', 'auto', 'batch', 'conflict_resolution');--> statement-breakpoint
CREATE TYPE "public"."enum_operationtype_1lr73l9" AS ENUM('re_analyze', 'reschedule', 'conflict_resolution', 'optimization');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1e6d5fs" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1klf81u" AS ENUM('pending', 'in_progress', 'completed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."enum_dependencytype_qhpsqg" AS ENUM('sequential', 'parallel', 'blocking');--> statement-breakpoint
CREATE TYPE "public"."enum_category_xotgg8" AS ENUM('technical', 'resource', 'schedule', 'external');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1cnaoyu" AS ENUM('identified', 'mitigated', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."enum_resourcetype_1bg4zoy" AS ENUM('skill', 'tool', 'training');--> statement-breakpoint
CREATE TYPE "public"."enum_proficiencylevel_1i56otg" AS ENUM('beginner', 'intermediate', 'expert');--> statement-breakpoint
CREATE TYPE "public"."enum_status_645ovh" AS ENUM('pending', 'completed');--> statement-breakpoint
CREATE TYPE "public"."enum_dependencytype_1ilpice" AS ENUM('approval', 'third_party', 'regulatory');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1sgdzt3" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."enum_generatedby_6s09xv" AS ENUM('manual', 'ai');--> statement-breakpoint
CREATE TYPE "public"."enum_validationstatus_1quvsg1" AS ENUM('initial', 'validated', 'needs_review', 'quality_check_failed');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1pmifyk" AS ENUM('completed', 'in-progress', 'ready', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."enum_previousstatus_1pmifyk" AS ENUM('completed', 'in-progress', 'ready', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."enum_newstatus_1pmifyk" AS ENUM('completed', 'in-progress', 'ready', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."enum_strictnesslevel_13d2lgi" AS ENUM('lenient', 'moderate', 'strict');--> statement-breakpoint
CREATE TYPE "public"."enum_ruletype_z6tdsy" AS ENUM('vagueness', 'measurability', 'timeline', 'resources', 'dependencies', 'clarity', 'specificity', 'actionability');--> statement-breakpoint
CREATE TYPE "public"."enum_severity_bigbib" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."enum_verdict_1ifswsr" AS ENUM('accurate', 'partial', 'inaccurate');--> statement-breakpoint
CREATE TYPE "public"."enum_source_1ur3rkb" AS ENUM('gmail', 'google_drive', 'trello', 'communication');--> statement-breakpoint
CREATE TYPE "public"."enum_reviewstatus_dfhow7" AS ENUM('unreviewed', 'linked', 'not_work_related');--> statement-breakpoint
CREATE TYPE "public"."enum_linkmethod_99towq" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."enum_truthclass_1k1o5b2" AS ENUM('source_record', 'worker_assertion', 'system_inference');--> statement-breakpoint
CREATE TYPE "public"."enum_subjecttype_68ocx8" AS ENUM('card', 'worker', 'decision', 'plan_block');--> statement-breakpoint
CREATE TYPE "public"."enum_linkmethod_1x6q4zj" AS ENUM('automatic', 'manual', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."enum_status_6k7llh" AS ENUM('needs_verification', 'consistent', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."enum_status_2xlhsx" AS ENUM('open', 'resolved', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."enum_direction_1abj3f9" AS ENUM('inbound', 'outbound', 'system', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."enum_kind_jsifmk" AS ENUM('message_response', 'email_processing');--> statement-breakpoint
CREATE TYPE "public"."enum_outcome_t8n47e" AS ENUM('verified', 'missed', 'needs_clarification', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."enum_resolution_ldseu8" AS ENUM('completed', 'not_completed', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1qvzp7l" AS ENUM('open', 'needs_review', 'locked');--> statement-breakpoint
CREATE TYPE "public"."enum_severity_11yyky0" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."enum_status_1ngf43y" AS ENUM('open', 'resolved', 'dismissed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."enum_trigger_1qyerme" AS ENUM('cron', 'external', 'manual');--> statement-breakpoint
CREATE TYPE "public"."enum_status_17mmv7l" AS ENUM('running', 'success', 'error', 'abandoned');--> statement-breakpoint
CREATE TABLE "admin_sync_log" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "admin_sync_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"syncType" varchar(32) NOT NULL,
	"success" boolean NOT NULL,
	"cardsProcessed" integer DEFAULT 0 NOT NULL,
	"actionsTaken" integer DEFAULT 0 NOT NULL,
	"cardsSkippedLowConfidence" integer DEFAULT 0 NOT NULL,
	"errorMessage" text,
	"durationMs" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "app_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "aptlss_assessment_feedback" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_assessment_feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"assessmentId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"engineVersion" varchar(32) NOT NULL,
	"predictedState" varchar(64) NOT NULL,
	"predictedConfidence" integer NOT NULL,
	"verdict" "enum_verdict_1ifswsr" NOT NULL,
	"correctedState" varchar(64),
	"note" text,
	"createdBy" varchar(128) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_assessments" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_assessments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"engineVersion" varchar(32) NOT NULL,
	"contextHash" varchar(64) NOT NULL,
	"trigger" varchar(32) DEFAULT 'manual' NOT NULL,
	"primaryState" varchar(64) NOT NULL,
	"stateReason" text NOT NULL,
	"secondarySignals" text NOT NULL,
	"actionability" varchar(32) NOT NULL,
	"priorityScore" integer NOT NULL,
	"priorityTier" varchar(16) NOT NULL,
	"priorityBreakdown" text NOT NULL,
	"confidenceScore" integer NOT NULL,
	"confidenceBand" varchar(16) NOT NULL,
	"confidenceReason" text NOT NULL,
	"evidenceCoverage" text NOT NULL,
	"evidenceJson" text NOT NULL,
	"intelligenceJson" text,
	"uncertaintiesJson" text NOT NULL,
	"recommendationsJson" text NOT NULL,
	"lastMeaningfulProgressAt" timestamp,
	"daysSinceMeaningfulProgress" integer DEFAULT 0 NOT NULL,
	"nextAssessmentAt" timestamp NOT NULL,
	"changeJson" text NOT NULL,
	"evaluationCount" integer DEFAULT 1 NOT NULL,
	"assessedAt" timestamp NOT NULL,
	"lastEvaluatedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_audit_log" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"action" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"payload" text,
	"confidenceScore" integer,
	"requiresApproval" boolean DEFAULT false NOT NULL,
	"approved" boolean,
	"source" varchar(32) DEFAULT 'maintenance_job' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_evidence_conflicts" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_evidence_conflicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"sourceEvidenceId" integer NOT NULL,
	"assertedEvidenceId" integer NOT NULL,
	"status" "enum_status_6k7llh" DEFAULT 'needs_verification' NOT NULL,
	"resolution" text,
	"resolvedBy" varchar(128),
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_evidence_revisions" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_evidence_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"evidenceId" integer NOT NULL,
	"contentHash" varchar(64) NOT NULL,
	"truthClass" "enum_truthclass_1k1o5b2" NOT NULL,
	"summary" text,
	"content" text,
	"metadataJson" text,
	"observedAt" timestamp NOT NULL,
	"recordedBy" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_evidence_subject_links" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_evidence_subject_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"evidenceId" integer NOT NULL,
	"vaId" integer NOT NULL,
	"subjectType" "enum_subjecttype_68ocx8" NOT NULL,
	"subjectId" varchar(256) NOT NULL,
	"relevanceScore" integer NOT NULL,
	"linkMethod" "enum_linkmethod_1x6q4zj" DEFAULT 'automatic' NOT NULL,
	"matchReason" varchar(512) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_operational_policies" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_operational_policies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"ruleKey" varchar(128) NOT NULL,
	"label" varchar(256) DEFAULT '' NOT NULL,
	"description" text,
	"value" text DEFAULT '{}' NOT NULL,
	"category" varchar(64) DEFAULT 'general' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_plans" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"planJson" text NOT NULL,
	"contextSnapshot" text,
	"generatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_steps" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"trelloChecklistId" varchar(64),
	"trelloCheckItemId" varchar(64),
	"stepNumber" integer NOT NULL,
	"title" varchar(1024) NOT NULL,
	"estimatedMinutes" integer DEFAULT 15 NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"category" varchar(64) DEFAULT 'internal_work' NOT NULL,
	"requiresRobert" boolean DEFAULT false NOT NULL,
	"blockedBy" varchar(64),
	"dependsOnCards" text,
	"completionCriteria" text,
	"riskIfSkipped" text,
	"recommendedDecision" text,
	"isManual" boolean DEFAULT false NOT NULL,
	"completedAt" timestamp,
	"lastSyncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_verification_followups" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_verification_followups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64),
	"conflictId" integer,
	"title" varchar(512) NOT NULL,
	"question" text NOT NULL,
	"status" "enum_status_2xlhsx" DEFAULT 'open' NOT NULL,
	"dueAt" timestamp,
	"resolution" text,
	"resolvedBy" varchar(128),
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aptlss_waiting_reasons" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "aptlss_waiting_reasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"cardUrl" varchar(1024) DEFAULT '' NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"rawReason" text NOT NULL,
	"category" varchar(64) NOT NULL,
	"waitingOn" varchar(32) NOT NULL,
	"waitingOnName" varchar(256),
	"requestedItem" text,
	"nextAction" text NOT NULL,
	"nextStepType" varchar(64) NOT NULL,
	"followUpAt" timestamp,
	"followUpSource" varchar(32) NOT NULL,
	"urgency" varchar(16) NOT NULL,
	"requiresRobert" boolean DEFAULT false NOT NULL,
	"confidenceScore" integer NOT NULL,
	"confidenceReason" text NOT NULL,
	"interpretationJson" text NOT NULL,
	"interpreterVersion" varchar(32) NOT NULL,
	"source" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"recordedBy" varchar(128) NOT NULL,
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ares_configurations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"strictnessLevel" "enum_strictnesslevel_13d2lgi" DEFAULT 'moderate' NOT NULL,
	"confidenceThreshold" integer DEFAULT 40 NOT NULL,
	"enableVaguenessCheck" boolean DEFAULT true NOT NULL,
	"enableMeasurabilityCheck" boolean DEFAULT true NOT NULL,
	"enableTimelineCheck" boolean DEFAULT true NOT NULL,
	"enableResourceCheck" boolean DEFAULT false NOT NULL,
	"enableDependencyCheck" boolean DEFAULT false NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ares_validation_history" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"configId" varchar(64) NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" text NOT NULL,
	"goalDefinition" text,
	"confidenceScore" integer NOT NULL,
	"passed" boolean NOT NULL,
	"failedRules" text,
	"warnings" text,
	"validationDetails" text,
	"validatedAt" timestamp DEFAULT now() NOT NULL,
	"validatedBy" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ares_validation_rules" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"configId" varchar(64) NOT NULL,
	"ruleType" "enum_ruletype_z6tdsy" NOT NULL,
	"ruleName" varchar(255) NOT NULL,
	"description" text,
	"severity" "enum_severity_bigbib" DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" integer DEFAULT 50,
	"customLogic" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_analysis_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"status" "enum_status_1sgdzt3" DEFAULT 'pending' NOT NULL,
	"currentPhase" integer DEFAULT 3,
	"phasesCompleted" integer DEFAULT 0,
	"sessionData" text,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_attachments" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloId" varchar(64) NOT NULL,
	"cardId" integer NOT NULL,
	"cardTrelloId" varchar(64) NOT NULL,
	"filename" varchar(512),
	"mimeType" varchar(128),
	"fileType" varchar(32),
	"url" varchar(1024),
	"bytes" integer,
	"extractionStatus" "enum_extractionstatus_13v80fg" DEFAULT 'pending' NOT NULL,
	"extractedContent" text,
	"extractionError" text,
	"extractedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_boards" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_boards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloId" varchar(64) NOT NULL,
	"workspaceId" integer,
	"workspaceTrelloId" varchar(64),
	"name" varchar(255) NOT NULL,
	"url" varchar(512),
	"isOpen" integer DEFAULT 1,
	"cardCount" integer DEFAULT 0,
	"lastSyncedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "atis_boards_trelloId_unique" UNIQUE("trelloId")
);
--> statement-breakpoint
CREATE TABLE "atis_card_understanding" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_card_understanding_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cardId" integer NOT NULL,
	"cardTrelloId" varchar(64) NOT NULL,
	"goal" text,
	"deliverable" text,
	"taskType" varchar(64),
	"entities" text,
	"deadlines" text,
	"estimatedMinutes" integer,
	"dependencies" text,
	"produces" text,
	"domain" varchar(128),
	"complexity" "enum_complexity_1emaez6" DEFAULT 'medium',
	"clarityScore" integer,
	"missingInfo" text,
	"confidenceScore" integer,
	"aptlssChecklist" text,
	"status" "enum_status_ylcf2g" DEFAULT 'pending' NOT NULL,
	"generatedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "atis_card_understanding_cardId_unique" UNIQUE("cardId"),
	CONSTRAINT "atis_card_understanding_cardTrelloId_unique" UNIQUE("cardTrelloId")
);
--> statement-breakpoint
CREATE TABLE "atis_cards" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloId" varchar(64) NOT NULL,
	"boardId" integer NOT NULL,
	"boardTrelloId" varchar(64) NOT NULL,
	"listName" varchar(255),
	"listId" varchar(64),
	"name" varchar(512) NOT NULL,
	"description" text,
	"url" varchar(512),
	"dueDate" timestamp,
	"dueComplete" integer DEFAULT 0,
	"isArchived" integer DEFAULT 0,
	"isClosed" integer DEFAULT 0,
	"labels" text,
	"memberIds" text,
	"checklistCount" integer DEFAULT 0,
	"attachmentCount" integer DEFAULT 0,
	"commentCount" integer DEFAULT 0,
	"rawData" text,
	"lastSyncedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "atis_cards_trelloId_unique" UNIQUE("trelloId")
);
--> statement-breakpoint
CREATE TABLE "atis_checklist_completion" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_checklist_completion_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"card_id" integer NOT NULL,
	"step_index" integer NOT NULL,
	"user_id" integer NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_comments" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloId" varchar(64) NOT NULL,
	"cardId" integer NOT NULL,
	"cardTrelloId" varchar(64) NOT NULL,
	"authorId" varchar(64),
	"authorName" varchar(255),
	"text" text NOT NULL,
	"commentDate" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_ingestion_jobs" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_ingestion_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"jobType" "enum_jobtype_1p9mw8f" NOT NULL,
	"status" "enum_status_1vi2wdv" DEFAULT 'pending' NOT NULL,
	"targetId" varchar(64),
	"totalItems" integer DEFAULT 0,
	"processedItems" integer DEFAULT 0,
	"failedItems" integer DEFAULT 0,
	"errorLog" text,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atis_workspaces" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "atis_workspaces_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloId" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"displayName" varchar(255),
	"url" varchar(512),
	"boardCount" integer DEFAULT 0,
	"lastSyncedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "atis_workspaces_trelloId_unique" UNIQUE("trelloId")
);
--> statement-breakpoint
CREATE TABLE "auto_follow_up_drafts" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "auto_follow_up_drafts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"draftMessage" text NOT NULL,
	"reason" varchar(512) DEFAULT '' NOT NULL,
	"hoursSinceLastReply" integer DEFAULT 0 NOT NULL,
	"urgencyType" varchar(32) DEFAULT 'routine' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_operation_settings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "batch_operation_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"defaultOperationType" varchar(50) DEFAULT 're_analyze' NOT NULL,
	"defaultPriority" varchar(20) DEFAULT 'normal' NOT NULL,
	"autoStartOnQueue" integer DEFAULT 0 NOT NULL,
	"maxConcurrentOperations" integer DEFAULT 3 NOT NULL,
	"retryFailedTasks" integer DEFAULT 1 NOT NULL,
	"maxRetries" integer DEFAULT 2 NOT NULL,
	"notifyOnCompletion" integer DEFAULT 1 NOT NULL,
	"notifyOnFailure" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lastModified" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_operations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" varchar(64) NOT NULL,
	"operationType" "enum_operationtype_1lr73l9" NOT NULL,
	"description" varchar(255),
	"totalTasks" integer NOT NULL,
	"completedTasks" integer DEFAULT 0 NOT NULL,
	"failedTasks" integer DEFAULT 0 NOT NULL,
	"status" "enum_status_1e6d5fs" DEFAULT 'pending' NOT NULL,
	"progress" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"currentTaskIndex" integer DEFAULT 0,
	"currentTaskName" varchar(255),
	"estimatedTimeSeconds" integer,
	"elapsedTimeSeconds" integer DEFAULT 0,
	"results" text,
	"errorLog" text,
	"parameters" text,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_tab_daily_evidence" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "browser_tab_daily_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"snapshotDate" date NOT NULL,
	"status" varchar(32) NOT NULL,
	"totalTabs" integer DEFAULT 0 NOT NULL,
	"actionableTabs" integer DEFAULT 0 NOT NULL,
	"allowedTabs" integer DEFAULT 0 NOT NULL,
	"compliant" boolean DEFAULT false NOT NULL,
	"source" varchar(32) DEFAULT 'auto' NOT NULL,
	"evidenceJson" text NOT NULL,
	"capturedAt" timestamp,
	"verifiedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_tab_states" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "browser_tab_states_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"collectorId" varchar(128) NOT NULL,
	"collectorLabel" varchar(128) DEFAULT 'Worker browser' NOT NULL,
	"totalTabs" integer DEFAULT 0 NOT NULL,
	"pinnedTabs" integer DEFAULT 0 NOT NULL,
	"windowCount" integer DEFAULT 0 NOT NULL,
	"tabsJson" text NOT NULL,
	"capturedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "browser_tab_states_collectorId_unique" UNIQUE("collectorId")
);
--> statement-breakpoint
CREATE TABLE "card_snoozes" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "card_snoozes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"snoozedAt" timestamp DEFAULT now() NOT NULL,
	"snoozedUntil" date NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_states" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "card_states_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"state" varchar(64) DEFAULT 'NEW_UNTRIAGED' NOT NULL,
	"stateReason" text,
	"daysSinceProgress" integer DEFAULT 0 NOT NULL,
	"hasUnansweredQuestion" boolean DEFAULT false NOT NULL,
	"isOverdue" boolean DEFAULT false NOT NULL,
	"checklistComplete" boolean DEFAULT false NOT NULL,
	"hasFinalSummary" boolean DEFAULT false NOT NULL,
	"calculatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_analytics" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "chatbot_analytics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"date" timestamp NOT NULL,
	"totalCommands" integer DEFAULT 0 NOT NULL,
	"statusCommands" integer DEFAULT 0 NOT NULL,
	"checkinCommands" integer DEFAULT 0 NOT NULL,
	"remindCommands" integer DEFAULT 0 NOT NULL,
	"timeCommands" integer DEFAULT 0 NOT NULL,
	"progressCommands" integer DEFAULT 0 NOT NULL,
	"helpCommands" integer DEFAULT 0 NOT NULL,
	"unknownCommands" integer DEFAULT 0 NOT NULL,
	"successfulResponses" integer DEFAULT 0 NOT NULL,
	"failedResponses" integer DEFAULT 0 NOT NULL,
	"avgResponseTimeMs" integer,
	"checkinsSent" integer DEFAULT 0 NOT NULL,
	"checkinsResponded" integer DEFAULT 0 NOT NULL,
	"avgCheckinResponseMinutes" integer,
	"uniqueWorkers" integer DEFAULT 0 NOT NULL,
	"uniqueCards" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_checkin_responses" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "chatbot_checkin_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversationId" integer NOT NULL,
	"cardTrelloId" varchar(64) NOT NULL,
	"workerTrelloId" varchar(64),
	"workerName" varchar(255),
	"workerId" integer,
	"responseCommentId" varchar(64),
	"responseText" text,
	"reportedProgress" text,
	"reportedBlockers" text,
	"estimatedCompletion" varchar(100),
	"checkinSentAt" timestamp NOT NULL,
	"responseReceivedAt" timestamp NOT NULL,
	"responseTimeMinutes" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_conversations" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "chatbot_conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cardTrelloId" varchar(64) NOT NULL,
	"cardName" varchar(500),
	"boardTrelloId" varchar(64),
	"command" varchar(50) NOT NULL,
	"commandArgs" text,
	"authorTrelloId" varchar(64),
	"authorName" varchar(255),
	"incomingCommentId" varchar(64),
	"responseCommentId" varchar(64),
	"responseText" text,
	"responseStatus" "enum_responsestatus_1lkx6am" DEFAULT 'pending' NOT NULL,
	"responseError" text,
	"receivedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	"responseTimeMs" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_webhooks" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "chatbot_webhooks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trelloWebhookId" varchar(64) NOT NULL,
	"modelId" varchar(64) NOT NULL,
	"modelType" "enum_modeltype_qwfz3m" DEFAULT 'board' NOT NULL,
	"description" varchar(255),
	"callbackUrl" varchar(512) NOT NULL,
	"isActive" integer DEFAULT 1 NOT NULL,
	"lastEventAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatbot_webhooks_trelloWebhookId_unique" UNIQUE("trelloWebhookId")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "clients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"founderId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"priority" "enum_priority_1c7376r" DEFAULT 'standard' NOT NULL,
	"trelloBoardIds" text,
	"contactEmail" varchar(320),
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_evidence" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "communication_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel" varchar(64) NOT NULL,
	"externalId" varchar(256) NOT NULL,
	"threadId" varchar(256),
	"direction" "enum_direction_1abj3f9" DEFAULT 'unknown' NOT NULL,
	"sender" varchar(512),
	"recipientsJson" text,
	"subject" varchar(1024),
	"summary" text,
	"occurredAt" timestamp NOT NULL,
	"responseRequired" boolean DEFAULT false NOT NULL,
	"respondedAt" timestamp,
	"linkedCardId" varchar(64),
	"evidenceItemId" integer,
	"metadataJson" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_log" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "communication_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128),
	"fromUserId" integer NOT NULL,
	"toUserId" integer,
	"messageType" "enum_messagetype_a9il17" NOT NULL,
	"message" text NOT NULL,
	"context" text,
	"isRead" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_card_evidence" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "compliance_card_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"snapshotDate" date NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"category" varchar(16) NOT NULL,
	"assignedToJoyce" boolean DEFAULT true NOT NULL,
	"compliant" boolean DEFAULT false NOT NULL,
	"evidenceType" varchar(32) DEFAULT 'none' NOT NULL,
	"evidenceActionId" varchar(64),
	"evidenceAt" timestamp,
	"evidenceJson" text NOT NULL,
	"verifiedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_clarification_requests" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "compliance_clarification_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"snapshotDate" date NOT NULL,
	"evidenceKey" varchar(256) NOT NULL,
	"kind" "enum_kind_jsifmk" NOT NULL,
	"channel" varchar(64) NOT NULL,
	"externalId" varchar(256) NOT NULL,
	"title" varchar(1024) NOT NULL,
	"question" text NOT NULL,
	"status" "enum_status_2xlhsx" DEFAULT 'open' NOT NULL,
	"resolution" "enum_resolution_ldseu8",
	"response" text,
	"requestedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	"resolvedAt" timestamp,
	"sourceJson" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_communication_evidence" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "compliance_communication_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"snapshotDate" date NOT NULL,
	"evidenceKey" varchar(256) NOT NULL,
	"kind" "enum_kind_jsifmk" NOT NULL,
	"channel" varchar(64) NOT NULL,
	"externalId" varchar(256) NOT NULL,
	"title" varchar(1024) NOT NULL,
	"sourceUrl" varchar(1024),
	"occurredAt" timestamp NOT NULL,
	"dueAt" timestamp,
	"outcome" "enum_outcome_t8n47e" NOT NULL,
	"evidenceType" varchar(64) NOT NULL,
	"evidenceAt" timestamp,
	"evidenceJson" text NOT NULL,
	"verifiedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_detection_settings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "conflict_detection_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"warningThresholdMinutes" integer DEFAULT 15 NOT NULL,
	"autoResolve" integer DEFAULT 0 NOT NULL,
	"notifyOnConflict" integer DEFAULT 1 NOT NULL,
	"conflictTypes" text DEFAULT '{"timeOverlap":true,"resourceConflict":true,"dependencyConflict":true}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lastModified" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "critical_path_analysis" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"criticalPath" text NOT NULL,
	"totalDurationHours" numeric(10, 2) NOT NULL,
	"parallelizationOpportunities" integer DEFAULT 0,
	"analysisData" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_briefings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_briefings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"briefingDate" varchar(10) NOT NULL,
	"briefingType" "enum_briefingtype_1wphl0a" NOT NULL,
	"content" text NOT NULL,
	"sentAt" timestamp,
	"sentTo" varchar(320),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_card_updates" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_card_updates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"date" date NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_compliance_snapshots" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_compliance_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"snapshotDate" date NOT NULL,
	"onHoldTotal" integer DEFAULT 0 NOT NULL,
	"onHoldReviewed" integer DEFAULT 0 NOT NULL,
	"onHoldMissedCards" text,
	"doingTotal" integer DEFAULT 0 NOT NULL,
	"doingUpdated" integer DEFAULT 0 NOT NULL,
	"doingMissedCards" text,
	"messageTotal" integer DEFAULT 0 NOT NULL,
	"messageReplied" integer DEFAULT 0 NOT NULL,
	"messageMissed" integer DEFAULT 0 NOT NULL,
	"messageNeedsClarification" integer DEFAULT 0 NOT NULL,
	"emailTotal" integer DEFAULT 0 NOT NULL,
	"emailCompleted" integer DEFAULT 0 NOT NULL,
	"emailMissed" integer DEFAULT 0 NOT NULL,
	"emailNeedsClarification" integer DEFAULT 0 NOT NULL,
	"clarificationOpen" integer DEFAULT 0 NOT NULL,
	"trackedSeconds" integer DEFAULT 0 NOT NULL,
	"scheduledTargetSeconds" integer DEFAULT 0 NOT NULL,
	"overtimeSeconds" integer DEFAULT 0 NOT NULL,
	"timeEntryCount" integer DEFAULT 0 NOT NULL,
	"d1Instances" integer DEFAULT 0 NOT NULL,
	"estimatedPenalty" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"source" varchar(16) DEFAULT 'auto' NOT NULL,
	"weeklyPayLogId" integer,
	"required" boolean DEFAULT true NOT NULL,
	"verificationStatus" varchar(24) DEFAULT 'unverified' NOT NULL,
	"verificationMethod" varchar(255),
	"verificationCutoffAt" timestamp,
	"verifiedAt" timestamp,
	"evidenceCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_due_date_assignments" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_due_date_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"date" date NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_plans" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"dateKey" varchar(16) NOT NULL,
	"scheduleJson" text NOT NULL,
	"dailySummary" text,
	"topPriority" varchar(512),
	"totalScheduledMinutes" integer DEFAULT 0 NOT NULL,
	"robertItemsCount" integer DEFAULT 0 NOT NULL,
	"autoGenerated" boolean DEFAULT true NOT NULL,
	"generatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_triage_state" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_triage_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"triageDate" date NOT NULL,
	"step1Done" boolean DEFAULT false NOT NULL,
	"step2Done" boolean DEFAULT false NOT NULL,
	"step3Done" boolean DEFAULT false NOT NULL,
	"step4Done" boolean DEFAULT false NOT NULL,
	"step5Done" boolean DEFAULT false NOT NULL,
	"focusTasks" text,
	"eveningStep1Done" boolean DEFAULT false NOT NULL,
	"eveningStep2Done" boolean DEFAULT false NOT NULL,
	"eveningStep3Done" boolean DEFAULT false NOT NULL,
	"eveningStep4Done" boolean DEFAULT false NOT NULL,
	"eodReport" text,
	"currentView" varchar(32) DEFAULT 'overview' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_update_streak" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "daily_update_streak_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"streakDate" date NOT NULL,
	"completedBeforeDeadline" boolean DEFAULT false NOT NULL,
	"completedAt" timestamp,
	"doingCardCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_outcomes" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "decision_outcomes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"stepId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"cardUrl" varchar(1024) DEFAULT '' NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"decisionPrompt" text NOT NULL,
	"recommendedDecision" text,
	"outcome" text NOT NULL,
	"resolvedBy" varchar(64) NOT NULL,
	"resolvedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "decision_outcomes_stepId_unique" UNIQUE("stepId")
);
--> statement-breakpoint
CREATE TABLE "digest_jobs" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "digest_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userOpenId" varchar(64) NOT NULL,
	"scheduledFor" timestamp NOT NULL,
	"status" "enum_status_rxw27b" DEFAULT 'pending' NOT NULL,
	"notificationCount" integer DEFAULT 0 NOT NULL,
	"error" text,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_tasks" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "email_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"gmailMessageId" varchar(128) NOT NULL,
	"gmailThreadId" varchar(128) NOT NULL,
	"subject" varchar(1024) DEFAULT '(no subject)' NOT NULL,
	"fromAddress" varchar(320) DEFAULT '' NOT NULL,
	"fromName" varchar(256) DEFAULT '' NOT NULL,
	"snippet" text,
	"receivedAt" timestamp NOT NULL,
	"category" "enum_category_1fxje1r" DEFAULT 'non_financial' NOT NULL,
	"status" "enum_status_pz903i" DEFAULT 'pending' NOT NULL,
	"deadlineAt" timestamp,
	"trelloCardId" varchar(64),
	"trelloCardName" varchar(512),
	"trelloCardUrl" varchar(1024),
	"suggestedNextAction" text,
	"llmSummary" text,
	"processedAt" timestamp,
	"archivedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_tasks_gmailMessageId_unique" UNIQUE("gmailMessageId")
);
--> statement-breakpoint
CREATE TABLE "execution_plan_status_history" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"stepId" varchar(255) NOT NULL,
	"executionPlanId" varchar(255) NOT NULL,
	"previousStatus" "enum_previousstatus_1pmifyk" NOT NULL,
	"newStatus" "enum_newstatus_1pmifyk" NOT NULL,
	"changedBy" integer NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plan_steps" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"executionPlanId" varchar(255) NOT NULL,
	"stepId" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"dependencies" text NOT NULL,
	"parallelizable" integer DEFAULT 0 NOT NULL,
	"timeEstimateMin" integer NOT NULL,
	"timeEstimateMax" integer NOT NULL,
	"risks" text NOT NULL,
	"status" "enum_status_1pmifyk" DEFAULT 'ready' NOT NULL,
	"completedBy" varchar(255),
	"completedAt" timestamp,
	"startedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"cardId" varchar(255) NOT NULL,
	"userId" integer NOT NULL,
	"objective" text NOT NULL,
	"inputs" text NOT NULL,
	"outputs" text NOT NULL,
	"stepsJson" text NOT NULL,
	"iterationFlowsJson" text NOT NULL,
	"totalEstimateMin" integer NOT NULL,
	"totalEstimateMax" integer NOT NULL,
	"generatedBy" "enum_generatedby_6s09xv" DEFAULT 'manual' NOT NULL,
	"qualityScore" integer DEFAULT 85,
	"validationStatus" "enum_validationstatus_1quvsg1" DEFAULT 'initial',
	"qualityFeedback" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "founder_priority_overrides" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "founder_priority_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"founderId" integer NOT NULL,
	"priority" "enum_priority_ft1gbc" DEFAULT 'normal' NOT NULL,
	"reason" text,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_items" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"jobId" varchar(64) NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" text NOT NULL,
	"boardName" varchar(255),
	"status" varchar(20) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"error" text,
	"result" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"totalCards" integer NOT NULL,
	"completedCards" integer DEFAULT 0 NOT NULL,
	"failedCards" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) NOT NULL,
	"settings" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"createdBy" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoff_notes" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "handoff_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"fromVaId" integer NOT NULL,
	"toVaId" integer,
	"founderId" integer NOT NULL,
	"whereLeftOff" text NOT NULL,
	"nextSteps" text,
	"blockers" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "holidays_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(255) NOT NULL,
	"date" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"country" varchar(2) NOT NULL,
	"isActive" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_history" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"sessionId" varchar(64) NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"phase" integer NOT NULL,
	"questionNumber" integer NOT NULL,
	"question" text NOT NULL,
	"response" text NOT NULL,
	"isValid" integer NOT NULL,
	"validationScore" integer DEFAULT 0 NOT NULL,
	"validationNotes" text,
	"confidenceScore" integer DEFAULT 0 NOT NULL,
	"requiresEscalation" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_results" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"sessionId" varchar(64) NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"finalGoal" text,
	"finalDeliverable" text,
	"finalAPTLSSChecklist" text,
	"finalConfidence" integer DEFAULT 0 NOT NULL,
	"clarityScore" integer DEFAULT 0 NOT NULL,
	"completenessScore" integer DEFAULT 0 NOT NULL,
	"executionPlan" text,
	"estimatedDuration" integer,
	"totalQuestionsAsked" integer DEFAULT 0 NOT NULL,
	"totalResponsesProvided" integer DEFAULT 0 NOT NULL,
	"escalationsRequired" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"status" "enum_status_1j54ed2" DEFAULT 'active' NOT NULL,
	"currentPhase" integer DEFAULT 1 NOT NULL,
	"currentQuestion" integer DEFAULT 0 NOT NULL,
	"preAnalysisSummary" text,
	"questionsAsked" integer DEFAULT 0 NOT NULL,
	"responsesProvided" integer DEFAULT 0 NOT NULL,
	"overallConfidence" integer DEFAULT 0 NOT NULL,
	"sessionData" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "keyboard_shortcuts" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "keyboard_shortcuts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" varchar(64) NOT NULL,
	"shortcutKey" varchar(50) NOT NULL,
	"action" varchar(100) NOT NULL,
	"description" varchar(255),
	"isCustom" integer DEFAULT 0 NOT NULL,
	"isEnabled" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyboard_shortcuts_settings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "keyboard_shortcuts_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"shortcuts" text DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lastModified" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_history" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "notification_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"notificationType" "enum_notificationtype_1qmsts8" NOT NULL,
	"taskId" varchar(128),
	"taskName" varchar(500),
	"dueDate" timestamp,
	"channel" "enum_channel_fc1yc1" NOT NULL,
	"deliveryStatus" "enum_deliverystatus_n7og9t" DEFAULT 'pending' NOT NULL,
	"deliveredAt" timestamp,
	"isRead" integer DEFAULT 0 NOT NULL,
	"readAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "on_hold_daily_checks" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "on_hold_daily_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"date" date NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"checkedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_cycles" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "payment_cycles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"founderId" integer NOT NULL,
	"cycleStart" date NOT NULL,
	"cycleEnd" date NOT NULL,
	"baseAmount" numeric(8, 2) DEFAULT '90.00' NOT NULL,
	"isPaid" boolean DEFAULT false NOT NULL,
	"paidAt" timestamp,
	"paidBy" varchar(64),
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_metrics_settings" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "performance_metrics_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"totalOperations" integer DEFAULT 0 NOT NULL,
	"successfulOperations" integer DEFAULT 0 NOT NULL,
	"failedOperations" integer DEFAULT 0 NOT NULL,
	"averageExecutionTime" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"averageTasksPerOperation" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"conflictsDetected" integer DEFAULT 0 NOT NULL,
	"conflictsResolved" integer DEFAULT 0 NOT NULL,
	"trends" text DEFAULT '{"successRate":0,"executionTimeTrend":"stable","operationsTrend":"stable"}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lastModified" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_scores" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "priority_scores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) DEFAULT '' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"breakdown" text,
	"tier" varchar(16) DEFAULT 'MEDIUM' NOT NULL,
	"estimatedRemainingMinutes" integer DEFAULT 0 NOT NULL,
	"openSteps" integer DEFAULT 0 NOT NULL,
	"completedSteps" integer DEFAULT 0 NOT NULL,
	"calculatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_threads" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "reply_threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"source" "enum_source_1xgs10d" DEFAULT 'trello' NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"boardName" varchar(256) DEFAULT '' NOT NULL,
	"listName" varchar(256) DEFAULT '' NOT NULL,
	"lastNonWorkerMsgAt" timestamp NOT NULL,
	"lastNonWorkerAuthor" varchar(256) DEFAULT '' NOT NULL,
	"lastNonWorkerText" text,
	"lastWorkerReplyAt" timestamp,
	"status" "enum_status_mga0dt" DEFAULT 'pending' NOT NULL,
	"demerited" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "review_queue_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"status" "enum_status_1xo8rhz" DEFAULT 'pending_review' NOT NULL,
	"submittedAt" timestamp DEFAULT now() NOT NULL,
	"reviewedAt" timestamp,
	"feedback" text,
	"revisionCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_mitigations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"riskId" varchar(36) NOT NULL,
	"strategy" varchar(255) NOT NULL,
	"effort" varchar(50),
	"owner" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_leases" (
	"jobKey" varchar(96) PRIMARY KEY NOT NULL,
	"ownerToken" varchar(64) NOT NULL,
	"acquiredAt" timestamp NOT NULL,
	"heartbeatAt" timestamp NOT NULL,
	"leaseExpiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "scheduled_job_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"jobKey" varchar(96) NOT NULL,
	"trigger" "enum_trigger_1qyerme" DEFAULT 'cron' NOT NULL,
	"status" "enum_status_17mmv7l" DEFAULT 'running' NOT NULL,
	"startedAt" timestamp NOT NULL,
	"finishedAt" timestamp,
	"durationMs" integer,
	"recordsProcessed" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"cardIds" text NOT NULL,
	"scheduledTime" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"settings" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"error" text,
	"createdBy" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_sync_log" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "settings_sync_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"settingsType" varchar(50) NOT NULL,
	"action" varchar(20) NOT NULL,
	"previousVersion" integer,
	"newVersion" integer,
	"deviceId" varchar(128),
	"clientVersion" varchar(20),
	"hadConflict" integer DEFAULT 0 NOT NULL,
	"conflictResolution" varchar(50),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_schedules" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shift_schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"dayOfWeek" integer NOT NULL,
	"shiftStart" varchar(5) NOT NULL,
	"shiftEnd" varchar(5) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtask_dependencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"subtaskId" varchar(36) NOT NULL,
	"dependsOnSubtaskId" varchar(36) NOT NULL,
	"dependencyType" "enum_dependencytype_qhpsqg" DEFAULT 'sequential' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sunday_checklist" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "sunday_checklist_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"sundayDate" date NOT NULL,
	"trelloArchived" boolean DEFAULT false NOT NULL,
	"trelloLabels" boolean DEFAULT false NOT NULL,
	"trelloDeadlines" boolean DEFAULT false NOT NULL,
	"trelloTimers" boolean DEFAULT false NOT NULL,
	"emailInbox" boolean DEFAULT false NOT NULL,
	"whatsappCleared" boolean DEFAULT false NOT NULL,
	"upworkArchived" boolean DEFAULT false NOT NULL,
	"downloadsCleared" boolean DEFAULT false NOT NULL,
	"desktopCleared" boolean DEFAULT false NOT NULL,
	"browserTabsClosed" boolean DEFAULT false NOT NULL,
	"weekReviewed" boolean DEFAULT false NOT NULL,
	"nextWeekPlanned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "task_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"assignedAt" timestamp DEFAULT now() NOT NULL,
	"startTime" timestamp,
	"endTime" timestamp,
	"assignedBy" integer NOT NULL,
	"status" "enum_status_1lxmq9j" DEFAULT 'assigned' NOT NULL,
	"notes" text,
	"handoffNotes" text,
	"lastWorkedAt" timestamp,
	"decisionLog" text,
	"externalLinks" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "task_dependencies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"blockedByTaskId" varchar(128) NOT NULL,
	"founderId" integer NOT NULL,
	"dependencyType" "enum_dependencytype_skc5j1" DEFAULT 'finish_to_start' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_documentation_requirements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"docType" varchar(100) NOT NULL,
	"audience" varchar(255),
	"estimatedEffort" numeric(10, 2),
	"contentOutline" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_execution_plan" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"roadmap" text,
	"successMetrics" text,
	"communicationPlan" text,
	"escalationPath" text,
	"preExecutionChecklist" text,
	"aptlssChecklist" text,
	"confidenceScore" numeric(5, 2),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_external_dependencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"dependencyType" "enum_dependencytype_1ilpice" NOT NULL,
	"description" text NOT NULL,
	"owner" varchar(255),
	"dueDate" varchar(10),
	"status" "enum_status_645ovh" DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_milestones" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"dueDate" varchar(10) NOT NULL,
	"status" "enum_status_645ovh" DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_qa_strategy" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"strategy" text NOT NULL,
	"testingPhases" text,
	"qualityMetrics" text,
	"acceptanceCriteria" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_resource_requirements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"resourceType" "enum_resourcetype_1bg4zoy" NOT NULL,
	"resourceName" varchar(255) NOT NULL,
	"proficiencyLevel" "enum_proficiencylevel_1i56otg",
	"estimatedCost" numeric(10, 2),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_risks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"category" "enum_category_xotgg8" NOT NULL,
	"probability" integer NOT NULL,
	"impact" integer NOT NULL,
	"priority" integer NOT NULL,
	"status" "enum_status_1cnaoyu" DEFAULT 'identified' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_schedule_history" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"cardTrelloId" varchar(64),
	"previousStartTime" timestamp,
	"previousEndTime" timestamp,
	"newStartTime" timestamp,
	"newEndTime" timestamp,
	"changedBy" varchar(64) NOT NULL,
	"reason" varchar(255),
	"source" "enum_source_vprdy3" DEFAULT 'manual' NOT NULL,
	"hadConflicts" integer DEFAULT 0 NOT NULL,
	"conflictDetails" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_subtasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"estimatedHours" numeric(10, 2),
	"sequence" integer DEFAULT 0 NOT NULL,
	"status" "enum_status_1klf81u" DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_timeline" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"taskId" varchar(128) NOT NULL,
	"userId" varchar(64) NOT NULL,
	"startDate" varchar(10),
	"endDate" varchar(10),
	"bufferDays" integer DEFAULT 0,
	"totalDays" integer,
	"optimizationData" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_day_reviews" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "time_day_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"dateKey" varchar(16) NOT NULL,
	"status" "enum_status_1qvzp7l" DEFAULT 'open' NOT NULL,
	"overtimeReason" text,
	"summaryJson" text,
	"lockedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "time_day_reviews_dateKey_unique" UNIQUE("dateKey")
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "time_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"taskId" varchar(128) NOT NULL,
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"cardId" varchar(64),
	"cardName" varchar(512),
	"cardUrl" varchar(1024),
	"boardName" varchar(256) DEFAULT 'Unknown Board',
	"listName" varchar(256) DEFAULT 'Unknown',
	"startTime" timestamp NOT NULL,
	"endTime" timestamp,
	"durationMinutes" integer,
	"durationSeconds" integer,
	"notes" text,
	"source" varchar(32) DEFAULT 'legacy' NOT NULL,
	"category" varchar(32) DEFAULT 'client_work' NOT NULL,
	"planDateKey" varchar(16),
	"planBlockId" varchar(128),
	"aptlssStepId" integer,
	"isVoided" boolean DEFAULT false NOT NULL,
	"voidedAt" timestamp,
	"voidReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entry_events" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "time_entry_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"timeEntryId" integer NOT NULL,
	"eventType" varchar(32) NOT NULL,
	"reason" text,
	"beforeJson" text,
	"afterJson" text,
	"metadataJson" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_reconciliation_items" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "time_reconciliation_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"dateKey" varchar(16) NOT NULL,
	"fingerprint" varchar(256) NOT NULL,
	"type" varchar(48) NOT NULL,
	"severity" "enum_severity_11yyky0" DEFAULT 'medium' NOT NULL,
	"status" "enum_status_1ngf43y" DEFAULT 'open' NOT NULL,
	"cardId" varchar(64),
	"cardName" varchar(512),
	"cardUrl" varchar(1024),
	"boardName" varchar(256),
	"listName" varchar(256),
	"timeEntryId" integer,
	"planBlockId" varchar(128),
	"title" varchar(512) NOT NULL,
	"detail" text NOT NULL,
	"sourceJson" text NOT NULL,
	"resolution" text,
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "time_reconciliation_items_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "trello_cache_metadata" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "trello_cache_metadata_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"cacheKey" varchar(255) NOT NULL,
	"lastFetched" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ttlSeconds" integer DEFAULT 300 NOT NULL,
	"hitCount" integer DEFAULT 0 NOT NULL,
	"missCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trello_cached_boards" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "trello_cached_boards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"boardId" varchar(64) NOT NULL,
	"boardData" text NOT NULL,
	"cachedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trello_cached_cards" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "trello_cached_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"boardId" varchar(64) NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardData" text NOT NULL,
	"cachedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trello_cached_tasks" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "trello_cached_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"taskData" text NOT NULL,
	"cachedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unsigned_message_flags" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "unsigned_message_flags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"source" "enum_source_1xgs10d" DEFAULT 'trello' NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"actionId" varchar(64) NOT NULL,
	"messageText" text NOT NULL,
	"flaggedAt" timestamp NOT NULL,
	"resolvedAt" timestamp,
	"resolvedBy" "enum_resolvedby_2vjpz9",
	"resolutionNote" text,
	"demeritIssued" boolean DEFAULT false NOT NULL,
	"demeritIssuedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unsigned_message_flags_actionId_unique" UNIQUE("actionId")
);
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_notification_preferences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"notificationMode" "enum_notificationmode_1rzjyge" DEFAULT 'priority_only' NOT NULL,
	"digestTime" varchar(5) DEFAULT '08:00' NOT NULL,
	"digestTimezone" varchar(50) DEFAULT 'Europe/Amsterdam' NOT NULL,
	"urgentThresholdHours" integer DEFAULT 24 NOT NULL,
	"emailEnabled" integer DEFAULT 1 NOT NULL,
	"emailAddress" varchar(320),
	"inAppEnabled" integer DEFAULT 1 NOT NULL,
	"lastDigestSent" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_preferences_userOpenId_unique" UNIQUE("userOpenId")
);
--> statement-breakpoint
CREATE TABLE "user_working_hours" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_working_hours_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"userOpenId" varchar(64) NOT NULL,
	"workStartHour" integer DEFAULT 9 NOT NULL,
	"workStartMinute" integer DEFAULT 0 NOT NULL,
	"workEndHour" integer DEFAULT 18 NOT NULL,
	"workEndMinute" integer DEFAULT 0 NOT NULL,
	"breakfastTime" varchar(5) DEFAULT '09:00',
	"breakfastDuration" integer DEFAULT 45 NOT NULL,
	"lunchTime" varchar(5) DEFAULT '15:00',
	"lunchDuration" integer DEFAULT 45 NOT NULL,
	"dinnerTime" varchar(5) DEFAULT '20:00',
	"dinnerDuration" integer DEFAULT 120 NOT NULL,
	"enableBreaks" integer DEFAULT 1 NOT NULL,
	"shortBreakInterval" integer DEFAULT 120 NOT NULL,
	"shortBreakDuration" integer DEFAULT 10 NOT NULL,
	"longBreakInterval" integer DEFAULT 240 NOT NULL,
	"longBreakDuration" integer DEFAULT 30 NOT NULL,
	"workingDays" varchar(50) DEFAULT '1,2,3,4,5' NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"weeklyHoursMin" integer DEFAULT 40 NOT NULL,
	"weeklyHoursMax" integer DEFAULT 45 NOT NULL,
	"dailyHoursMin" numeric(4, 2) DEFAULT '8.00' NOT NULL,
	"dailyHoursMax" numeric(4, 2) DEFAULT '9.00' NOT NULL,
	"country" varchar(2) DEFAULT 'US' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "enum_role_1pxhzfx" DEFAULT 'user' NOT NULL,
	"passwordHash" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "va_profiles" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "va_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(320),
	"timezone" varchar(50) DEFAULT 'Asia/Manila' NOT NULL,
	"skills" text,
	"hourlyRate" integer,
	"currency" varchar(3) DEFAULT 'USD',
	"workStartHour" integer DEFAULT 9 NOT NULL,
	"workEndHour" integer DEFAULT 18 NOT NULL,
	"workingDays" varchar(50) DEFAULT '1,2,3,4,5' NOT NULL,
	"breakfastTime" integer,
	"breakfastDuration" integer DEFAULT 0,
	"lunchTime" integer DEFAULT 12,
	"lunchDuration" integer DEFAULT 60,
	"dinnerTime" integer,
	"dinnerDuration" integer DEFAULT 0,
	"status" "enum_status_wan32x" DEFAULT 'active' NOT NULL,
	"trelloMemberId" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vague_reply_flags" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "vague_reply_flags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"source" "enum_source_1xgs10d" DEFAULT 'trello' NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"cardName" varchar(512) NOT NULL,
	"cardUrl" varchar(1024) NOT NULL,
	"actionId" varchar(64) NOT NULL,
	"messageText" text NOT NULL,
	"flaggedAt" timestamp NOT NULL,
	"resolvedAt" timestamp,
	"resolvedBy" "enum_resolvedby_2vjpz9",
	"demeritIssued" boolean DEFAULT false NOT NULL,
	"demeritIssuedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vague_reply_flags_actionId_unique" UNIQUE("actionId")
);
--> statement-breakpoint
CREATE TABLE "weekly_analysis_snapshots" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "weekly_analysis_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"weekKey" varchar(16) NOT NULL,
	"noProgressCards" text,
	"recurringBlockers" text,
	"estimateDrift" text,
	"underperformingWorkers" text,
	"listHoppers" text,
	"unclearScopeProjects" text,
	"processImprovements" text,
	"summary" text,
	"generatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_pay_log" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "weekly_pay_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vaId" integer NOT NULL,
	"founderId" integer NOT NULL,
	"weekStart" date NOT NULL,
	"weekEnd" date NOT NULL,
	"paymentCycleId" integer,
	"baseAmount" numeric(8, 2) DEFAULT '90.00' NOT NULL,
	"meritM1" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"meritM2" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"meritM3" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"meritStreak" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD1" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD2" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD3" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD4" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD5" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD6" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD7" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD8" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD9" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD10" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"demeritD11" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"totalMerits" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"totalDemerits" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"projectedPay" numeric(8, 2) DEFAULT '90.00' NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_performance_signals" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "worker_performance_signals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workerId" varchar(128) NOT NULL,
	"workerName" varchar(256) DEFAULT '' NOT NULL,
	"weekKey" varchar(16) NOT NULL,
	"avgResponseTimeMinutes" integer DEFAULT 0 NOT NULL,
	"checklistItemsCompleted" integer DEFAULT 0 NOT NULL,
	"stalledCardsCount" integer DEFAULT 0 NOT NULL,
	"missedDeadlines" integer DEFAULT 0 NOT NULL,
	"robertEscalationsCount" integer DEFAULT 0 NOT NULL,
	"reworkCount" integer DEFAULT 0 NOT NULL,
	"unclearHandovers" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"calculatedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_evidence_items" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "workspace_evidence_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source" "enum_source_1ur3rkb" NOT NULL,
	"sourceId" varchar(256) NOT NULL,
	"sourceContainerId" varchar(256),
	"kind" varchar(128) DEFAULT 'record' NOT NULL,
	"title" varchar(1024) NOT NULL,
	"summary" text,
	"content" text,
	"sourceUrl" varchar(2048),
	"mimeType" varchar(256),
	"modifiedAt" timestamp,
	"observedAt" timestamp NOT NULL,
	"contentHash" varchar(64) NOT NULL,
	"metadataJson" text,
	"reviewStatus" "enum_reviewstatus_dfhow7" DEFAULT 'unreviewed' NOT NULL,
	"reviewedAt" timestamp,
	"reviewedBy" varchar(128),
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_evidence_links" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "workspace_evidence_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"evidenceId" integer NOT NULL,
	"cardId" varchar(64) NOT NULL,
	"relevanceScore" integer NOT NULL,
	"matchReason" varchar(512) NOT NULL,
	"linkMethod" "enum_linkmethod_99towq" DEFAULT 'automatic' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aptlss_evidence_conflicts" ADD CONSTRAINT "aptlss_evidence_conflict_source_fk" FOREIGN KEY ("sourceEvidenceId") REFERENCES "public"."workspace_evidence_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "aptlss_evidence_conflicts" ADD CONSTRAINT "aptlss_evidence_conflict_asserted_fk" FOREIGN KEY ("assertedEvidenceId") REFERENCES "public"."workspace_evidence_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "aptlss_evidence_revisions" ADD CONSTRAINT "aptlss_evidence_revision_item_fk" FOREIGN KEY ("evidenceId") REFERENCES "public"."workspace_evidence_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "aptlss_evidence_subject_links" ADD CONSTRAINT "aptlss_evidence_subject_item_fk" FOREIGN KEY ("evidenceId") REFERENCES "public"."workspace_evidence_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "aptlss_verification_followups" ADD CONSTRAINT "aptlss_verification_followup_conflict_fk" FOREIGN KEY ("conflictId") REFERENCES "public"."aptlss_evidence_conflicts"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "workspace_evidence_links" ADD CONSTRAINT "workspace_evidence_item_fk" FOREIGN KEY ("evidenceId") REFERENCES "public"."workspace_evidence_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "aptlss_assessment_feedback_assessment_idx" ON "aptlss_assessment_feedback" USING btree ("assessmentId");--> statement-breakpoint
CREATE INDEX "aptlss_assessment_feedback_card_created_idx" ON "aptlss_assessment_feedback" USING btree ("cardId","createdAt");--> statement-breakpoint
CREATE INDEX "aptlss_assessments_card_assessed_idx" ON "aptlss_assessments" USING btree ("cardId","assessedAt");--> statement-breakpoint
CREATE INDEX "aptlss_assessments_next_idx" ON "aptlss_assessments" USING btree ("nextAssessmentAt");--> statement-breakpoint
CREATE UNIQUE INDEX "aptlss_evidence_conflict_pair_unique" ON "aptlss_evidence_conflicts" USING btree ("sourceEvidenceId","assertedEvidenceId");--> statement-breakpoint
CREATE INDEX "aptlss_evidence_conflict_va_status_idx" ON "aptlss_evidence_conflicts" USING btree ("vaId","status","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "aptlss_evidence_revision_hash_unique" ON "aptlss_evidence_revisions" USING btree ("evidenceId","contentHash");--> statement-breakpoint
CREATE INDEX "aptlss_evidence_revision_observed_idx" ON "aptlss_evidence_revisions" USING btree ("evidenceId","observedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "aptlss_evidence_subject_unique" ON "aptlss_evidence_subject_links" USING btree ("evidenceId","vaId","subjectType","subjectId");--> statement-breakpoint
CREATE INDEX "aptlss_evidence_subject_lookup_idx" ON "aptlss_evidence_subject_links" USING btree ("vaId","subjectType","subjectId","relevanceScore");--> statement-breakpoint
CREATE UNIQUE INDEX "va_operational_policy_idx" ON "aptlss_operational_policies" USING btree ("vaId","ruleKey");--> statement-breakpoint
CREATE UNIQUE INDEX "va_aptlss_plan_card_idx" ON "aptlss_plans" USING btree ("vaId","cardId");--> statement-breakpoint
CREATE INDEX "aptlss_verification_followup_va_status_idx" ON "aptlss_verification_followups" USING btree ("vaId","status","dueAt");--> statement-breakpoint
CREATE INDEX "aptlss_verification_followup_card_idx" ON "aptlss_verification_followups" USING btree ("cardId","status");--> statement-breakpoint
CREATE INDEX "aptlss_waiting_reasons_va_status_idx" ON "aptlss_waiting_reasons" USING btree ("vaId","status","createdAt");--> statement-breakpoint
CREATE INDEX "aptlss_waiting_reasons_card_status_idx" ON "aptlss_waiting_reasons" USING btree ("cardId","status","createdAt");--> statement-breakpoint
CREATE INDEX "aptlss_waiting_reasons_follow_up_idx" ON "aptlss_waiting_reasons" USING btree ("status","followUpAt");--> statement-breakpoint
CREATE UNIQUE INDEX "card_step_user_unique" ON "atis_checklist_completion" USING btree ("card_id","step_index","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tab_daily_va_date_idx" ON "browser_tab_daily_evidence" USING btree ("vaId","snapshotDate");--> statement-breakpoint
CREATE INDEX "browser_tab_daily_status_date_idx" ON "browser_tab_daily_evidence" USING btree ("status","snapshotDate");--> statement-breakpoint
CREATE INDEX "browser_tab_states_va_captured_idx" ON "browser_tab_states" USING btree ("vaId","capturedAt");--> statement-breakpoint
CREATE INDEX "browser_tab_states_captured_idx" ON "browser_tab_states" USING btree ("capturedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "va_card_state_card_idx" ON "card_states" USING btree ("vaId","cardId");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_evidence_channel_external_unique" ON "communication_evidence" USING btree ("channel","externalId");--> statement-breakpoint
CREATE INDEX "communication_evidence_card_occurred_idx" ON "communication_evidence" USING btree ("linkedCardId","occurredAt");--> statement-breakpoint
CREATE INDEX "communication_evidence_response_idx" ON "communication_evidence" USING btree ("responseRequired","respondedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_evidence_date_card_unique" ON "compliance_card_evidence" USING btree ("snapshotDate","cardId");--> statement-breakpoint
CREATE INDEX "compliance_evidence_card_date_idx" ON "compliance_card_evidence" USING btree ("cardId","snapshotDate");--> statement-breakpoint
CREATE INDEX "compliance_evidence_date_compliant_idx" ON "compliance_card_evidence" USING btree ("snapshotDate","compliant");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_clarification_date_key_unique" ON "compliance_clarification_requests" USING btree ("snapshotDate","evidenceKey");--> statement-breakpoint
CREATE INDEX "compliance_clarification_status_requested_idx" ON "compliance_clarification_requests" USING btree ("status","requestedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_comm_date_key_unique" ON "compliance_communication_evidence" USING btree ("snapshotDate","evidenceKey");--> statement-breakpoint
CREATE INDEX "compliance_comm_date_kind_outcome_idx" ON "compliance_communication_evidence" USING btree ("snapshotDate","kind","outcome");--> statement-breakpoint
CREATE INDEX "compliance_comm_external_idx" ON "compliance_communication_evidence" USING btree ("channel","externalId");--> statement-breakpoint
CREATE UNIQUE INDEX "va_card_update_idx" ON "daily_card_updates" USING btree ("vaId","cardId","date");--> statement-breakpoint
CREATE UNIQUE INDEX "va_compliance_snapshot_idx" ON "daily_compliance_snapshots" USING btree ("vaId","snapshotDate");--> statement-breakpoint
CREATE UNIQUE INDEX "va_due_date_assign_idx" ON "daily_due_date_assignments" USING btree ("vaId","cardId","date");--> statement-breakpoint
CREATE UNIQUE INDEX "va_daily_plan_idx" ON "daily_plans" USING btree ("vaId","dateKey");--> statement-breakpoint
CREATE UNIQUE INDEX "va_triage_date_idx" ON "daily_triage_state" USING btree ("vaId","triageDate");--> statement-breakpoint
CREATE UNIQUE INDEX "va_streak_date_idx" ON "daily_update_streak" USING btree ("vaId","streakDate");--> statement-breakpoint
CREATE INDEX "decision_outcomes_va_resolved_idx" ON "decision_outcomes" USING btree ("vaId","resolvedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "va_on_hold_check_idx" ON "on_hold_daily_checks" USING btree ("vaId","cardId","date");--> statement-breakpoint
CREATE UNIQUE INDEX "va_priority_score_card_idx" ON "priority_scores" USING btree ("vaId","cardId");--> statement-breakpoint
CREATE UNIQUE INDEX "va_reply_thread_idx" ON "reply_threads" USING btree ("vaId","cardId","source");--> statement-breakpoint
CREATE INDEX "scheduled_job_leases_expiry_idx" ON "scheduled_job_leases" USING btree ("leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_job_started_idx" ON "scheduled_job_runs" USING btree ("jobKey","startedAt");--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_status_started_idx" ON "scheduled_job_runs" USING btree ("status","startedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "va_sunday_date_idx" ON "sunday_checklist" USING btree ("vaId","sundayDate");--> statement-breakpoint
CREATE INDEX "time_day_reviews_status_date_idx" ON "time_day_reviews" USING btree ("status","dateKey");--> statement-breakpoint
CREATE INDEX "time_entries_period_idx" ON "time_entries" USING btree ("startTime","endTime");--> statement-breakpoint
CREATE INDEX "time_entries_plan_block_idx" ON "time_entries" USING btree ("planDateKey","planBlockId");--> statement-breakpoint
CREATE INDEX "time_entries_step_idx" ON "time_entries" USING btree ("aptlssStepId");--> statement-breakpoint
CREATE INDEX "time_entry_events_entry_created_idx" ON "time_entry_events" USING btree ("timeEntryId","createdAt");--> statement-breakpoint
CREATE INDEX "time_entry_events_type_created_idx" ON "time_entry_events" USING btree ("eventType","createdAt");--> statement-breakpoint
CREATE INDEX "time_reconciliation_date_status_idx" ON "time_reconciliation_items" USING btree ("dateKey","status");--> statement-breakpoint
CREATE INDEX "time_reconciliation_entry_idx" ON "time_reconciliation_items" USING btree ("timeEntryId");--> statement-breakpoint
CREATE UNIQUE INDEX "va_weekly_analysis_idx" ON "weekly_analysis_snapshots" USING btree ("vaId","weekKey");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_evidence_source_id_unique" ON "workspace_evidence_items" USING btree ("source","sourceId");--> statement-breakpoint
CREATE INDEX "workspace_evidence_source_modified_idx" ON "workspace_evidence_items" USING btree ("source","modifiedAt");--> statement-breakpoint
CREATE INDEX "workspace_evidence_active_observed_idx" ON "workspace_evidence_items" USING btree ("active","observedAt");--> statement-breakpoint
CREATE INDEX "workspace_evidence_review_idx" ON "workspace_evidence_items" USING btree ("reviewStatus","modifiedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_evidence_link_unique" ON "workspace_evidence_links" USING btree ("evidenceId","cardId");--> statement-breakpoint
CREATE INDEX "workspace_evidence_card_relevance_idx" ON "workspace_evidence_links" USING btree ("cardId","relevanceScore");