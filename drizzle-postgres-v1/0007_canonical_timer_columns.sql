ALTER TABLE "time_entries" ALTER COLUMN "vaId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "trackedUserId" integer;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "trackedProfileId" integer;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_trackedUserId_users_id_fk" FOREIGN KEY ("trackedUserId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_trackedProfileId_va_profiles_id_fk" FOREIGN KEY ("trackedProfileId") REFERENCES "public"."va_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_active_account_idx" ON "time_entries" USING btree ("trackedUserId") WHERE "time_entries"."endTime" IS NULL AND "time_entries"."isVoided" = false;--> statement-breakpoint
CREATE INDEX "time_entries_account_period_idx" ON "time_entries" USING btree ("trackedUserId","startTime");
--> statement-breakpoint
CREATE FUNCTION enforce_canonical_timer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."trackedUserId" IS NOT NULL AND NEW."vaId" IS NOT NULL AND NOT (
      has_table_privilege(current_user, TG_RELID, 'TRIGGER')
      AND current_setting('aptlss.legacy_timer_import', true) IS NOT DISTINCT FROM txid_current()::text
    ) THEN
      RAISE EXCEPTION 'New timers cannot invent legacy provenance' USING ERRCODE='23514';
    END IF;
    IF NEW."trackedProfileId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM va_profiles p WHERE p.id=NEW."trackedProfileId"
        AND p."userId"=NEW."trackedUserId" AND p."founderId"=NEW."founderId"
    ) THEN
      RAISE EXCEPTION 'Canonical timer profile/account/founder mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW."trackedUserId" IS NOT NULL AND NEW."endTime" IS NULL AND NOT NEW."isVoided"
      AND EXISTS (SELECT 1 FROM users WHERE id=NEW."trackedUserId" AND role='worker')
      AND (NEW."trackedProfileId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM va_profiles WHERE id=NEW."trackedProfileId" AND status='active'
      )) THEN
      RAISE EXCEPTION 'New worker timers require an active canonical profile' USING ERRCODE='23514';
    END IF;
    IF NEW."trackedUserId" IS NULL AND NOT (
      has_table_privilege(current_user, TG_RELID, 'TRIGGER')
      AND current_setting('aptlss.legacy_timer_import', true) IS NOT DISTINCT FROM txid_current()::text
    ) THEN
      RAISE EXCEPTION 'Canonical timer identity required' USING ERRCODE='PT409';
    END IF;
    IF NEW."trackedUserId" IS NOT NULL AND NEW."endTime" IS NULL AND NOT NEW."isVoided" AND EXISTS (
      SELECT 1 FROM time_entries WHERE "trackedUserId" IS NULL AND "endTime" IS NULL AND NOT "isVoided"
    ) THEN
      RAISE EXCEPTION 'Active legacy timer ownership requires review' USING ERRCODE='PT409';
    END IF;
  ELSE
    IF OLD."endTime" IS NOT NULL AND NEW."endTime" IS NULL THEN
      RAISE EXCEPTION 'Completed timers cannot be reopened' USING ERRCODE='23514';
    END IF;
    IF NEW."vaId" IS DISTINCT FROM OLD."vaId" OR NEW."founderId" IS DISTINCT FROM OLD."founderId" THEN
      RAISE EXCEPTION 'Timer provenance is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD."trackedUserId" IS NOT NULL AND NEW."trackedProfileId" IS DISTINCT FROM OLD."trackedProfileId" THEN
      RAISE EXCEPTION 'Resolved historical profile is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW."trackedUserId" IS DISTINCT FROM OLD."trackedUserId" THEN
      IF NEW."trackedProfileId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM va_profiles p WHERE p.id=NEW."trackedProfileId"
          AND p."userId"=NEW."trackedUserId" AND p."founderId"=NEW."founderId"
      ) THEN
        RAISE EXCEPTION 'Resolved timer profile/account/founder mismatch' USING ERRCODE='23514';
      END IF;
      IF NOT has_table_privilege(current_user, TG_RELID, 'TRIGGER')
        OR OLD."trackedUserId" IS NOT NULL OR NEW."trackedUserId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM time_entry_events e
        WHERE e."timeEntryId"=OLD.id AND e."eventType"='identity_resolution'
          AND (e."metadataJson"::jsonb->>'transactionId')=txid_current()::text
          AND (e."afterJson"::jsonb->>'trackedUserId')=NEW."trackedUserId"::text
          AND (e."afterJson"::jsonb->>'trackedProfileId') IS NOT DISTINCT FROM NEW."trackedProfileId"::text
      ) THEN
        RAISE EXCEPTION 'Timer identity requires an audited operator resolution' USING ERRCODE='PT409';
      END IF;
    ELSIF OLD."trackedUserId" IS NULL THEN
      RAISE EXCEPTION 'Resolve timer identity before editing legacy history' USING ERRCODE='PT409';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER time_entries_canonical_identity BEFORE INSERT OR UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_timer_identity();
