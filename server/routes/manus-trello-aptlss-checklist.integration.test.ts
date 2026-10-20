import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";
import * as schema from "../../drizzle/schema.postgres";
import type { TrpcContext } from "../_core/context";

const controls = vi.hoisted(() => ({
  url: process.env.APTLSS_TEST_DATABASE_URL,
  db: undefined as NodePgDatabase<typeof schema> | undefined,
}));

vi.mock("../db", () => ({
  getDb: async () => controls.db,
  incrementPayLogD1: vi.fn(),
}));

import { aptlssRouter } from "./manus-trello-aptlss";

type Fixture = {
  worker: schema.User;
  workerId: number;
  otherWorkerId?: number;
  founderId: number;
  profileId: number;
  cardId: string;
  checkItemId: string;
  targetStepId: number;
};

describe.skipIf(!controls.url && process.env.CI !== "true")("worker checklist route PostgreSQL safeguards", { timeout: 30_000, hookTimeout: 30_000 }, () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let fixture: Fixture | undefined;

  beforeAll(async () => {
    const connectionString = requireIsolatedPostgresTestDatabase(controls.url, process.env.NODE_ENV === "production");
    const url = new URL(connectionString);
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
    db = drizzle(pool, { schema });
    controls.db = db;
    const { rows: [identity] } = await pool.query("SELECT current_database() AS name, version() AS version");
    expect(identity.name).toBe(url.pathname.slice(1));
    expect(identity.version).toMatch(/^PostgreSQL 18\./);
  });

  beforeEach(() => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (!fixture) return;
    await db.delete(schema.decisionOutcomes).where(eq(schema.decisionOutcomes.vaId, fixture.workerId));
    await db.delete(schema.aptlssWaitingReasons).where(and(
      eq(schema.aptlssWaitingReasons.vaId, fixture.workerId),
      eq(schema.aptlssWaitingReasons.cardId, fixture.cardId),
    ));
    await db.delete(schema.taskAssignments).where(eq(schema.taskAssignments.founderId, fixture.founderId));
    await db.delete(schema.cardStates).where(and(
      eq(schema.cardStates.vaId, fixture.workerId),
      eq(schema.cardStates.cardId, fixture.cardId),
    ));
    await db.delete(schema.aptlssSteps).where(and(
      eq(schema.aptlssSteps.vaId, fixture.workerId),
      eq(schema.aptlssSteps.cardId, fixture.cardId),
    ));
    await db.delete(schema.aptlssPlans).where(and(
      eq(schema.aptlssPlans.vaId, fixture.workerId),
      eq(schema.aptlssPlans.cardId, fixture.cardId),
    ));
    await db.delete(schema.vaProfiles).where(eq(schema.vaProfiles.founderId, fixture.founderId));
    await db.delete(schema.users).where(eq(schema.users.id, fixture.workerId));
    if (fixture.otherWorkerId) await db.delete(schema.users).where(eq(schema.users.id, fixture.otherWorkerId));
    await db.delete(schema.users).where(eq(schema.users.id, fixture.founderId));
    fixture = undefined;
  });

  afterAll(async () => {
    controls.db = undefined;
    await pool?.end();
  });

  async function createFixture(options: {
    assignmentStatus?: "assigned" | "in_progress" | "blocked" | "completed";
    blockedBy?: string | null;
    requiresFounder?: boolean;
    sourceHold?: boolean;
    targetStatus?: "open" | "complete";
  } = {}) {
    const suffix = randomUUID().replaceAll("-", "");
    const cardId = `audit-${suffix}`;
    const checklistId = `list-${suffix}`;
    const checkItemId = `item-${suffix}`;
    const workerOpenId = `audit-worker-${suffix}`;
    const [founder] = await db.insert(schema.users).values({
      openId: `audit-founder-${suffix}`,
      name: "Checklist audit founder",
      role: "admin",
    }).returning({ id: schema.users.id });
    const [worker] = await db.insert(schema.users).values({
      openId: workerOpenId,
      name: "Checklist audit worker",
      role: "worker",
    }).returning({ id: schema.users.id });
    const [profile] = await db.insert(schema.vaProfiles).values({
      userId: worker.id,
      founderId: founder.id,
      name: "Checklist audit worker",
      status: "active",
    }).returning({ id: schema.vaProfiles.id });
    await db.insert(schema.aptlssPlans).values({
      vaId: worker.id,
      cardId,
      cardName: "Checklist authorization audit",
      cardUrl: `https://trello.com/c/${cardId}`,
      boardName: "Isolated integration fixture",
      listName: "TO DO",
      planJson: "{}",
    });
    await db.insert(schema.aptlssSteps).values([
      {
        vaId: worker.id,
        cardId,
        stepNumber: 1,
        title: "Open prerequisite",
        status: "open",
      },
      {
        vaId: worker.id,
        cardId,
        trelloChecklistId: checklistId,
        trelloCheckItemId: checkItemId,
        stepNumber: 2,
        title: "Checklist item under test",
        status: options.targetStatus ?? "open",
        blockedBy: options.blockedBy ?? null,
        requiresRobert: options.requiresFounder ?? false,
      },
    ]);
    const [target] = await db.select({ id: schema.aptlssSteps.id })
      .from(schema.aptlssSteps)
      .where(and(eq(schema.aptlssSteps.vaId, worker.id), eq(schema.aptlssSteps.trelloCheckItemId, checkItemId)))
      .limit(1);
    await db.insert(schema.taskAssignments).values({
      taskId: `${cardId}:${checklistId}:${checkItemId}`,
      vaId: profile.id,
      founderId: founder.id,
      assignedBy: founder.id,
      status: options.assignmentStatus ?? "assigned",
    });
    if (options.sourceHold) {
      await db.insert(schema.aptlssWaitingReasons).values({
        vaId: worker.id,
        cardId,
        rawReason: "The current source must be checked first.",
        category: "source_conflict",
        waitingOn: "external",
        nextAction: "Verify the current source before continuing.",
        nextStepType: "verify",
        followUpSource: "worker",
        urgency: "high",
        confidenceScore: 0,
        confidenceReason: "Unverified source hold fixture.",
        interpretationJson: "{}",
        interpreterVersion: "integration-test",
        source: "worker",
        status: "active",
        recordedBy: workerOpenId,
      });
    }

    fixture = {
      worker: (await db.select().from(schema.users).where(eq(schema.users.id, worker.id)).limit(1))[0],
      workerId: worker.id,
      founderId: founder.id,
      profileId: profile.id,
      cardId,
      checkItemId,
      targetStepId: target.id,
    };
    return fixture;
  }

  function workerCaller(worker: schema.User) {
    return aptlssRouter.createCaller({
      user: worker,
      req: {} as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    } as TrpcContext);
  }

  async function savedTarget() {
    return (await db.select().from(schema.aptlssSteps)
      .where(eq(schema.aptlssSteps.id, fixture!.targetStepId)).limit(1))[0];
  }

  it("rejects completion after the worker's assignment has ended", async () => {
    const current = await createFixture({ assignmentStatus: "completed" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "complete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe("open");
  });

  it("rejects reopening after the worker's assignment has ended", async () => {
    const current = await createFixture({ assignmentStatus: "completed", targetStatus: "complete" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "incomplete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe("complete");
  });

  it.each(["complete", "incomplete"] as const)("does not let a former card assignee %s a step reassigned to another worker", async state => {
    const current = await createFixture({ targetStatus: state === "incomplete" ? "complete" : "open" });
    const suffix = randomUUID().replaceAll("-", "");
    const [otherWorker] = await db.insert(schema.users).values({
      openId: `audit-other-worker-${suffix}`,
      name: "Second checklist audit worker",
      role: "worker",
    }).returning({ id: schema.users.id });
    current.otherWorkerId = otherWorker.id;
    const [otherProfile] = await db.insert(schema.vaProfiles).values({
      userId: otherWorker.id,
      founderId: current.founderId,
      name: "Second checklist audit worker",
      status: "active",
    }).returning({ id: schema.vaProfiles.id });
    const exactTaskId = `${current.cardId}:list-${current.checkItemId.slice("item-".length)}:${current.checkItemId}`;
    await db.update(schema.taskAssignments).set({ vaId: otherProfile.id })
      .where(eq(schema.taskAssignments.taskId, exactTaskId));
    await db.insert(schema.taskAssignments).values({
      taskId: current.cardId,
      vaId: current.profileId,
      founderId: current.founderId,
      assignedBy: current.founderId,
      status: "assigned",
    });

    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe(state === "complete" ? "open" : "complete");
  });

  it("does not complete work while its prerequisite is unresolved", async () => {
    const current = await createFixture({ blockedBy: "Step 1" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "complete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe("open");
  });

  it("fails closed when a referenced prerequisite cannot be resolved", async () => {
    const current = await createFixture({ blockedBy: "Step 9" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "complete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe("open");
  });

  it("does not complete work while the card has an active source hold", async () => {
    const current = await createFixture({ sourceHold: true });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "complete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe("open");
  });

  it("keeps reopening available to the assigned worker while a source hold is active", async () => {
    const current = await createFixture({ sourceHold: true, targetStatus: "complete" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "incomplete" }))
      .resolves.toMatchObject({ success: true });
    expect((await savedTarget()).status).toBe("open");
  });

  it.each(["complete", "incomplete"] as const)("does not let a worker change a Founder-only step (%s)", async state => {
    const current = await createFixture({ requiresFounder: true, targetStatus: state === "incomplete" ? "complete" : "open" });
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe(state === "complete" ? "open" : "complete");
  });

  it.each(["complete", "incomplete"] as const)("does not let a worker change a step with a recorded Founder decision (%s)", async state => {
    const current = await createFixture({ targetStatus: state === "incomplete" ? "complete" : "open" });
    await db.insert(schema.decisionOutcomes).values({
      vaId: current.workerId,
      stepId: current.targetStepId,
      cardId: current.cardId,
      decisionPrompt: "Founder decision required before continuing.",
      outcome: "Keep this step under Founder control.",
      resolvedBy: String(current.founderId),
    });

    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await savedTarget()).status).toBe(state === "complete" ? "open" : "complete");
  });

  it("allows completion when the step is assigned, prerequisites are complete, and no hold exists", async () => {
    const current = await createFixture();
    await db.update(schema.aptlssSteps).set({ status: "complete", completedAt: new Date() })
      .where(and(eq(schema.aptlssSteps.vaId, current.workerId), eq(schema.aptlssSteps.cardId, current.cardId), eq(schema.aptlssSteps.stepNumber, 1)));
    await expect(workerCaller(current.worker).syncCheckItem({ trelloCheckItemId: current.checkItemId, state: "complete" }))
      .resolves.toMatchObject({ success: true });
    expect((await savedTarget()).status).toBe("complete");
  });
});
