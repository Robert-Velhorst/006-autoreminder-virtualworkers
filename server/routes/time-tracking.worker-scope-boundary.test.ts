import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aptlssManagerChecks, aptlssManagerRuns, aptlssManagerState, aptlssPlans, atisCards, cardStates, taskAssignments, timeEntries, trelloCachedCards, users, vaProfiles } from "../../drizzle/schema";
import { managerHistoryHash } from "../aptlssManagerHistory";
import { WORKER_EXECUTION_HOLD_MESSAGE } from "../../shared/aptlssManager";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isManagerPilotWorker: vi.fn(),
  readManagerAssignmentState: vi.fn(),
  getGoogleEvidenceStatus: vi.fn(),
  enqueueManagerTask: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../aptlssManagerAssignments", () => ({ readManagerAssignmentState: mocks.readManagerAssignmentState }));
vi.mock("../googleEvidence", () => ({ getGoogleEvidenceStatus: mocks.getGoogleEvidenceStatus }));
vi.mock("../aptlssManagerQueue", () => ({ enqueueManagerTask: mocks.enqueueManagerTask }));

import timeTrackingRoutes from "./time-tracking";

type Profile = { id: number; userId: number; founderId: number; trelloMemberId: string | null; status: string };
type Assignment = { id: number; taskId: string; vaId: number; founderId: number; status: string };
type Entry = {
  id: number;
  taskId: string;
  vaId: number;
  founderId: number;
  startTime: Date;
  endTime: Date | null;
  durationMinutes: number | null;
  notes: string | null;
  isVoided?: boolean;
};

type Fixture = {
  user?: { id: number; openId: string; role: "worker" | "user" | "admin" };
  profiles?: Profile[];
  profileCollisions?: Profile[];
  ownAssignment?: Assignment;
  exactOtherAssignment?: Assignment;
  parentAssignment?: Assignment;
  cardMember?: boolean;
  hasPlan?: boolean;
  activeEntries?: Entry[];
  entries?: Entry[];
  isPilot?: boolean;
  snapshot?: Record<string, unknown>;
  history?: ReturnType<typeof retainedHistory>;
  missingHistory?: boolean;
  gmailStatus?: { enabled: boolean; lastSyncedAt: string | null; intervalMinutes: number; lastError?: string | null; sourceConflictPending?: boolean } | null;
  googleConnectionReady?: boolean | null;
};

const worker = { id: 42, openId: "worker-42", role: "worker" as const };
const profile: Profile = { id: 7, userId: worker.id, founderId: 8, trelloMemberId: "member-7", status: "active" };
const cardId = "card-1";
const childTaskId = `${cardId}:checklist-1:item-1`;

function managerSnapshot(sourceEvidence = false) {
  const now = Date.now();
  return {
    executionCoverageComplete: true,
    assignmentFingerprint: "assignment-fingerprint",
    assessedAt: new Date(now - 30_000).toISOString(),
    nextCheckAt: new Date(now + 5 * 60_000).toISOString(),
    policy: { enabled: true, intervalMinutes: 10 },
    interventions: [],
    actions: [{ cardId, blocked: false, evidenceIds: sourceEvidence ? ["gmail-evidence"] : [] }],
    evidence: sourceEvidence ? [{
      id: "gmail-evidence",
      cardId,
      source: "gmail",
      kind: "source",
      metadata: { authority: "official", truthClass: "confirmed" },
    }] : [],
  };
}

function retainedHistory(current: Record<string, unknown> = managerSnapshot()) {
  const snapshot = { ...current, runId: 1, trigger: "timer_changed", changes: [], proposal: undefined };
  const base = {
    ...snapshot,
    assessedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    nextCheckAt: new Date(Date.now() - 50 * 60_000).toISOString(),
  };
  return {
    state: { vaId: worker.id, currentCheckId: 2, inputHash: "input", sourceHash: "sources", enabled: true, intervalMinutes: 10, mode: "shadow" },
    run: { id: 1, vaId: worker.id, snapshotJson: JSON.stringify(base) },
    check: {
      id: 2, vaId: worker.id, runId: 1, inputHash: "input", sourceHash: "sources",
      baseSnapshotHash: managerHistoryHash(base), snapshotHash: managerHistoryHash(snapshot),
      snapshotPatchJson: JSON.stringify({ version: 1, values: {
        assessedAt: snapshot.assessedAt, nextCheckAt: snapshot.nextCheckAt,
        trigger: snapshot.trigger, changes: snapshot.changes, proposal: null,
      } }),
    },
  };
}

function makeDb(fixture: Fixture = {}) {
  const user = fixture.user ?? worker;
  const profiles = fixture.profiles ?? [profile];
  const profileCollisions = fixture.profileCollisions ?? profiles;
  const entries = fixture.entries ?? fixture.activeEntries ?? [];
  const insertedValues: Record<string, unknown>[] = [];
  const updates: Array<{ id: number; values: Record<string, unknown> }> = [];
  let nextEntryId = 100;

  function createTransaction() {
    const reads = new Map<unknown, number>();
    const tx: any = {
      select: vi.fn(() => {
        let table: unknown;
        let rows: unknown[] = [];
        const query: any = {
          from: vi.fn((value: unknown) => {
            table = value;
            const count = (reads.get(value) ?? 0) + 1;
            reads.set(value, count);
            if (table === users) rows = [{ id: user.id }];
            else if (table === vaProfiles) rows = count >= 2 ? profileCollisions : profiles;
            else if (table === taskAssignments) {
              if (count === 1) rows = fixture.ownAssignment ? [fixture.ownAssignment] : [];
              else if (count === 2) rows = fixture.ownAssignment
                ? [fixture.ownAssignment]
                : fixture.exactOtherAssignment ? [fixture.exactOtherAssignment] : [];
              else if (fixture.exactOtherAssignment) rows = [fixture.exactOtherAssignment];
              else rows = fixture.parentAssignment ? [fixture.parentAssignment] : [];
            } else if (table === aptlssPlans) rows = fixture.hasPlan ? [{ listName: "DOING" }] : [];
            else if (table === atisCards) rows = fixture.cardMember
              ? [{ listName: "DOING", memberIds: JSON.stringify([profile.trelloMemberId]), isArchived: false }]
              : [];
            else if (table === cardStates) rows = [{ state: "DOING" }];
            else if (table === aptlssManagerState) rows = fixture.history ? [fixture.history.state] : [];
            else if (table === aptlssManagerChecks) rows = fixture.history ? [fixture.history.check] : [];
            else if (table === aptlssManagerRuns) rows = fixture.missingHistory ? [] : fixture.history ? [fixture.history.run] : [{
              id: 1, vaId: worker.id,
              snapshotJson: JSON.stringify(fixture.snapshot ?? managerSnapshot()),
            }];
            else if (table === trelloCachedCards) rows = [];
            else if (table === timeEntries) rows = count === 1
              ? entries.filter(entry => entry.endTime === null)
              : entries;
            else rows = [];
            return query;
          }),
          where: vi.fn(() => query),
          orderBy: vi.fn(() => query),
          limit: vi.fn(() => query),
          for: vi.fn(() => query),
          then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return query;
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          insertedValues.push(values);
          const inserted: Entry = {
            id: nextEntryId++,
            taskId: String(values.taskId),
            vaId: Number(values.vaId),
            founderId: Number(values.founderId),
            startTime: values.startTime as Date,
            endTime: null,
            durationMinutes: null,
            notes: typeof values.notes === "string" ? values.notes : null,
          };
          entries.push(inserted);
          return [{ insertId: inserted.id }];
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            const active = entries.find(entry => entry.endTime === null);
            if (active) {
              Object.assign(active, values);
              updates.push({ id: active.id, values });
            }
            return [];
          }),
        })),
      })),
    };
    return tx;
  }

  const db = {
    transaction: vi.fn(async <T>(callback: (tx: any) => Promise<T>) => callback(createTransaction())),
  };
  return { db, entries, insertedValues, updates };
}

function createApp(db: ReturnType<typeof makeDb>["db"], user: Fixture["user"] | null = worker) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as typeof req & { user: typeof user }).user = user;
    next();
  });
  app.use(timeTrackingRoutes);
  mocks.getDb.mockResolvedValue(db);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isManagerPilotWorker.mockImplementation((userId: number) => userId === worker.id);
  mocks.readManagerAssignmentState.mockResolvedValue({ complete: true, fingerprint: "assignment-fingerprint" });
  mocks.getGoogleEvidenceStatus.mockResolvedValue({
    credentialsReady: false,
    gmail: { enabled: false, lastSyncedAt: null, intervalMinutes: 15 },
    drive: null,
  });
});

describe("legacy timer worker-scope boundary", () => {
  it("rejects an unsigned caller before reading worker or timer data", async () => {
    const { db } = makeDb();
    const response = await request(createApp(db, null)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(401);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("denies timer access when the worker has multiple active profiles", async () => {
    const { db } = makeDb({ profiles: [profile, { ...profile, id: 9 }] });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/profile is ambiguous/i);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not let a pilot worker use card membership to start a child task owned by another worker at card level", async () => {
    const { db, insertedValues } = makeDb({
      isPilot: true,
      parentAssignment: { id: 31, taskId: cardId, vaId: 99, founderId: profile.founderId, status: "assigned" },
      cardMember: true,
    });
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: childTaskId });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/assigned to a different worker/i);
    expect(insertedValues).toHaveLength(0);
  });

  it("blocks a pilot timer when the cited source is not current", async () => {
    const { db, insertedValues } = makeDb({
      snapshot: managerSnapshot(true),
      cardMember: true,
    });
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/source required by the next step is out of date/i);
    expect(insertedValues).toHaveLength(0);
    expect(mocks.getGoogleEvidenceStatus).toHaveBeenCalledWith(worker.id);
  });

  it("blocks a pilot timer when the manager assessment has expired", async () => {
    const snapshot = managerSnapshot();
    snapshot.assessedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const { db, insertedValues } = makeDb({ snapshot, cardMember: true });
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/full work list has not been checked/i);
    expect(insertedValues).toHaveLength(0);
  });

  it("accepts a fresh compact check even when its retained full run is expired", async () => {
    const { db, insertedValues } = makeDb({ history: retainedHistory(), cardMember: true });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(200);
    expect(insertedValues).toEqual([expect.objectContaining({ taskId: cardId, vaId: worker.id, founderId: profile.founderId })]);
    expect(mocks.enqueueManagerTask).toHaveBeenCalledTimes(1);
  });

  it.each(["base hash", "snapshot hash", "patch", "state hash"])("holds execution when the compact check has an invalid %s", async invalid => {
    const history = retainedHistory();
    if (invalid === "base hash") history.check.baseSnapshotHash = "invalid";
    if (invalid === "snapshot hash") history.check.snapshotHash = "invalid";
    if (invalid === "patch") history.check.snapshotPatchJson = "{}";
    if (invalid === "state hash") history.state.sourceHash = "different";
    const { db, insertedValues } = makeDb({ history, cardMember: true });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: WORKER_EXECUTION_HOLD_MESSAGE });
    expect(insertedValues).toHaveLength(0);
    expect(mocks.enqueueManagerTask).not.toHaveBeenCalled();
  });

  it("holds execution when manager history is missing", async () => {
    const { db, insertedValues } = makeDb({ missingHistory: true, cardMember: true });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: WORKER_EXECUTION_HOLD_MESSAGE });
    expect(insertedValues).toHaveLength(0);
  });

  it.each(["expired", "disabled policy", "changed assignments"])("holds a valid compact check with %s", async invalid => {
    const snapshot = managerSnapshot();
    if (invalid === "expired") snapshot.assessedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const history = retainedHistory(snapshot);
    if (invalid === "disabled policy") history.state.enabled = false;
    if (invalid === "changed assignments") mocks.readManagerAssignmentState.mockResolvedValue({ complete: true, fingerprint: "changed" });
    const { db, insertedValues } = makeDb({ history, cardMember: true });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: WORKER_EXECUTION_HOLD_MESSAGE });
    expect(insertedValues).toHaveLength(0);
  });

  it("still blocks a fresh compact check whose cited source is not current", async () => {
    const { db, insertedValues } = makeDb({ history: retainedHistory(managerSnapshot(true)), cardMember: true });

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/source required by the next step is out of date/i);
    expect(insertedValues).toHaveLength(0);
    expect(mocks.getGoogleEvidenceStatus).toHaveBeenCalledWith(worker.id);
  });

  it.each([
    { status: "blocked", expected: /task is blocked/i },
    { status: "completed", expected: /task is already complete/i },
  ])("does not start a child timer under a card assigned to this worker but marked $status", async ({ status, expected }) => {
    const { db, insertedValues } = makeDb({
      parentAssignment: { id: 32, taskId: cardId, vaId: profile.id, founderId: profile.founderId, status },
      cardMember: true,
    });
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: childTaskId });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(expected);
    expect(insertedValues).toHaveLength(0);
  });

  it.each(["stop", "pause"] as const)("makes a repeated %s a no-op instead of returning an error", async transition => {
    const active: Entry = {
      id: 55,
      taskId: cardId,
      vaId: profile.id,
      founderId: profile.founderId,
      startTime: new Date(Date.now() - 15 * 60_000),
      endTime: null,
      durationMinutes: null,
      notes: "Review source",
    };
    const { db, updates } = makeDb({ activeEntries: [active] });
    const app = createApp(db);

    const firstResponse = await request(app).post(`/time-tracking/${transition}`).send();
    expect(firstResponse.status).toBe(200);
    expect(updates).toHaveLength(1);
    const endTime = active.endTime;
    const durationMinutes = active.durationMinutes;
    const notes = active.notes;

    const response = await request(app).post(`/time-tracking/${transition}`).send();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.alreadyStopped ?? response.body.alreadyPaused).toBe(true);
    expect(updates).toHaveLength(1);
    expect(active.endTime).toEqual(endTime);
    expect(active.durationMinutes).toBe(durationMinutes);
    expect(active.notes).toBe(notes);
  });

  it("does not replace an existing active timer when another task is started", async () => {
    const active: Entry = {
      id: 54,
      taskId: "existing-task",
      vaId: profile.id,
      founderId: profile.founderId,
      startTime: new Date(Date.now() - 60_000),
      endTime: null,
      durationMinutes: null,
      notes: null,
    };
    const { db, insertedValues } = makeDb({
      isPilot: false,
      ownAssignment: { id: 20, taskId: cardId, vaId: profile.id, founderId: profile.founderId, status: "assigned" },
      activeEntries: [active],
    });
    mocks.isManagerPilotWorker.mockReturnValue(false);

    const response = await request(createApp(db)).post("/time-tracking/start").send({ taskId: cardId });

    expect(response.status).toBe(400);
    expect(response.body.activeTaskId).toBe("existing-task");
    expect(insertedValues).toHaveLength(0);
  });

  it.each(["user", "admin"] as const)("does not let a %s account stop a worker-owned timer", async role => {
    const foreignActive: Entry = {
      id: 56,
      taskId: cardId,
      vaId: profile.id,
      founderId: profile.founderId,
      startTime: new Date(Date.now() - 60_000),
      endTime: null,
      durationMinutes: null,
      notes: null,
    };
    const nonWorker = { id: 99, openId: `${role}-99`, role };
    const { db, updates } = makeDb({ user: nonWorker, profiles: [], entries: [foreignActive] });

    const response = await request(createApp(db, nonWorker)).post("/time-tracking/stop").send();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "No active timer found" });
    expect(updates).toHaveLength(0);
    expect(foreignActive.endTime).toBeNull();
  });
});
