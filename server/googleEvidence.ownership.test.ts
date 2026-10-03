import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import {
  appSettings, aptlssEvidenceRevisions, aptlssPlans, emailTasks, users,
  workspaceEvidenceItems, workspaceEvidenceLinks,
} from "../drizzle/schema";
import {
  defaultGoogleEvidenceSettings, encryptGoogleRefreshToken, listDriveFiles,
  listGmailMessages, sendGoogleMail, syncWorkerGoogleEvidence,
} from "./googleEvidence";
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from "./scheduledJobRuntime";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(), enqueue: vi.fn(), commitment: vi.fn(), worker: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./aptlssManagerQueue", () => ({ enqueueManagerTask: mocks.enqueue }));
vi.mock("./sourceCommitments", () => ({ upsertSourceCommitment: mocks.commitment }));
vi.mock("./workerOperatorContext", () => ({ resolveWorkerOperatorContextById: mocks.worker }));

type Row = Record<string, unknown>;
type Hook = (operation: string, table?: unknown) => void;
const workerId = 712;
const receivedAt = new Date("2026-09-26T10:00:00Z");

function ownership() {
  const controller = new AbortController();
  let lost = false;
  const context: ScheduledJobContext = {
    signal: controller.signal,
    assertOwnership: vi.fn(async () => {
      if (lost) throw new ScheduledJobLeaseLostError();
    }),
  };
  return { controller, context, lose: () => { lost = true; } };
}

function contains(value: unknown, expected: string, seen = new Set<object>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => contains(child, expected, seen));
}

// Stage writes in the transaction callback; a rejected pre-commit check discards them.
function database(hook: Hook = () => {}) {
  const settings = new Map([
    [`googleEvidence:${workerId}`, JSON.stringify(defaultGoogleEvidenceSettings())],
    [`googleEvidenceRefreshToken:${workerId}`, encryptGoogleRefreshToken("test-worker-token")],
  ]);
  const originalSettings = new Map(settings);
  let durable = new Map<unknown, Row[]>();
  const transactions = { started: 0, committed: 0, rolledBack: 0 };
  const writes: unknown[] = [];
  const connection = (rows: Map<unknown, Row[]>, transactional = false) => ({
    select: () => ({ from: (table: unknown) => {
      let condition: unknown;
      const query = {
        where: (value: unknown) => { condition = value; return query; },
        limit: () => query,
        for: () => query,
        then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) => {
          let result: Row[];
          if (table === appSettings) {
            const key = [...settings.keys()].find((key) => contains(condition, key));
            result = key ? [{ value: settings.get(key) }] : [];
          } else if (table === users) result = [{ id: workerId }];
          else if (table === aptlssPlans) result = [{
            cardId: "card-1", cardName: "Evidence review task", cardUrl: "https://trello.com/c/card-1",
            boardName: "Work", listName: "To do",
          }];
          else result = rows.get(table) ?? [];
          hook(transactional ? "tx-read" : "read", table);
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    } }),
    insert: (table: unknown) => ({ values: (value: Row) => {
      const write = async () => {
        if (table === appSettings) settings.set(String(value.key), String(value.value));
        else rows.set(table, [{ id: 81, ...value }]);
        writes.push(table);
        hook("write", table);
      };
      return {
        onDuplicateKeyUpdate: write,
        then: (resolve: (value: void) => unknown, reject?: (error: unknown) => unknown) => write().then(resolve, reject),
      };
    } }),
    update: (table: unknown) => ({ set: (value: Row) => ({ where: async () => {
      rows.set(table, (rows.get(table) ?? []).map((row) => ({ ...row, ...value })));
      writes.push(table);
      hook("write", table);
    } }) }),
    delete: (table: unknown) => ({ where: async () => {
      rows.delete(table);
      writes.push(table);
      hook("write", table);
    } }),
    recordQueue: async () => {
      rows.set("queue", [{ event: "source_ingested" }]);
      hook("queue");
    },
  });
  mocks.enqueue.mockImplementation(async (tx: ReturnType<typeof connection>) => tx.recordQueue());
  const db = {
    ...connection(durable),
    transaction: async (run: (tx: ReturnType<typeof connection>) => Promise<unknown>) => {
      transactions.started++;
      hook("transaction");
      const staged = new Map([...durable].map(([table, rows]) => [table, structuredClone(rows)]));
      try {
        const result = await run(connection(staged, true));
        durable = staged;
        transactions.committed++;
        hook("committed");
        return result;
      } catch (error) {
        transactions.rolledBack++;
        throw error;
      }
    },
  };
  mocks.getDb.mockResolvedValue(db);
  return { settings, originalSettings, transactions, writes, rows: (table: unknown) => durable.get(table) ?? [] };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function provider(hook: (url: URL, init?: RequestInit) => void = () => {}) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    hook(url, init);
    if (url.hostname === "oauth2.googleapis.com") return response({ access_token: "test-access-token" });
    if (url.hostname === "www.googleapis.com") return response({ files: [{
      id: "file-1", name: "Evidence review task", modifiedTime: receivedAt.toISOString(),
    }] });
    if (url.pathname.endsWith("/messages")) return response({ messages: [{ id: "message-1", threadId: "thread-1" }] });
    return response({
      id: "message-1", threadId: "thread-1", internalDate: String(receivedAt.getTime()),
      snippet: "Review card-1; due 2026-10-02", payload: { headers: [{ name: "Subject", value: "Case update" }] },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JWT_SECRET", "test-google-evidence-ownership-secret-long-enough");
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  mocks.worker.mockResolvedValue({ timezone: "UTC", founderId: 1 });
  mocks.commitment.mockResolvedValue({ state: "created" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unmocked provider request")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Google scheduled ownership", () => {
  it.each(["gmail", "drive"] as const)("uses the active transaction for every %s ownership check", async source => {
    let inTransaction = false;
    database(operation => {
      if (operation === "transaction") inTransaction = true;
      if (operation === "committed") inTransaction = false;
    });
    provider();
    const context: ScheduledJobContext = { signal: new AbortController().signal, assertOwnership: vi.fn(async reader => {
      if (inTransaction) expect(reader).toEqual(expect.objectContaining({ select: expect.any(Function) }));
    }) };
    const result = await syncWorkerGoogleEvidence(workerId, { gmail: source === "gmail", drive: source === "drive", context });
    expect(result[source].state).toBe("synced");
    expect(inTransaction).toBe(false);
  });

  function mailFixture() {
    const fixture = database();
    fixture.settings.set("googleMailDeliveryRefreshToken", encryptGoogleRefreshToken("test-delivery-token"));
    fixture.settings.set("googleMailDeliveryProfile", JSON.stringify({ emailAddress: "owner@example.invalid", connectedAt: receivedAt.toISOString() }));
    return fixture;
  }
  const message = { to: "worker@example.invalid", subject: "Fixture only", html: "<p>Fixture</p>", text: "Fixture" };

  it("does not prepare Google delivery after the scheduled job is already aborted", async () => {
    const lease = ownership(); lease.controller.abort();
    await expect(sendGoogleMail(message, lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send Google mail after ownership is lost during token preparation", async () => {
    mailFixture(); const lease = ownership();
    const fetchMock = provider(url => { if (url.hostname === "oauth2.googleapis.com") lease.lose(); });
    await expect(sendGoogleMail(message, lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/messages/send"))).toBe(false);
  });

  it("checks ownership again after asynchronous MIME preparation before Google sends", async () => {
    mailFixture(); const lease = ownership(); const fetchMock = provider();
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail: async () => {
      lease.lose(); return { message: Buffer.from("fixture") };
    } } as never);
    await expect(sendGoogleMail(message, lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/messages/send"))).toBe(false);
  });

  it("cancels an in-flight Google send and does not issue another send", async () => {
    mailFixture(); const lease = ownership(); let sends = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (new URL(String(input)).hostname === "oauth2.googleapis.com") return response({ access_token: "token" });
      sends++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        lease.controller.abort();
      });
    }));
    await expect(sendGoogleMail(message, lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(sends).toBe(1);
  });

  it("preserves manual Google mail delivery without a scheduled context", async () => {
    mailFixture(); let sends = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      if (new URL(String(input)).hostname === "oauth2.googleapis.com") return response({ access_token: "token" });
      sends++; return response({ id: "synthetic-message-id" });
    }));
    expect(await sendGoogleMail(message)).toEqual({ id: "synthetic-message-id" });
    expect(sends).toBe(1);
  });

  it("rejects an already aborted run before reading credentials or contacting Google", async () => {
    const lease = ownership();
    lease.controller.abort();
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight token request without recording a provider or authentication failure", async () => {
    const fixture = database();
    const lease = ownership();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        lease.controller.abort();
      });
    }));
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.settings).toEqual(fixture.originalSettings);
    expect(fixture.writes).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not latch invalid_grant when ownership is lost while reading its body", async () => {
    const fixture = database();
    const lease = ownership();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => {
      lease.lose();
      return { error: "invalid_grant" };
    } }));
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.settings).toEqual(fixture.originalSettings);
    expect(fixture.writes).toEqual([]);
  });

  it("rethrows lease loss after Gmail reads instead of continuing Drive", async () => {
    const fixture = database();
    const lease = ownership();
    const fetchMock = provider((url) => {
      if (url.hostname === "gmail.googleapis.com") lease.lose();
    });
    await expect(syncWorkerGoogleEvidence(workerId, { onlyDue: true, context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "oauth2.googleapis.com", "gmail.googleapis.com",
    ]);
    expect(fixture.settings).toEqual(fixture.originalSettings);
    expect(fixture.transactions.started).toBe(0);
  });

  it.each(["gmail", "drive"] as const)("stops %s pagination when ownership is lost while reading a page", async (source) => {
    const lease = ownership();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => {
      lease.lose();
      return { messages: [], files: [], nextPageToken: "page-2" };
    } });
    vi.stubGlobal("fetch", fetchMock);
    const run = source === "gmail"
      ? listGmailMessages("token", 30, lease.context)
      : listDriveFiles("token", defaultGoogleEvidenceSettings().drive, lease.context);
    await expect(run).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["gmail", "drive"] as const)("rolls back %s writes when the last reassessment trigger loses ownership", async (source) => {
    const lease = ownership();
    const fixture = database((operation) => { if (operation === "queue") lease.lose(); });
    provider();
    await expect(syncWorkerGoogleEvidence(workerId, {
      gmail: source === "gmail", drive: source === "drive", context: lease.context,
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.transactions).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    expect(fixture.writes).toContain(source === "gmail" ? emailTasks : workspaceEvidenceItems);
    expect(fixture.rows(emailTasks)).toEqual([]);
    expect(fixture.rows(workspaceEvidenceItems)).toEqual([]);
    expect(fixture.rows(aptlssEvidenceRevisions)).toEqual([]);
    expect(fixture.rows(workspaceEvidenceLinks)).toEqual([]);
    expect(fixture.rows("queue")).toEqual([]);
    expect(fixture.settings).toEqual(fixture.originalSettings);
    expect(mocks.commitment).not.toHaveBeenCalled();
  });

  it("aborts the bounded Gmail detail pool without starting another batch or Drive", async () => {
    const fixture = database();
    const lease = ownership();
    const signals: AbortSignal[] = [];
    let detailsStarted = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      signals.push(init!.signal!);
      if (url.hostname === "oauth2.googleapis.com") return response({ access_token: "token" });
      if (url.pathname.endsWith("/messages")) return response({
        messages: Array.from({ length: 12 }, (_, index) => ({ id: `message-${index}`, threadId: `thread-${index}` })),
      });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        if (++detailsStarted === 5) lease.controller.abort();
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(detailsStarted).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fixture.transactions.started).toBe(0);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it.each([
    { source: "gmail", operation: "tx-read", table: emailTasks, blocked: emailTasks },
    { source: "drive", operation: "tx-read", table: workspaceEvidenceItems, blocked: workspaceEvidenceItems },
    { source: "drive", operation: "tx-read", table: aptlssEvidenceRevisions, blocked: aptlssEvidenceRevisions },
    { source: "drive", operation: "tx-read", table: workspaceEvidenceLinks, blocked: workspaceEvidenceLinks },
    { source: "drive", operation: "write", table: workspaceEvidenceLinks, blocked: "queue" },
  ])("checks ownership before the next $source mutation after $operation", async ({ source, operation, table, blocked }) => {
    const lease = ownership();
    const fixture = database((nextOperation, nextTable) => {
      if (nextOperation === operation && nextTable === table) lease.lose();
    });
    provider();
    await expect(syncWorkerGoogleEvidence(workerId, {
      gmail: source === "gmail", drive: source === "drive", context: lease.context,
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.transactions).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    if (blocked === "queue") {
      // Loss during link deletion must prevent both the replacement link and the queue trigger.
      expect(fixture.writes.filter((written) => written === workspaceEvidenceLinks)).toHaveLength(1);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    } else expect(fixture.writes).not.toContain(blocked);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it("checks immediately before the reassessment trigger after thread-state reads", async () => {
    const lease = ownership();
    let emailReads = 0;
    const fixture = database((operation, table) => {
      if (operation === "tx-read" && table === emailTasks && ++emailReads === 3) lease.lose();
    });
    provider();
    await expect(syncWorkerGoogleEvidence(workerId, { drive: false, context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.writes).toContain(emailTasks);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(fixture.transactions.rolledBack).toBe(1);
    expect(fixture.rows(emailTasks)).toEqual([]);
  });

  it("rolls back an unlinked Drive transaction even when no reassessment trigger is needed", async () => {
    const lease = ownership();
    const fixture = database((operation, table) => {
      if (operation === "write" && table === aptlssEvidenceRevisions) lease.lose();
    });
    const fetchMock = provider();
    fetchMock.mockImplementation(async (input) => new URL(String(input)).hostname === "oauth2.googleapis.com"
      ? response({ access_token: "token" })
      : response({ files: [{ id: "unlinked-file", name: "Unrelated document", modifiedTime: receivedAt.toISOString() }] }));
    await expect(syncWorkerGoogleEvidence(workerId, { gmail: false, context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(fixture.transactions).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    expect(fixture.rows(workspaceEvidenceItems)).toEqual([]);
    expect(fixture.rows(aptlssEvidenceRevisions)).toEqual([]);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it("does not start a source commitment or Drive after loss following a Gmail commit", async () => {
    const lease = ownership();
    const fixture = database((operation) => { if (operation === "committed") lease.lose(); });
    const fetchMock = provider();
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.transactions.committed).toBe(1);
    expect(mocks.commitment).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("drive/v3"))).toBe(false);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it("passes the lease context separately from the source commitment's evidence text", async () => {
    database();
    const lease = ownership();
    provider();
    const result = await syncWorkerGoogleEvidence(workerId, { drive: false, context: lease.context });
    expect(result.gmail.state).toBe("synced");
    expect(mocks.commitment).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "gmail", sourceId: "thread-1",
      context: expect.stringContaining("Deadline evidence: due 2026-10-02"),
    }), lease.context);
    expect(mocks.commitment.mock.calls[0][0].context).toContain("Email from");
  });

  it("stops Drive and settings writes when source commitment processing loses ownership", async () => {
    const fixture = database();
    const lease = ownership();
    const fetchMock = provider();
    mocks.commitment.mockImplementation(async (_input, context) => {
      expect(context).toBe(lease.context);
      lease.lose();
      await context.assertOwnership();
    });
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.transactions.committed).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("drive/v3"))).toBe(false);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it("checks ownership again after acquiring the settings connection", async () => {
    const lease = ownership();
    const fixture = database();
    provider();
    let acquisitions = 0;
    const db = await mocks.getDb();
    mocks.getDb.mockImplementation(async () => {
      if (++acquisitions === 4) lease.lose();
      return db;
    });
    await expect(syncWorkerGoogleEvidence(workerId, { gmail: false, drive: false, context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fixture.writes).toEqual([]);
    expect(fixture.settings).toEqual(fixture.originalSettings);
  });

  it("checks an abort that happens during the ownership assertion itself", async () => {
    const fixture = database();
    const lease = ownership();
    lease.context.assertOwnership = vi.fn(async () => lease.controller.abort());
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });

  it("does not swallow a lease-loss error even if a later ownership check could succeed", async () => {
    const fixture = database();
    const lease = ownership();
    const loss = new ScheduledJobLeaseLostError();
    provider((url) => {
      if (url.hostname === "oauth2.googleapis.com") throw loss;
    });
    await expect(syncWorkerGoogleEvidence(workerId, { context: lease.context })).rejects.toBe(loss);
    expect(fixture.settings).toEqual(fixture.originalSettings);
    expect(fixture.writes).toEqual([]);
  });

  it("skips providers and durable writes when neither source is due", async () => {
    const fixture = database();
    const lease = ownership();
    const current = {
      ...defaultGoogleEvidenceSettings(), lastGmailSyncAt: new Date().toISOString(), lastDriveSyncAt: new Date().toISOString(),
    };
    fixture.settings.set(`googleEvidence:${workerId}`, JSON.stringify(current));
    const result = await syncWorkerGoogleEvidence(workerId, { onlyDue: true, context: lease.context });
    expect(result.gmail.state).toBe("skipped");
    expect(result.drive.state).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
    expect(fixture.settings.get(`googleEvidence:${workerId}`)).toBe(JSON.stringify(current));
  });

  it("preserves invalid-grant authentication handling when ownership remains valid", async () => {
    const fixture = database();
    const lease = ownership();
    const fetchMock = vi.fn().mockResolvedValue(response({ error: "invalid_grant" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncWorkerGoogleEvidence(workerId, { context: lease.context });
    expect(result.gmail.state).toBe("failed");
    expect(result.drive.state).toBe("failed");
    expect(JSON.parse(fixture.settings.get(`googleEvidence:${workerId}`)!)).toMatchObject({
      invalidRefreshTokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await syncWorkerGoogleEvidence(workerId, { context: lease.context })).configured).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still records an ordinary provider failure and continues Drive while ownership is valid", async () => {
    const fixture = database();
    const lease = ownership();
    const fetchMock = provider();
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return response({ access_token: "token" });
      if (url.hostname === "gmail.googleapis.com") return response({}, 503);
      return response({ files: [] });
    });
    const result = await syncWorkerGoogleEvidence(workerId, { context: lease.context });
    expect(result.gmail.state).toBe("failed");
    expect(result.drive.state).toBe("synced");
    expect(JSON.parse(fixture.settings.get(`googleEvidence:${workerId}`)!)).toMatchObject({
      lastGmailSyncAt: null, lastGmailError: expect.any(String), lastDriveError: null,
    });
    expect(lease.context.assertOwnership).toHaveBeenCalled();
  });
});
