import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, lte } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import * as schema from "../drizzle/schema.postgres";
import { upsertSourceCommitment } from "./sourceCommitments";

const controls = vi.hoisted(() => ({
  url: process.env.APTLSS_TEST_DATABASE_URL,
  db: undefined as NodePgDatabase<typeof schema> | undefined,
  sendEmailWithOutcome: vi.fn(),
}));

// Never import db.ts or fall back to the application's DATABASE_URL.
vi.mock("./db", () => ({ getDb: async () => controls.db }));
vi.mock("./services/email", () => ({ sendEmailWithOutcome: controls.sendEmailWithOutcome }));

type ReminderService = typeof import("./reminderOrchestration");
type Fixture = {
  ownerId: number;
  workerId: number;
  workerOpenId: string;
  commitmentId: number;
  scheduleId: number;
  sourceId: string;
};

const owned = {
  userIds: [] as number[],
  profileIds: [] as number[],
  commitmentIds: [] as number[],
  ruleIds: [] as number[],
};

const databaseUrl = controls.url;

describe.skipIf(!databaseUrl)(
  "reminder orchestration real PostgreSQL race regressions",
  { timeout: 30_000 },
  () => {
    let pool: Pool | undefined;
    let lock: PoolClient | undefined;
    let db: NodePgDatabase<typeof schema>;
    let reminders: ReminderService;

    beforeAll(async () => {
      const target = new URL(requireIsolatedPostgresTestDatabase(databaseUrl, process.env.NODE_ENV === "production"));
      pool = new Pool({
        connectionString: databaseUrl!,
        max: 8,
        connectionTimeoutMillis: 10_000,
      });
      db = drizzle(pool, { schema });
      controls.db = db;

      const { rows: identity } = await pool.query(
        "SELECT current_database() AS name, current_setting('server_version') AS version"
      );
      expect(identity[0]?.name).toBe(target.pathname.slice(1));
      expect(identity[0]?.version).toMatch(/^18\./);
      const { rows: tables } = await pool.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
        ('users', 'commitments', 'reminder_schedules', 'reminder_policies', 'notification_history')`);
      expect(tables).toHaveLength(5);

      lock = await pool.connect();
      const { rows: lockRows } = await lock.query(
        "SELECT pg_advisory_lock(hashtext('reminder-orchestration-integration'))"
      );


      controls.sendEmailWithOutcome.mockResolvedValue({
        status: "uncertain",
        reason: "Email providers are disabled in this integration test.",
      });
      reminders = await import("./reminderOrchestration");
    });

    afterEach(async () => {
      if (!db || !owned.userIds.length) return;
      await db.transaction(async tx => {
        if (owned.userIds.length) {
          await tx
            .delete(schema.notificationHistory)
            .where(inArray(schema.notificationHistory.userId, owned.userIds));
          await tx
            .delete(schema.reminderPolicies)
            .where(inArray(schema.reminderPolicies.userId, owned.userIds));
        }
        if (owned.commitmentIds.length) {
          await tx
            .delete(schema.reminderAuditEvents)
            .where(
              inArray(
                schema.reminderAuditEvents.commitmentId,
                owned.commitmentIds
              )
            );
          await tx
            .delete(schema.reminderSchedules)
            .where(
              inArray(
                schema.reminderSchedules.commitmentId,
                owned.commitmentIds
              )
            );
          await tx
            .delete(schema.commitments)
            .where(inArray(schema.commitments.id, owned.commitmentIds));
        }
        if (owned.ruleIds.length) {
          await tx
            .delete(schema.reminderRules)
            .where(inArray(schema.reminderRules.id, owned.ruleIds));
        }
        if (owned.profileIds.length) {
          await tx
            .delete(schema.vaProfiles)
            .where(inArray(schema.vaProfiles.id, owned.profileIds));
        }
        if (owned.userIds.length) {
          await tx
            .delete(schema.reminderAuditEvents)
            .where(
              inArray(
                schema.reminderAuditEvents.workspaceOwnerId,
                owned.userIds
              )
            );
          await tx
            .delete(schema.users)
            .where(inArray(schema.users.id, owned.userIds));
        }
      });
      owned.userIds = [];
      owned.profileIds = [];
      owned.commitmentIds = [];
      owned.ruleIds = [];
    });

    afterAll(async () => {
      controls.db = undefined;
      if (lock) {
        await lock
          .query("SELECT pg_advisory_unlock(hashtext('reminder-orchestration-integration'))")
          .catch(() => undefined);
        lock.release();
      }
      if (pool) await pool.end();
    });

    async function createFixture(
      state: "draft_ready" | "scheduled",
      scheduledFor = new Date(Date.now() - 60_000)
    ): Promise<Fixture> {
      const ownerOpenId = `reminder-it-owner-${randomUUID()}`;
      const workerOpenId = `reminder-it-worker-${randomUUID()}`;
      const [owner] = await db
        .insert(schema.users)
        .values({
          openId: ownerOpenId,
          name: "Reminder integration owner",
          role: "admin",
        })
        .returning();
      owned.userIds.push(owner.id);
      const [worker] = await db
        .insert(schema.users)
        .values({
          openId: workerOpenId,
          name: "Reminder integration worker",
          role: "worker",
        })
        .returning();
      owned.userIds.push(worker.id);

      const [profile] = await db
        .insert(schema.vaProfiles)
        .values({
          userId: worker.id,
          founderId: owner.id,
          name: "Reminder integration worker",
          status: "active",
        })
        .returning();
      owned.profileIds.push(profile.id);

      await db.insert(schema.reminderPolicies).values({
        userId: worker.id,
        enabled: true,
        inAppEnabled: true,
        emailEnabled: false,
        maxPerDay: 100,
        minIntervalMinutes: 0,
        quietHoursStart: "00:00",
        quietHoursEnd: "00:00",
        timezone: "UTC",
        allowWeekends: true,
      });

      const sourceId = `reminder-it-${randomUUID()}`;
      const taskName = `Reminder race fixture ${randomUUID()}`;
      const [commitment] = await db
        .insert(schema.commitments)
        .values({
          workspaceOwnerId: owner.id,
          assignedUserId: worker.id,
          createdByUserId: owner.id,
          sourceType: "manual",
          sourceId,
          title: taskName,
          dueAt: new Date(Date.now() + 60 * 60_000),
        })
        .returning();
      owned.commitmentIds.push(commitment.id);

      const [rule] = await db
        .insert(schema.reminderRules)
        .values({
          workspaceOwnerId: owner.id,
          createdByUserId: owner.id,
          name: "Integration in-app approval",
          triggerType: "at_due",
          offsetMinutes: 0,
          channel: "in_app",
          requireApproval: true,
          maxAttempts: 1,
          cooldownMinutes: 0,
        })
        .returning();
      owned.ruleIds.push(rule.id);

      const [schedule] = await db
        .insert(schema.reminderSchedules)
        .values({
          commitmentId: commitment.id,
          ruleId: rule.id,
          recipientUserId: worker.id,
          scheduledFor,
          state,
          channel: "in_app",
          idempotencyKey: randomUUID().replaceAll("-", ""),
          draftTitle: `Reminder: ${taskName}`,
          draftContent: "Review this integration-only reminder.",
        })
        .returning();

      return {
        ownerId: owner.id,
        workerId: worker.id,
        workerOpenId,
        commitmentId: commitment.id,
        scheduleId: schedule.id,
        sourceId,
      };
    }

    function workerActor(fixture: Fixture) {
      return {
        id: fixture.workerId,
        openId: fixture.workerOpenId,
        role: "worker" as const,
        email: null,
      };
    }

    async function createWorker(ownerId: number) {
      const openId = `reminder-it-worker-${randomUUID()}`;
      const email = `reminder-it-${randomUUID()}@example.invalid`;
      const [worker] = await db
        .insert(schema.users)
        .values({
          openId,
          email,
          name: "Reminder reassignment worker",
          role: "worker",
        })
        .returning();
      owned.userIds.push(worker.id);
      const [profile] = await db
        .insert(schema.vaProfiles)
        .values({
          userId: worker.id,
          founderId: ownerId,
          name: "Reminder reassignment worker",
          status: "active",
        })
        .returning();
      owned.profileIds.push(profile.id);
      return { id: worker.id, openId, email };
    }

    function processDueRemindersInWorkspace(
      now: Date,
      limit: number,
      workspaceOwnerId: number,
    ) {
      return reminders.processDueReminders(now, limit, workspaceOwnerId);
    }

    async function expectDueReminderHeldForWorkerScope(fixture: Fixture) {
      const now = new Date();
      controls.sendEmailWithOutcome.mockClear();

      const processed = await processDueRemindersInWorkspace(
        now,
        50,
        fixture.ownerId,
      );
      const [schedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      const notifications = await db
        .select({ id: schema.notificationHistory.id })
        .from(schema.notificationHistory)
        .where(
          and(
            eq(schema.notificationHistory.userId, fixture.workerId),
            eq(schema.notificationHistory.taskId, fixture.sourceId),
          ),
        );

      expect(processed.needsReview).toBe(1);
      expect(schedule.state).toBe("needs_review");
      expect(schedule.error ?? schedule.policyReason).toMatch(
        /worker|profile|workspace|assignment/i,
      );
      expect(notifications).toHaveLength(0);
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    }

    async function waitForPostgresLockWaits(tableName: string, minimum: number) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await pool!.query(
          `SELECT COUNT(DISTINCT blocked.pid) AS waiting
           FROM pg_stat_activity AS blocked
           WHERE blocked.datname = current_database()
             AND blocked.wait_event_type = 'Lock'
             AND cardinality(pg_blocking_pids(blocked.pid)) > 0
             AND EXISTS (SELECT 1 FROM pg_locks held JOIN pg_class relation ON relation.oid = held.relation
               WHERE held.pid = blocked.pid AND lower(relation.relname) = $1)`,
          [tableName.toLowerCase()]
        );
        if (Number(rows[0]?.waiting ?? 0) >= minimum) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock wait(s) on ${tableName}`);
    }

    async function assertNoUnownedWorkForGlobalWorker(
      now: Date,
      recoveryNow = now
    ) {
      const due = await db
        .select({ id: schema.reminderSchedules.id })
        .from(schema.reminderSchedules)
        .innerJoin(
          schema.commitments,
          eq(schema.commitments.id, schema.reminderSchedules.commitmentId)
        )
        .where(
          and(
            eq(schema.reminderSchedules.state, "scheduled"),
            lte(schema.reminderSchedules.scheduledFor, now),
            eq(schema.commitments.status, "open")
          )
        )
        .limit(1);
      if (due.length) {
        throw new Error(
          "Refusing to run the global reminder worker while unrelated due reminders exist in the test database."
        );
      }

      const staleBefore = new Date(recoveryNow.getTime() - 15 * 60_000);
      const interrupted = await db
        .select({ id: schema.reminderSchedules.id })
        .from(schema.reminderSchedules)
        .where(
          and(
            inArray(schema.reminderSchedules.state, ["preparing", "sending"]),
            lte(schema.reminderSchedules.lastAttemptAt, staleBefore)
          )
        )
        .limit(1);
      if (interrupted.length) {
        throw new Error(
          "Refusing to run reminder recovery while unrelated interrupted reminders exist in the test database."
        );
      }
    }

    it("reuses the existing commitment and schedule when creation is repeated", async () => {
      const fixture = await createFixture("scheduled");
      const actor = workerActor(fixture);
      const input = {
        title: `Repeated reminder creation ${randomUUID()}`,
        context: "Retry-safe creation regression.",
        dueAt: new Date(Date.now() + 24 * 60 * 60_000),
        sourceType: "manual" as const,
        triggerType: "before_due" as const,
        offsetMinutes: 60,
        channel: "in_app" as const,
        requireApproval: false,
      };

      const first = await reminders.createReminder(actor, input);
      owned.commitmentIds.push(first.commitmentId);
      owned.ruleIds.push(first.ruleId);
      const repeated = await reminders.createReminder(actor, input);
      owned.commitmentIds.push(repeated.commitmentId);
      owned.ruleIds.push(repeated.ruleId);

      expect(repeated).toMatchObject({
        commitmentId: first.commitmentId,
        ruleId: first.ruleId,
        scheduleId: first.scheduleId,
      });

      const commitments = await db
        .select({ id: schema.commitments.id })
        .from(schema.commitments)
        .where(eq(schema.commitments.title, input.title));
      const schedules = await db
        .select({ id: schema.reminderSchedules.id })
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.commitmentId, first.commitmentId));
      expect(commitments).toHaveLength(1);
      expect(schedules).toHaveLength(1);
    });

    it("linearizes in-app approval against commitment closure without a contradictory delivery", async () => {
      controls.sendEmailWithOutcome.mockClear();

      for (let attempt = 0; attempt < 3; attempt++) {
        const fixture = await createFixture("draft_ready");
        const actor = workerActor(fixture);
        let release!: () => void;
        const start = new Promise<void>(resolve => {
          release = resolve;
        });
        const approval = start.then(() =>
          reminders.approveAndSendReminder(actor, fixture.scheduleId)
        );
        const closure = start.then(() =>
          reminders.closeCommitment(actor, fixture.commitmentId, "completed")
        );
        release();

        const [approvalResult, closureResult] = await Promise.allSettled([
          approval,
          closure,
        ]);
        expect(closureResult.status).toBe("fulfilled");

        const [commitment] = await db
          .select()
          .from(schema.commitments)
          .where(eq(schema.commitments.id, fixture.commitmentId));
        const [schedule] = await db
          .select()
          .from(schema.reminderSchedules)
          .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
        const notifications = await db
          .select({ id: schema.notificationHistory.id })
          .from(schema.notificationHistory)
          .where(
            and(
              eq(schema.notificationHistory.userId, fixture.workerId),
              eq(schema.notificationHistory.taskId, fixture.sourceId)
            )
          );

        expect(commitment.status).toBe("completed");
        if (schedule.state === "sent") {
          expect(approvalResult.status).toBe("fulfilled");
          expect(notifications).toHaveLength(1);
        } else {
          expect(schedule.state).toBe("cancelled");
          expect(approvalResult.status).toBe("rejected");
          expect(notifications).toHaveLength(0);
        }
      }

      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });

    it("serializes concurrent automatic in-app deliveries against the recipient quota", async () => {
      const now = new Date();
      await assertNoUnownedWorkForGlobalWorker(now);
      const first = await createFixture("scheduled", new Date(now.getTime() - 60_000));
      const second = await createFixture("scheduled", new Date(now.getTime() - 60_000));
      const scheduleRules = await db
        .select({ ruleId: schema.reminderSchedules.ruleId })
        .from(schema.reminderSchedules)
        .where(inArray(schema.reminderSchedules.id, [first.scheduleId, second.scheduleId]));
      const ruleIds = scheduleRules.map(row => row.ruleId);

      await db.update(schema.commitments).set({
        workspaceOwnerId: first.ownerId,
        assignedUserId: first.workerId,
      }).where(eq(schema.commitments.id, second.commitmentId));
      await db.update(schema.reminderSchedules).set({ recipientUserId: first.workerId })
        .where(eq(schema.reminderSchedules.id, second.scheduleId));
      await db.update(schema.reminderRules).set({
        workspaceOwnerId: first.ownerId,
        requireApproval: false,
      }).where(inArray(schema.reminderRules.id, ruleIds));
      await db.update(schema.reminderPolicies).set({ maxPerDay: 1, minIntervalMinutes: 0 })
        .where(eq(schema.reminderPolicies.userId, first.workerId));

      const commitmentGate = await pool!.connect();
      const recipientGate = await pool!.connect();
      let commitmentGateOpen = false;
      let recipientGateOpen = false;
      let deliveries: Promise<unknown> | undefined;
      let deliveriesFinished = false;
      try {
        await commitmentGate.query("BEGIN");
        commitmentGateOpen = true;
        await recipientGate.query("BEGIN");
        recipientGateOpen = true;
        await commitmentGate.query(
          "SELECT id FROM commitments WHERE id IN ($1, $2) ORDER BY id FOR SHARE",
          [first.commitmentId, second.commitmentId]
        );
        await recipientGate.query(
          "SELECT id FROM users WHERE id = $1 FOR SHARE",
          [first.workerId]
        );

        deliveries = Promise.all([
          reminders.processDueReminders(now, 2),
          reminders.processDueReminders(now, 2),
        ]).then(result => {
          deliveriesFinished = true;
          return result;
        });

        // Both workers must pass their early quota reads and reach the locked
        // delivery boundary before either can complete.
        await waitForPostgresLockWaits("commitments", 2);
        await commitmentGate.query("COMMIT");
        commitmentGateOpen = false;
        await waitForPostgresLockWaits("users", 1);
        expect(deliveriesFinished).toBe(false);

        await recipientGate.query("COMMIT");
        recipientGateOpen = false;
        await deliveries;

        const schedules = await db
          .select({ id: schema.reminderSchedules.id, state: schema.reminderSchedules.state })
          .from(schema.reminderSchedules)
          .where(inArray(schema.reminderSchedules.id, [first.scheduleId, second.scheduleId]));
        expect(schedules.filter(row => row.state === "sent")).toHaveLength(1);
        expect(schedules.filter(row => row.state === "scheduled")).toHaveLength(1);

        const notifications = await db
          .select({ id: schema.notificationHistory.id })
          .from(schema.notificationHistory)
          .where(and(
            eq(schema.notificationHistory.userId, first.workerId),
            inArray(schema.notificationHistory.taskId, [first.sourceId, second.sourceId])
          ));
        expect(notifications).toHaveLength(1);
      } finally {
        if (commitmentGateOpen) await commitmentGate.query("ROLLBACK").catch(() => undefined);
        if (recipientGateOpen) await recipientGate.query("ROLLBACK").catch(() => undefined);
        commitmentGate.release();
        recipientGate.release();
        if (deliveries) {
          await Promise.race([
            deliveries.then(() => undefined, () => undefined),
            new Promise(resolve => setTimeout(resolve, 5_000)),
          ]);
        }
      }
    });

    it.each([
      { priorState: "sent" as const, cooldown: false },
      { priorState: "sending" as const, cooldown: false },
      { priorState: "needs_review" as const, cooldown: false },
      { priorState: "sent" as const, cooldown: true },
    ])("enforces UTC quota timestamps for $priorState (cooldown=$cooldown) near midnight", async ({ priorState, cooldown }) => {
      const now = new Date("2026-01-15T00:30:00.000Z");
      const previousAt = new Date("2026-01-15T00:20:00.000Z");
      const prior = await createFixture(priorState, previousAt);
      const pending = await createFixture("scheduled", new Date(now.getTime() - 60_000));
      await db.update(schema.reminderSchedules).set({
        ...(priorState === "sent" ? { sentAt: previousAt } : { approvedAt: previousAt }),
      }).where(eq(schema.reminderSchedules.id, prior.scheduleId));
      await db.update(schema.commitments).set({ workspaceOwnerId: prior.ownerId, assignedUserId: prior.workerId })
        .where(eq(schema.commitments.id, pending.commitmentId));
      const [pendingSchedule] = await db.update(schema.reminderSchedules).set({ recipientUserId: prior.workerId })
        .where(eq(schema.reminderSchedules.id, pending.scheduleId)).returning();
      await db.update(schema.reminderRules).set({ workspaceOwnerId: prior.ownerId, requireApproval: false })
        .where(eq(schema.reminderRules.id, pendingSchedule.ruleId));
      await db.update(schema.reminderPolicies).set({ maxPerDay: cooldown ? 100 : 1, minIntervalMinutes: cooldown ? 60 : 0 })
        .where(eq(schema.reminderPolicies.userId, prior.workerId));

      await processDueRemindersInWorkspace(now, 2, prior.ownerId);
      const [held] = await db.select().from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, pending.scheduleId));
      expect(held.state).toBe("scheduled");
      expect(held.policyReason).toMatch(cooldown ? /cooldown/i : /daily reminder limit/i);
      expect(held.scheduledFor.getTime()).toBeGreaterThan(now.getTime());
      const notifications = await db.select().from(schema.notificationHistory)
        .where(and(eq(schema.notificationHistory.userId, prior.workerId), eq(schema.notificationHistory.taskId, pending.sourceId)));
      expect(notifications).toHaveLength(0);
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });

    it("processes due reminders only inside the requested workspace", async () => {
      const now = new Date();
      const scoped = await createFixture(
        "scheduled",
        new Date(now.getTime() - 60_000),
      );
      const otherWorkspace = await createFixture(
        "scheduled",
        new Date(now.getTime() - 60_000),
      );
      controls.sendEmailWithOutcome.mockClear();

      const processed = await processDueRemindersInWorkspace(
        now,
        50,
        scoped.ownerId,
      );
      const schedules = await db
        .select({ id: schema.reminderSchedules.id, state: schema.reminderSchedules.state })
        .from(schema.reminderSchedules)
        .where(
          inArray(schema.reminderSchedules.id, [
            scoped.scheduleId,
            otherWorkspace.scheduleId,
          ]),
        );

      expect(processed).toMatchObject({ claimed: 1, drafted: 1 });
      expect(schedules).toEqual(
        expect.arrayContaining([
          { id: scoped.scheduleId, state: "draft_ready" },
          { id: otherWorkspace.scheduleId, state: "scheduled" },
        ]),
      );
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });

    it("holds a due reminder when its assigned account is no longer a worker", async () => {
      const fixture = await createFixture("scheduled");
      await db
        .update(schema.users)
        .set({ role: "user" })
        .where(eq(schema.users.id, fixture.workerId));

      await expectDueReminderHeldForWorkerScope(fixture);
    });

    it("holds a due reminder when the assigned worker has no active profile in its workspace", async () => {
      const fixture = await createFixture("scheduled");
      await db
        .update(schema.vaProfiles)
        .set({ status: "inactive" })
        .where(
          and(
            eq(schema.vaProfiles.userId, fixture.workerId),
            eq(schema.vaProfiles.founderId, fixture.ownerId),
          ),
        );

      await expectDueReminderHeldForWorkerScope(fixture);
    });

    it("holds a due reminder when the assigned worker has ambiguous active profiles in its workspace", async () => {
      const fixture = await createFixture("scheduled");
      const [profile] = await db
        .insert(schema.vaProfiles)
        .values({
          userId: fixture.workerId,
          founderId: fixture.ownerId,
          name: "Duplicate reminder integration worker profile",
          status: "active",
        })
        .returning();
      owned.profileIds.push(profile.id);

      await expectDueReminderHeldForWorkerScope(fixture);
    });

    it.each([
      { terminalStatus: "completed", oppositeStatus: "cancelled" },
      { terminalStatus: "cancelled", oppositeStatus: "completed" },
    ] as const)(
      "rejects changing an already-$terminalStatus commitment and keeps same-status closure idempotent",
      async ({ terminalStatus, oppositeStatus }) => {
        const fixture = await createFixture("scheduled");
        const actor = workerActor(fixture);
        controls.sendEmailWithOutcome.mockClear();

        const readClosureSnapshot = async () => {
          const [commitment] = await db
            .select({
              status: schema.commitments.status,
              completedAt: schema.commitments.completedAt,
              cancelledAt: schema.commitments.cancelledAt,
              updatedAt: schema.commitments.updatedAt,
            })
            .from(schema.commitments)
            .where(eq(schema.commitments.id, fixture.commitmentId));
          return commitment;
        };
        const readClosureAuditEvents = () =>
          db
            .select({ id: schema.reminderAuditEvents.id })
            .from(schema.reminderAuditEvents)
            .where(
              and(
                eq(schema.reminderAuditEvents.commitmentId, fixture.commitmentId),
                eq(
                  schema.reminderAuditEvents.eventType,
                  `commitment_${terminalStatus}`,
                ),
              ),
            );

        await reminders.closeCommitment(
          actor,
          fixture.commitmentId,
          terminalStatus,
        );
        const terminalSnapshot = await readClosureSnapshot();
        expect(terminalSnapshot.status).toBe(terminalStatus);
        if (terminalStatus === "completed") {
          expect(terminalSnapshot.completedAt).toEqual(expect.any(Date));
          expect(terminalSnapshot.cancelledAt).toBeNull();
        } else {
          expect(terminalSnapshot.completedAt).toBeNull();
          expect(terminalSnapshot.cancelledAt).toEqual(expect.any(Date));
        }
        expect(await readClosureAuditEvents()).toHaveLength(1);

        await expect(
          reminders.closeCommitment(
            actor,
            fixture.commitmentId,
            oppositeStatus,
          ),
        ).rejects.toThrow(/already .* cannot be changed/i);
        expect(await readClosureSnapshot()).toEqual(terminalSnapshot);
        expect(await readClosureAuditEvents()).toHaveLength(1);

        await expect(
          reminders.closeCommitment(
            actor,
            fixture.commitmentId,
            terminalStatus,
          ),
        ).resolves.toEqual({ success: true });
        expect(await readClosureSnapshot()).toEqual(terminalSnapshot);
        expect(await readClosureAuditEvents()).toHaveLength(1);
        expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
      },
    );

    it("keeps a closed reminder cancelled across worker, recovery, approval, and retry paths", async () => {
      controls.sendEmailWithOutcome.mockClear();
      const fixture = await createFixture(
        "scheduled",
        new Date(Date.now() - 60_000)
      );
      const actor = workerActor(fixture);

      await reminders.closeCommitment(actor, fixture.commitmentId, "cancelled");
      const [closedSchedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      expect(closedSchedule.state).toBe("cancelled");

      const now = new Date();
      const recoveryNow = new Date(now.getTime() + 60 * 60_000);
      await assertNoUnownedWorkForGlobalWorker(now, recoveryNow);
      const processed = await reminders.processDueReminders(now);
      const recovered =
        await reminders.recoverInterruptedReminders(recoveryNow);
      expect(processed.claimed).toBe(0);
      expect(recovered).toBe(0);

      await expect(
        reminders.approveAndSendReminder(actor, fixture.scheduleId)
      ).rejects.toThrow();
      await expect(
        reminders.confirmReminderRetry(
          actor,
          fixture.scheduleId,
          "Verified no delivery occurred before cancellation."
        )
      ).rejects.toThrow();

      const [commitment] = await db
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, fixture.commitmentId));
      const [schedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      const notifications = await db
        .select({ id: schema.notificationHistory.id })
        .from(schema.notificationHistory)
        .where(
          and(
            eq(schema.notificationHistory.userId, fixture.workerId),
            eq(schema.notificationHistory.taskId, fixture.sourceId)
          )
        );

      expect(commitment.status).toBe("cancelled");
      expect(schedule.state).toBe("cancelled");
      expect(notifications).toHaveLength(0);
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });

    it.each(["completed", "cancelled"] as const)(
      "cancels a stale in-flight reminder after its commitment is %s",
      async terminalStatus => {
        controls.sendEmailWithOutcome.mockClear();
        const fixture = await createFixture("scheduled");
        const actor = workerActor(fixture);
        const recoveryNow = new Date();
        const staleAttempt = new Date(recoveryNow.getTime() - 16 * 60_000);

        await db.update(schema.reminderSchedules)
          .set({ state: "sending", lastAttemptAt: staleAttempt })
          .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
        await reminders.closeCommitment(actor, fixture.commitmentId, terminalStatus);

        const recovered = await reminders.recoverInterruptedReminders(recoveryNow);
        const [schedule] = await db.select()
          .from(schema.reminderSchedules)
          .where(eq(schema.reminderSchedules.id, fixture.scheduleId));

        expect(recovered).toBe(1);
        expect(schedule.state).toBe("cancelled");
        expect(schedule.policyReason).toContain("Commitment was closed");
        expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
      }
    );

    it("moves an open source reminder to the newly assigned worker's dashboard in one transaction", async () => {
      const fixture = await createFixture("scheduled", new Date(Date.now() + 60 * 60_000));
      const nextWorker = await createWorker(fixture.ownerId);
      const input = {
        workspaceOwnerId: fixture.ownerId,
        assignedUserId: fixture.workerId,
        sourceType: "trello" as const,
        sourceId: `reassignment-${randomUUID()}`,
        title: "Reassigned source task",
        dueAt: new Date(Date.now() + 3 * 60 * 60_000),
        reminderOffsetMinutes: 60,
      };

      const created = await upsertSourceCommitment(input);
      owned.commitmentIds.push(created.commitmentId);
      const [originalSchedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, created.scheduleId!));
      owned.ruleIds.push(originalSchedule.ruleId);

      const reassigned = await upsertSourceCommitment({
        ...input,
        assignedUserId: nextWorker.id,
      });
      const [currentCommitment] = await db
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, created.commitmentId));
      const [currentSchedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, created.scheduleId!));

      expect(reassigned).toMatchObject({
        commitmentId: created.commitmentId,
        scheduleId: created.scheduleId,
        state: "updated",
      });
      expect(currentCommitment.assignedUserId).toBe(nextWorker.id);
      expect(currentSchedule.recipientUserId).toBe(nextWorker.id);
      expect(currentSchedule.state).toBe("scheduled");
      expect(currentSchedule.id).toBe(originalSchedule.id);

      const previousDashboard = await reminders.getReminderDashboard(workerActor(fixture));
      const nextDashboard = await reminders.getReminderDashboard({
        id: nextWorker.id,
        openId: nextWorker.openId,
        role: "worker",
        email: nextWorker.email,
      });
      expect(previousDashboard.rows.some(({ schedule }) => schedule.id === currentSchedule.id)).toBe(false);
      expect(nextDashboard.rows.some(({ schedule }) => schedule.id === currentSchedule.id)).toBe(true);
    });

    it("creates one reminder for a new assignee when the previous worker already received it", async () => {
      const fixture = await createFixture("scheduled", new Date(Date.now() + 60 * 60_000));
      const nextWorker = await createWorker(fixture.ownerId);
      const input = {
        workspaceOwnerId: fixture.ownerId,
        assignedUserId: fixture.workerId,
        sourceType: "trello" as const,
        sourceId: `sent-reassignment-${randomUUID()}`,
        title: "Open source task already reminded",
        context: "Keep the delivered occurrence as history.",
        dueAt: new Date(Date.now() + 3 * 60 * 60_000),
        reminderOffsetMinutes: 60,
      };

      const original = await upsertSourceCommitment(input);
      owned.commitmentIds.push(original.commitmentId);
      const [originalSchedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, original.scheduleId!));
      owned.ruleIds.push(originalSchedule.ruleId);
      await db.update(schema.reminderSchedules)
        .set({ state: "sent", sentAt: new Date() })
        .where(eq(schema.reminderSchedules.id, original.scheduleId!));

      const reassigned = await upsertSourceCommitment({
        ...input,
        assignedUserId: nextWorker.id,
      });
      const repeatedSync = await upsertSourceCommitment({
        ...input,
        assignedUserId: nextWorker.id,
      });
      const sourceSchedules = await db.select().from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.commitmentId, original.commitmentId));
      owned.ruleIds.push(...sourceSchedules.map(schedule => schedule.ruleId));

      expect(sourceSchedules).toHaveLength(2);
      expect(sourceSchedules.find(schedule => schedule.id === original.scheduleId)).toMatchObject({
        state: "sent",
        recipientUserId: fixture.workerId,
      });
      expect(reassigned).toMatchObject({ state: "created", commitmentId: original.commitmentId });
      expect(reassigned.scheduleId).not.toBe(original.scheduleId);
      expect(sourceSchedules.find(schedule => schedule.id === reassigned.scheduleId)).toMatchObject({
        state: "scheduled",
        recipientUserId: nextWorker.id,
      });
      expect(repeatedSync.scheduleId).toBe(reassigned.scheduleId);
    });

    it("blocks an approved email when its schedule recipient no longer matches the assignee", async () => {
      controls.sendEmailWithOutcome.mockClear();
      const fixture = await createFixture("draft_ready");
      const nextWorker = await createWorker(fixture.ownerId);
      await db
        .update(schema.reminderPolicies)
        .set({ emailEnabled: true })
        .where(eq(schema.reminderPolicies.userId, fixture.workerId));
      await db
        .update(schema.reminderSchedules)
        .set({ channel: "email" })
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      await db
        .update(schema.commitments)
        .set({ assignedUserId: nextWorker.id })
        .where(eq(schema.commitments.id, fixture.commitmentId));

      await expect(
        reminders.approveAndSendReminder(
          {
            id: fixture.ownerId,
            openId: `reminder-it-owner-${randomUUID()}`,
            role: "admin",
            email: null,
          },
          fixture.scheduleId
        )
      ).rejects.toThrow(/assignment changed/i);

      const [schedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      const notifications = await db
        .select({ id: schema.notificationHistory.id })
        .from(schema.notificationHistory)
        .where(eq(schema.notificationHistory.taskId, fixture.sourceId));

      expect(schedule.recipientUserId).toBe(nextWorker.id);
      expect(schedule.state).toBe("scheduled");
      expect(schedule.draftTitle).toBeNull();
      expect(schedule.draftContent).toBeNull();
      expect(schedule.approvedAt).toBeNull();
      expect(notifications).toHaveLength(0);
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });

    it("rechecks the assignee after approval and immediately before email delivery", async () => {
      controls.sendEmailWithOutcome.mockClear();
      const fixture = await createFixture("scheduled");
      const prepared = await processDueRemindersInWorkspace(
        new Date(),
        1,
        fixture.ownerId,
      );
      expect(prepared).toMatchObject({ claimed: 1, drafted: 1 });
      const nextWorker = await createWorker(fixture.ownerId);
      await db
        .update(schema.reminderPolicies)
        .set({ emailEnabled: true })
        .where(eq(schema.reminderPolicies.userId, fixture.workerId));
      await db
        .update(schema.reminderSchedules)
        .set({ channel: "email" })
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));

      let reassignedAfterApproval = false;
      const reassignBetweenClaimAndDelivery = new Proxy(db, {
        get(target, property) {
          if (property === "transaction") {
            return async (callback: any, ...args: any[]) => {
              const result = await Reflect.apply(target.transaction, target, [callback, ...args]);
              if (!reassignedAfterApproval) {
                const [claimed] = await db
                  .select({ state: schema.reminderSchedules.state })
                  .from(schema.reminderSchedules)
                  .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
                if (claimed?.state === "sending") {
                  await db
                    .update(schema.commitments)
                    .set({ assignedUserId: nextWorker.id })
                    .where(eq(schema.commitments.id, fixture.commitmentId));
                  reassignedAfterApproval = true;
                }
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      controls.db = reassignBetweenClaimAndDelivery;

      try {
        await expect(
          reminders.approveAndSendReminder(
            {
              id: fixture.ownerId,
              openId: `reminder-it-owner-${randomUUID()}`,
              role: "admin",
              email: null,
            },
            fixture.scheduleId
          )
        ).rejects.toThrow(/assignment changed/i);
      } finally {
        controls.db = db;
      }

      const [schedule] = await db
        .select()
        .from(schema.reminderSchedules)
        .where(eq(schema.reminderSchedules.id, fixture.scheduleId));
      const notifications = await db
        .select({ id: schema.notificationHistory.id })
        .from(schema.notificationHistory)
        .where(eq(schema.notificationHistory.taskId, fixture.sourceId));

      expect(reassignedAfterApproval).toBe(true);
      expect(schedule.recipientUserId).toBe(nextWorker.id);
      expect(schedule.state).toBe("scheduled");
      expect(schedule.draftTitle).toBeNull();
      expect(schedule.draftContent).toBeNull();
      expect(schedule.approvedAt).toBeNull();
      expect(notifications).toHaveLength(0);
      expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    });
  }
);
