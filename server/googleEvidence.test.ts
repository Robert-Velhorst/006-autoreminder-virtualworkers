import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueManagerTask } from "./aptlssManagerQueue";
import {
  appSettings,
  aptlssPlans,
  emailTasks,
  users,
  workspaceEvidenceItems,
} from "../drizzle/schema";
import {
  classifyGoogleEmail,
  candidateGmailDeadline,
  decryptGoogleRefreshToken,
  defaultGoogleEvidenceSettings,
  evidenceRevisionChanged,
  enqueueGoogleGmailReassessment,
  encryptGoogleRefreshToken,
  extractExplicitDeadline,
  findExactCardMatch,
  GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING,
  googleDriveEvidenceRevision,
  googleDriveRevisionDisposition,
  googleGmailEvidenceRevision,
  googleGmailRevisionTransition,
  googleGmailSourceDisposition,
  googleGmailSourceConflictState,
  gmailEvidenceNeedsReassessment,
  gmailEvidenceOwnerMatches,
  googleEvidenceSetupMessage,
  listDriveFiles,
  listGmailMessages,
  consumeGoogleOAuthState,
  getGoogleEvidenceStatus,
  normalizeGoogleEvidenceSettings,
  retainGmailEvidenceRecord,
  retainGoogleDriveEvidenceRecord,
  reconcileGmailThreadMessage,
  saveGoogleOAuthState,
  saveGoogleRefreshToken,
  syncWorkerGoogleEvidence,
  syncWorkerGoogleEvidenceIfDue,
} from "./googleEvidence";
import { gmailContentScope } from "../shared/gmailContentScope";

const databaseMocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("./db", () => ({ getDb: databaseMocks.getDb }));
vi.mock("./aptlssManagerQueue", () => ({
  enqueueManagerTask: vi.fn().mockResolvedValue({ accepted: true }),
}));
vi.mock("./workerOperatorContext", () => ({
  resolveWorkerOperatorContextById: vi.fn().mockResolvedValue({ timezone: "UTC", founderId: null }),
}));

const previousJwtSecret = process.env.JWT_SECRET;
const previousNodeEnv = process.env.NODE_ENV;
const previousGoogleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

function createMockGmailRetentionTx(existing: typeof emailTasks.$inferSelect) {
  let upsertCount = 0;
  const tx = {
    select: () => ({
      from: (_table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_count?: number) => query,
          for: (_lock: string) => query,
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve([existing]).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (_table: unknown) => ({
      values: (_values: typeof emailTasks.$inferInsert) => ({
        onDuplicateKeyUpdate: async (_config: unknown) => { upsertCount += 1; },
      }),
    }),
  } as never;
  return { tx, get upsertCount() { return upsertCount; } };
}

function settingKeyFromCondition(condition: unknown) {
  const seen = new Set<object>();
  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const match = visit(item);
        if (match) return match;
      }
      return null;
    }
    const candidate = (value as { value?: unknown }).value;
    if (typeof candidate === "string" && /^(googleEvidence(?:OAuthState)?|googleEvidenceRefreshToken):/.test(candidate)) {
      return candidate;
    }
    for (const child of Object.values(value)) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  return visit(condition);
}

function queryContainsValue(query: unknown, expected: string) {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (value === expected) return true;
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    return Object.values(value).some(visit);
  };
  return visit(query);
}

function createMockGoogleEvidenceDb(settings: Map<string, string>) {
  return {
    select: () => ({
      from: (_table: unknown) => {
        let condition: unknown;
        const query = {
          where: (next: unknown) => { condition = next; return query; },
          orderBy: () => query,
          for: () => query,
          limit: async (_count?: number) => {
            const key = settingKeyFromCondition(condition);
            const value = key ? settings.get(key) : undefined;
            return value === undefined ? [] : [{ value }];
          },
        };
        return query;
      },
    }),
    insert: (_table: unknown) => ({
      values: (row: { key: string; value: string }) => ({
        onDuplicateKeyUpdate: async (_config: unknown) => {
          settings.set(row.key, row.value);
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: async (condition: unknown) => {
        const key = settingKeyFromCondition(condition);
        const value = key ? settings.get(key) : undefined;
        if (key && value !== undefined && queryContainsValue(condition, value)) {
          settings.delete(key);
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      },
    }),
  } as never;
}

function createMockGoogleEvidenceSyncDb(
  settings: Map<string, string>,
  options: {
    workerId: number;
    cards?: Array<Record<string, unknown>>;
    gmailExisting?: typeof emailTasks.$inferSelect | null;
    driveExisting?: typeof workspaceEvidenceItems.$inferSelect | null;
  },
) {
  const writes = { gmail: 0, drive: 0 };
  const rowsFor = (table: unknown, condition: unknown) => {
    if (table === appSettings) {
      const key = settingKeyFromCondition(condition);
      const value = key ? settings.get(key) : undefined;
      return value === undefined ? [] : [{ value }];
    }
    if (table === users) return [{ id: options.workerId }];
    if (table === aptlssPlans) return options.cards ?? [];
    if (table === emailTasks) return options.gmailExisting ? [options.gmailExisting] : [];
    if (table === workspaceEvidenceItems) return options.driveExisting ? [options.driveExisting] : [];
    return [];
  };
  const select = () => ({
    from: (table: unknown) => {
      let condition: unknown;
      const query = {
        where: (next: unknown) => { condition = next; return query; },
        orderBy: () => query,
        limit: () => query,
        for: () => query,
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rowsFor(table, condition)).then(resolve, reject),
      };
      return query;
    },
  });
  const insert = (table: unknown) => ({
    values: (row: Record<string, unknown>) => ({
      onDuplicateKeyUpdate: async () => {
        if (table === appSettings && typeof row.key === "string" && typeof row.value === "string") {
          settings.set(row.key, row.value);
        }
        if (table === emailTasks) writes.gmail++;
        if (table === workspaceEvidenceItems) writes.drive++;
      },
    }),
  });
  const tx = { select, insert };
  return {
    writes,
    db: {
      select,
      insert,
      transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    } as never,
  };
}

function googleSyncSettings(workerId: number) {
  return new Map<string, string>([
    [`googleEvidence:${workerId}`, JSON.stringify(defaultGoogleEvidenceSettings())],
    [`googleEvidenceRefreshToken:${workerId}`, encryptGoogleRefreshToken("mock-worker-refresh-token")],
  ]);
}

function mockJsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  databaseMocks.getDb.mockReset();
  process.env.JWT_SECRET = "test-google-evidence-secret-that-is-long-enough";
});

afterEach(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousGoogleRefreshToken === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
  else process.env.GOOGLE_REFRESH_TOKEN = previousGoogleRefreshToken;
  if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
  if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
  vi.unstubAllGlobals();
});

describe("Google evidence settings", () => {
  it("uses bounded safe defaults when a saved setting is malformed", () => {
    expect(normalizeGoogleEvidenceSettings({
      gmail: { intervalMinutes: 1, lookbackDays: 999 },
      drive: { intervalMinutes: 10_000, folderId: "  folder-123  " },
      lastGmailError: "  Gmail unavailable  ",
      lastDriveError: "ignored?",
    })).toEqual({
      ...defaultGoogleEvidenceSettings(),
      gmail: { enabled: true, intervalMinutes: 15, lookbackDays: 90 },
      drive: { enabled: true, intervalMinutes: 1_440, lookbackDays: 30, folderId: "folder-123" },
      lastGmailError: "Gmail unavailable",
      lastDriveError: "ignored?",
    });
  });

  it("reads older settings without provider-specific sync errors", () => {
    expect(normalizeGoogleEvidenceSettings({ lastError: "Legacy combined error" })).toMatchObject({
      lastGmailError: null,
      lastDriveError: null,
      lastError: "Legacy combined error",
    });
  });

  it("keeps source-conflict review latched across successful syncs without mislabeling a provider error", () => {
    expect(googleGmailSourceConflictState(false, 1)).toEqual({
      pending: true,
      warning: GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING,
    });
    expect(googleGmailSourceConflictState(true, 0)).toEqual({
      pending: true,
      warning: GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING,
    });
    expect(googleGmailSourceConflictState(false, 0)).toEqual({ pending: false, warning: null });
    expect(GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING).not.toContain("@example");
    expect(GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING).not.toContain("gmail.googleapis.com");
  });

  it("exposes the latched source-conflict warning separately from Gmail provider errors", async () => {
    const workerId = 818;
    const settings = new Map<string, string>([[
      `googleEvidence:${workerId}`,
      JSON.stringify({ ...defaultGoogleEvidenceSettings(), gmailSourceConflictPending: true }),
    ]]);
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));

    const status = await getGoogleEvidenceStatus(workerId);

    expect(status.gmail).toMatchObject({
      sourceConflictPending: true,
      sourceConflictWarning: GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING,
      lastError: null,
    });
  });

  it("distinguishes missing server credentials from a missing worker connection", () => {
    expect(googleEvidenceSetupMessage({})).toContain("GOOGLE_CLIENT_ID");
    expect(googleEvidenceSetupMessage({ clientId: "client", clientSecret: "secret" }))
      .toBe("Connect Google for this worker to authorize read-only Gmail and Drive evidence.");
    expect(googleEvidenceSetupMessage({ clientId: "client", clientSecret: "secret", refreshToken: "token" }))
      .toBeNull();
  });

  it("marks an expired worker connection as requiring reconnection", () => {
    expect(googleEvidenceSetupMessage({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "stored-worker-token",
      reconnectRequired: true,
    })).toBe("Google connection expired. Reconnect Google for this worker to continue Gmail and Drive evidence sync.");
  });
});

describe("Google worker credential reliability", () => {
  it("scopes pending OAuth state by purpose and account and consumes each state once", async () => {
    const settings = new Map<string, string>();
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));
    const expiresAt = Date.now() + 60_000;
    await saveGoogleOAuthState("worker", 101, "worker-nonce", expiresAt);
    await saveGoogleOAuthState("worker", 202, "other-worker-nonce", expiresAt);
    await saveGoogleOAuthState("mail-delivery", 101, "admin-nonce", expiresAt);

    expect(settings.size).toBe(3);
    expect(await consumeGoogleOAuthState("worker", 101, "worker-nonce", expiresAt)).toBe(true);
    expect(await consumeGoogleOAuthState("worker", 101, "worker-nonce", expiresAt)).toBe(false);
    expect(await consumeGoogleOAuthState("worker", 202, "worker-nonce", expiresAt)).toBe(false);
    expect(await consumeGoogleOAuthState("worker", 202, "other-worker-nonce", expiresAt)).toBe(true);
    expect(await consumeGoogleOAuthState("mail-delivery", 101, "admin-nonce", expiresAt)).toBe(true);
  });

  it("loads each worker's own encrypted refresh token without returning credentials", async () => {
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";
    const settings = new Map<string, string>();
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));
    const refreshTokens = new Map([[101, "worker-101-refresh-secret"], [202, "worker-202-refresh-secret"]]);
    await Promise.all(Array.from(refreshTokens, ([workerId, token]) => saveGoogleRefreshToken(workerId, token)));
    for (const [workerId, token] of refreshTokens) {
      expect(settings.get(`googleEvidenceRefreshToken:${workerId}`)).not.toBe(token);
    }

    const usedRefreshTokens: string[] = [];
    let accessTokenNumber = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      usedRefreshTokens.push(body.get("refresh_token") ?? "");
      accessTokenNumber += 1;
      return new Response(JSON.stringify({ access_token: `mock-access-token-${accessTokenNumber}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all(Array.from(refreshTokens.keys(), (workerId) =>
      syncWorkerGoogleEvidence(workerId, { gmail: false, drive: false })
    ));
    const status = await getGoogleEvidenceStatus(101);
    const serialized = JSON.stringify({ results, status });

    expect(usedRefreshTokens.sort()).toEqual(Array.from(refreshTokens.values()).sort());
    for (const token of refreshTokens.values()) expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("mock-access-token");
    expect(status.connectionMode).toBe("worker");
  });

  it("does not refresh Google credentials when neither source is due", async () => {
    const workerId = 404;
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";
    const settings = new Map<string, string>();
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));
    const currentSettings = {
      ...defaultGoogleEvidenceSettings(),
      lastGmailSyncAt: new Date().toISOString(),
      lastDriveSyncAt: new Date().toISOString(),
      lastError: "Previous sync error",
    };
    settings.set(`googleEvidence:${workerId}`, JSON.stringify(currentSettings));
    await saveGoogleRefreshToken(workerId, "worker-refresh-token");

    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected Google request"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncWorkerGoogleEvidenceIfDue(workerId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      configured: true,
      gmail: { state: "skipped", scanned: 0, imported: 0, linked: 0 },
      drive: { state: "skipped", scanned: 0, imported: 0, linked: 0 },
      message: null,
    });
    expect(settings.get(`googleEvidence:${workerId}`)).toBe(JSON.stringify(currentSettings));
  });

  it("does not use the shared environment token for either worker on staging", async () => {
    process.env.NODE_ENV = "staging";
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";
    process.env.GOOGLE_REFRESH_TOKEN = "shared-mailbox-token";
    const settings = new Map<string, string>();
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Network access is disabled in this test"));
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      syncWorkerGoogleEvidence(101, { gmail: true, drive: true }),
      syncWorkerGoogleEvidence(202, { gmail: true, drive: true }),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.configured).toBe(false);
      expect(result.gmail.state).toBe("blocked");
      expect(result.drive.state).toBe("blocked");
      expect(result.message).toBe("Connect Google for this worker to authorize read-only Gmail and Drive evidence.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settings.size).toBe(0);
  });

  it("stores invalid_grant as reconnect-required and stops retrying that token until it changes", async () => {
    const workerId = 303;
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";
    const settings = new Map<string, string>();
    databaseMocks.getDb.mockResolvedValue(createMockGoogleEvidenceDb(settings));
    await saveGoogleRefreshToken(workerId, "revoked-worker-refresh-token");

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant", error_description: "mock provider detail" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "mock-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncWorkerGoogleEvidence(workerId);
    expect(first.configured).toBe(true);
    expect(first.gmail.state).toBe("failed");
    expect(first.drive.state).toBe("failed");
    expect(first.message).toBe("Google connection expired. Reconnect Google for this worker to continue Gmail and Drive evidence sync.");

    const retry = await syncWorkerGoogleEvidence(workerId);
    expect(retry.configured).toBe(false);
    expect(retry.gmail.state).toBe("blocked");
    expect(retry.drive.state).toBe("blocked");
    expect(retry.message).toBe(first.message);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await saveGoogleRefreshToken(workerId, "replacement-worker-refresh-token");
    const reconnected = await syncWorkerGoogleEvidence(workerId, { gmail: false, drive: false });
    expect(reconnected.configured).toBe(true);
    expect(reconnected.message).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(settings.get(`googleEvidence:${workerId}`)!).invalidRefreshTokenFingerprint).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => String(url) === "https://oauth2.googleapis.com/token")).toBe(true);
  });
});

describe("Google evidence classification", () => {
  it("queues only meaningful retained-source revisions, not repeated Drive observations", () => {
    const file = {
      id: "drive-file-1",
      name: "Case correspondence",
      mimeType: "application/pdf",
      modifiedAt: new Date("2026-09-25T10:00:00.000Z"),
      sourceUrl: "https://drive.google.com/file/d/drive-file-1/view",
      description: "Current correspondence",
      parents: ["folder-b", "folder-a"],
      size: "1024",
    };
    const first = googleDriveEvidenceRevision(file);
    const repeatedPoll = googleDriveEvidenceRevision({ ...file, parents: ["folder-a", "folder-b"] });
    const updated = googleDriveEvidenceRevision({ ...file, description: "Updated correspondence" });

    expect(repeatedPoll).toBe(first);
    expect(evidenceRevisionChanged(null, first)).toBe(true);
    expect(evidenceRevisionChanged(first, repeatedPoll)).toBe(false);
    expect(evidenceRevisionChanged(first, first, false)).toBe(true);
    expect(evidenceRevisionChanged(first, updated)).toBe(true);
  });

  it("accepts only a strictly newer Drive version when retained content changes", () => {
    const older = new Date("2026-09-25T10:00:00.000Z");
    const newer = new Date("2026-09-25T10:01:00.000Z");
    const retained = { modifiedAt: newer, contentHash: "new-content" };
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: older, contentHash: "old-content" })).toBe("stale");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: newer, contentHash: "different-content" })).toBe("ambiguous");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: null, contentHash: "unversioned-content" })).toBe("ambiguous");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: newer, contentHash: "new-content" })).toBe("accept");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: new Date(newer.getTime() + 1), contentHash: "latest-content" })).toBe("accept");
    expect(googleDriveRevisionDisposition({ modifiedAt: newer, contentHash: null }, { modifiedAt: older, contentHash: "old-content" })).toBe("stale");
    expect(googleDriveRevisionDisposition({ modifiedAt: null, contentHash: "legacy-content" }, { modifiedAt: newer, contentHash: "versioned-content" })).toBe("ambiguous");
    expect(googleDriveRevisionDisposition({ modifiedAt: null, contentHash: "same-content" }, { modifiedAt: null, contentHash: "same-content" })).toBe("accept");
  });

  it("locks the worker before reading Drive evidence and preserves unversioned retained content", async () => {
    const lockedTables: unknown[] = [];
    const retained = {
      id: 81,
      modifiedAt: null,
      contentHash: "legacy-content-hash",
      active: true,
      observedAt: new Date("2026-09-25T10:00:00.000Z"),
    };
    const tx = {
      select: () => ({
        from: (table: unknown) => {
          const query = {
            where: () => query,
            limit: () => query,
            for: async () => {
              lockedTables.push(table);
              return table === users ? [{ id: 42 }] : [retained];
            },
          };
          return query;
        },
      }),
    } as never;
    const incoming = {
      vaId: 42,
      source: "google_drive",
      sourceId: "42:file-1",
      sourceContainerId: "worker:42",
      title: "Potentially stale version",
      content: "Newly fetched content",
      modifiedAt: new Date("2026-09-26T10:00:00.000Z"),
      contentHash: "new-version-hash",
      observedAt: new Date("2026-09-26T10:01:00.000Z"),
    } as never;

    await expect(retainGoogleDriveEvidenceRecord(tx, incoming))
      .rejects.toThrow("without a provably newer modification time");
    expect(lockedTables).toEqual([users, workspaceEvidenceItems]);
  });

  it("gives Gmail evidence a stable revision key that changes with its retained content", () => {
    const message = {
      gmailMessageId: "message-1",
      gmailThreadId: "thread-1",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "A request was received",
      receivedAt: new Date("2026-09-25T10:00:00.000Z"),
      category: "non_financial",
      deadlineAt: null,
      trelloCardId: "card-1",
      trelloCardName: "Review case",
      trelloCardUrl: "https://trello.com/c/card-1",
      suggestedNextAction: "Review the message",
      llmSummary: null,
    };
    expect(googleGmailEvidenceRevision(message)).toBe(googleGmailEvidenceRevision({ ...message }));
    expect(googleGmailEvidenceRevision({ ...message, snippet: "A changed request was received" }))
      .not.toBe(googleGmailEvidenceRevision(message));
  });

  it("does not infer changed Gmail revision order from receivedAt", () => {
    const existing = {
      gmailMessageId: "message-1",
      gmailThreadId: "thread-1",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Original source text",
      receivedAt: new Date("2026-09-25T10:00:00.000Z"),
    };
    const changedSnapshots = [
      { ...existing, receivedAt: new Date("2026-09-25T09:59:00.000Z"), snippet: "Changed older snapshot" },
      { ...existing, snippet: "Changed equal-time snapshot" },
      { ...existing, receivedAt: new Date("2026-09-25T10:01:00.000Z"), snippet: "Changed later-time snapshot" },
      { ...existing, fromAddress: "other@example.test" },
    ];

    expect(googleGmailSourceDisposition(null, existing)).toBe("new");
    expect(googleGmailSourceDisposition(existing, { ...existing })).toBe("same_source");
    for (const incoming of changedSnapshots) {
      expect(googleGmailSourceDisposition(existing, incoming)).toBe("conflict");
    }
  });

  it("leaves a changed same-message source snapshot untouched when revision order is ambiguous", async () => {
    const receivedAt = new Date("2026-09-25T10:00:00.000Z");
    const existing = {
      id: 81,
      vaId: 12,
      gmailMessageId: "message-1",
      gmailThreadId: "thread-1",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Original source text",
      receivedAt,
      category: "non_financial",
      status: "processed",
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the original message",
      llmSummary: null,
      processedAt: receivedAt,
      archivedAt: null,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    } satisfies typeof emailTasks.$inferSelect;
    const incoming = {
      vaId: 12,
      gmailMessageId: "message-1",
      gmailThreadId: "thread-1",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Changed source text",
      receivedAt,
      category: "non_financial" as const,
      status: "pending" as const,
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the original message",
      llmSummary: null,
    } satisfies typeof emailTasks.$inferInsert;
    const mock = createMockGmailRetentionTx(existing);

    await expect(retainGmailEvidenceRecord(mock.tx, incoming)).resolves.toEqual({
      retained: false,
      existing: null,
      conflict: "source_revision",
    });
    expect(mock.upsertCount).toBe(0);
    expect(existing).toMatchObject({ snippet: "Original source text", status: "processed" });
  });

  it("treats an exact duplicate as a no-op and preserves the worker's processed status", async () => {
    const receivedAt = new Date("2026-09-25T10:00:00.000Z");
    const existing = {
      id: 82,
      vaId: 12,
      gmailMessageId: "message-2",
      gmailThreadId: "thread-2",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Same source text",
      receivedAt,
      category: "non_financial",
      status: "processed",
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the message",
      llmSummary: null,
      processedAt: receivedAt,
      archivedAt: null,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    } satisfies typeof emailTasks.$inferSelect;
    const incoming = {
      vaId: 12,
      gmailMessageId: "message-2",
      gmailThreadId: "thread-2",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Same source text",
      receivedAt,
      category: "non_financial" as const,
      status: "pending" as const,
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the message",
      llmSummary: null,
    } satisfies typeof emailTasks.$inferInsert;
    const mock = createMockGmailRetentionTx(existing);

    await expect(retainGmailEvidenceRecord(mock.tx, incoming)).resolves.toEqual({
      retained: true,
      existing,
    });
    expect(mock.upsertCount).toBe(0);
    expect(existing.status).toBe("processed");
  });

  it("rejects a Gmail message ID already retained for another worker", async () => {
    const receivedAt = new Date("2026-09-25T10:00:00.000Z");
    const existing = {
      id: 83,
      vaId: 13,
      gmailMessageId: "shared-message-id",
      gmailThreadId: "thread-3",
      subject: "Other worker message",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "Private source text",
      receivedAt,
      category: "non_financial",
      status: "pending",
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the message",
      llmSummary: null,
      processedAt: null,
      archivedAt: null,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    } satisfies typeof emailTasks.$inferSelect;
    const incoming = {
      vaId: 12,
      gmailMessageId: "shared-message-id",
      gmailThreadId: "thread-3",
      subject: "Worker 12 message",
      fromAddress: "another@example.test",
      fromName: "Another sender",
      snippet: "Must not be retained",
      receivedAt,
      category: "non_financial" as const,
      status: "pending" as const,
      deadlineAt: null,
      trelloCardId: null,
      trelloCardName: null,
      trelloCardUrl: null,
      suggestedNextAction: "Review the message",
      llmSummary: null,
    } satisfies typeof emailTasks.$inferInsert;
    const mock = createMockGmailRetentionTx(existing);

    await expect(retainGmailEvidenceRecord(mock.tx, incoming)).resolves.toEqual({
      retained: false,
      existing: null,
      conflict: "ownership",
    });
    expect(mock.upsertCount).toBe(0);
    expect(existing).toMatchObject({ vaId: 13, snippet: "Private source text" });
  });

  it("queues one fresh event for each Gmail content transition, including A to B to A", () => {
    const messageId = "message-1";
    const revisionA = "revision-a";
    const revisionB = "revision-b";
    const firstA = googleGmailRevisionTransition(messageId, null, revisionA);
    expect(firstA).toMatch(/^google-gmail:message-1:/);
    expect(googleGmailRevisionTransition(messageId, revisionA, revisionA)).toBeNull();

    const toB = googleGmailRevisionTransition(messageId, revisionA, revisionB);
    const backToA = googleGmailRevisionTransition(messageId, revisionB, revisionA);
    expect(toB).toMatch(/^google-gmail:message-1:/);
    expect(backToA).toMatch(/^google-gmail:message-1:/);
    expect(new Set([firstA, toB, backToA]).size).toBe(3);
    expect(googleGmailRevisionTransition(messageId, revisionA, revisionA)).toBeNull();
  });

  it("archives an older message whether its sync commits before or after the newer message", () => {
    const older = { id: "older", receivedAt: new Date("2026-09-25T10:00:00.000Z") };
    const newer = { id: "newer", receivedAt: new Date("2026-09-25T10:01:00.000Z") };

    const olderArrivesAfterNewer = reconcileGmailThreadMessage(older, [
      { gmailMessageId: newer.id, receivedAt: newer.receivedAt },
    ]);
    expect(olderArrivesAfterNewer).toEqual({ archiveIncoming: true, archiveOlderMessageIds: [] });

    const newerArrivesAfterOlder = reconcileGmailThreadMessage(newer, [
      { gmailMessageId: older.id, receivedAt: older.receivedAt },
    ]);
    expect(newerArrivesAfterOlder).toEqual({ archiveIncoming: false, archiveOlderMessageIds: [older.id] });
  });

  it("does not let a globally unique Gmail message overwrite another worker's record", () => {
    expect(gmailEvidenceOwnerMatches(null, 12)).toBe(true);
    expect(gmailEvidenceOwnerMatches(12, 12)).toBe(true);
    expect(gmailEvidenceOwnerMatches(13, 12)).toBe(false);
  });

  it("encrypts worker refresh tokens with authenticated encryption", () => {
    const encrypted = encryptGoogleRefreshToken("refresh-token-value");
    expect(encrypted).not.toContain("refresh-token-value");
    expect(decryptGoogleRefreshToken(encrypted)).toBe("refresh-token-value");
    expect(() => decryptGoogleRefreshToken(`${encrypted}x`)).toThrow();
  });

  it("classifies financial records without an LLM call", () => {
    expect(classifyGoogleEmail("Invoice INV-42", "Your payment receipt is attached")).toMatchObject({
      category: "financial",
    });
  });

  it("selects the exact related card rather than a loose keyword match", () => {
    const cards = [
      { cardId: "abc123", cardName: "Prepare client proposal", cardUrl: "", boardName: "", listName: "" },
      { cardId: "def456", cardName: "Send weekly report", cardUrl: "", boardName: "", listName: "" },
    ];
    expect(findExactCardMatch("Please review abc123 today", cards)).toMatchObject({
      score: 100,
      card: { cardId: "abc123" },
    });
    expect(findExactCardMatch("The proposal is ready", cards)).toBeNull();
    expect(findExactCardMatch("Prepare client proposal is ready", cards)).toMatchObject({
      score: 85,
      card: { cardId: "abc123" },
    });
  });

  it("extracts only explicit, unambiguous deadlines in the worker timezone", () => {
    expect(extractExplicitDeadline("Please respond by 2026-08-15 at 14:30", "Europe/Amsterdam")?.dueAt.toISOString())
      .toBe("2026-08-15T12:30:00.000Z");
    expect(extractExplicitDeadline("Uiterlijk 15/08/2026 aanleveren", "Europe/Amsterdam")).toMatchObject({
      dateOnly: true,
    });
    expect(extractExplicitDeadline("We should finish sometime next month", "Europe/Amsterdam")).toBeNull();
    expect(extractExplicitDeadline("Due 08/09/2026", "Europe/Amsterdam")).toBeNull();
  });

  it("treats a portal notification as a pointer to unread correspondence, not its deadline", () => {
    const subject = "Er staat een bericht voor u klaar in klacht 202600250";
    const snippet = "Er staat een bericht voor u klaar in uw persoonlijke mijn-omgeving. U vindt het onder correspondentie. Inloggen Uiterlijk 15/08/2026.";
    expect(gmailContentScope(subject, snippet)).toBe("portal_notice");
    expect(classifyGoogleEmail(subject, snippet)).toMatchObject({
      scope: "portal_notice",
      suggestedNextAction: expect.stringContaining("linked portal correspondence"),
    });
    expect(candidateGmailDeadline(subject, snippet, "Europe/Amsterdam")).toBeNull();
    expect(candidateGmailDeadline("Please respond by 2026-08-15 at 14:30", "Direct email body preview", "Europe/Amsterdam")?.dueAt.toISOString())
      .toBe("2026-08-15T12:30:00.000Z");
  });
});

describe("Google evidence pagination", () => {
  function jsonResponse(value: unknown) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("imports Gmail messages from pages beyond the first 100 results", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `gmail-${index}`,
      threadId: `thread-${index}`,
    }));
    const pageTokens: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/gmail/v1/users/me/messages") {
        const pageToken = url.searchParams.get("pageToken");
        pageTokens.push(pageToken);
        return jsonResponse(pageToken
          ? { messages: [{ id: "gmail-100", threadId: "thread-100" }] }
          : { messages: firstPage, nextPageToken: "gmail-page-2" });
      }

      const id = url.pathname.split("/").at(-1)!;
      return jsonResponse({
        id,
        threadId: `thread-${id.slice("gmail-".length)}`,
        internalDate: "1790416800000",
        snippet: `Message ${id}`,
        payload: { headers: [
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "Subject", value: `Subject ${id}` },
        ] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const messages = await listGmailMessages("mock-access-token", 30);

    expect(pageTokens).toEqual([null, "gmail-page-2"]);
    expect(messages).toHaveLength(101);
    expect(messages.map((message) => message.id)).toContain("gmail-100");
    expect(fetchMock).toHaveBeenCalledTimes(103);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer mock-access-token")).toBe(true);
  });

  it("imports Drive files from pages beyond the first 100 results", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `drive-${index}`, name: `File ${index}` }));
    const pageTokens: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const pageToken = url.searchParams.get("pageToken");
      pageTokens.push(pageToken);
      return jsonResponse(pageToken
        ? { files: [{ id: "drive-100", name: "File 100" }] }
        : { files: firstPage, nextPageToken: "drive-page-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await listDriveFiles("mock-access-token", {
      enabled: true,
      intervalMinutes: 180,
      lookbackDays: 30,
      folderId: null,
    });

    expect(pageTokens).toEqual([null, "drive-page-2"]);
    expect(files).toHaveLength(101);
    expect(files.map((file) => file.id)).toContain("drive-100");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer mock-access-token")).toBe(true);
  });

  it("stops if Google repeats a page token instead of looping indefinitely", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ files: [], nextPageToken: "repeat-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listDriveFiles("mock-access-token", {
      enabled: true,
      intervalMinutes: 180,
      lookbackDays: 30,
      folderId: null,
    })).rejects.toThrow("Google API repeated an evidence page token.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Google evidence sync reporting", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";
  });

  it("does not count a stale Drive revision as imported and uses read-only Drive requests", async () => {
    const workerId = 712;
    const settings = googleSyncSettings(workerId);
    const fixture = createMockGoogleEvidenceSyncDb(settings, {
      workerId,
      driveExisting: {
        id: 81,
        vaId: workerId,
        source: "google_drive",
        sourceId: `${workerId}:file-1`,
        sourceContainerId: `worker:${workerId}`,
        kind: "file",
        title: "Retained newer version",
        summary: "Existing source",
        content: "Existing content",
        sourceUrl: "https://drive.google.com/file/d/file-1/view",
        mimeType: "application/pdf",
        modifiedAt: new Date("2026-09-27T10:00:00.000Z"),
        observedAt: new Date("2026-09-27T10:01:00.000Z"),
        contentHash: "retained-newer-revision",
        metadataJson: "{}",
        active: true,
        reviewStatus: "linked",
        reviewedAt: new Date("2026-09-27T10:01:00.000Z"),
        reviewedBy: "founder-1",
        createdAt: new Date("2026-09-27T10:00:00.000Z"),
        updatedAt: new Date("2026-09-27T10:01:00.000Z"),
      } as never,
    });
    databaseMocks.getDb.mockResolvedValue(fixture.db);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return mockJsonResponse({ access_token: "mock-access-token" });
      }
      return mockJsonResponse({ files: [{
        id: "file-1",
        name: "Stale file metadata",
        mimeType: "application/pdf",
        modifiedTime: "2026-09-26T10:00:00.000Z",
        webViewLink: "https://drive.google.com/file/d/file-1/view",
        description: "Stale description",
        parents: [],
        size: "128",
      }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncWorkerGoogleEvidence(workerId, { gmail: false, drive: true });

    expect(result.drive).toMatchObject({ state: "synced", scanned: 1, imported: 0, linked: 0 });
    expect(fixture.writes.drive).toBe(0);
    const driveRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input)).hostname === "www.googleapis.com",
    );
    expect(driveRequests).toHaveLength(1);
    expect(driveRequests.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("does not count a Gmail item rejected by ownership checks as linked", async () => {
    const workerId = 713;
    const messageId = "mailbox-local-message-id";
    const receivedAt = new Date("2026-09-26T10:00:00.000Z");
    const settings = googleSyncSettings(workerId);
    const fixture = createMockGoogleEvidenceSyncDb(settings, {
      workerId,
      cards: [{
        cardId: "card-abc123",
        cardName: "Review case",
        cardUrl: "https://trello.com/c/card-abc123",
        boardName: "Work",
        listName: "To do",
      }],
      gmailExisting: {
        id: 83,
        vaId: 999,
        gmailMessageId: messageId,
        gmailThreadId: "other-worker-thread",
        subject: "Private other-worker message",
        fromAddress: "private@example.test",
        fromName: "Private sender",
        snippet: "Private other-worker content",
        receivedAt,
        category: "non_financial",
        status: "pending",
        deadlineAt: null,
        trelloCardId: null,
        trelloCardName: null,
        trelloCardUrl: null,
        suggestedNextAction: "Review the message",
        llmSummary: null,
        processedAt: null,
        archivedAt: null,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      } as never,
    });
    databaseMocks.getDb.mockResolvedValue(fixture.db);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return mockJsonResponse({ access_token: "mock-access-token" });
      }
      if (url.pathname.endsWith("/messages")) {
        return mockJsonResponse({ messages: [{ id: messageId, threadId: "thread-1" }] });
      }
      return mockJsonResponse({
        id: messageId,
        threadId: "thread-1",
        internalDate: String(receivedAt.getTime()),
        snippet: "Please review card-abc123",
        payload: { headers: [
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "Subject", value: "Case update" },
        ] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncWorkerGoogleEvidence(workerId, { gmail: true, drive: false });

    expect(result.gmail).toMatchObject({
      state: "synced",
      scanned: 1,
      imported: 0,
      linked: 0,
      sourceConflictCount: 1,
    });
    expect(fixture.writes.gmail).toBe(0);
    const gmailRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input)).hostname === "gmail.googleapis.com",
    );
    expect(gmailRequests).toHaveLength(2);
    expect(gmailRequests.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("Gmail reassessment queue", () => {
  beforeEach(() => {
    vi.mocked(enqueueManagerTask).mockClear();
  });

  it("queues unlinked Gmail revisions immediately and ignores identical retry snapshots", async () => {
    const tx = {} as never;
    expect(await enqueueGoogleGmailReassessment(tx, 12, "message-1", null, "revision-a")).toBe(true);
    expect(await enqueueGoogleGmailReassessment(tx, 12, "message-1", "revision-a", "revision-a")).toBe(false);
    expect(await enqueueGoogleGmailReassessment(tx, 12, "message-1", "revision-a", "revision-b")).toBe(true);
    expect(await enqueueGoogleGmailReassessment(tx, 12, "message-1", "revision-b", "revision-a")).toBe(true);

    const calls = vi.mocked(enqueueManagerTask).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe(tx);
    for (const [, event] of calls) expect(event).toMatchObject({
      vaId: 12,
      trigger: "source_ingested",
      eventKey: expect.stringMatching(/^google-gmail:message-1:/),
    });
    expect(new Set(calls.map(([, event]) => event.eventKey)).size).toBe(3);
  });

  it("reassesses pending unlinked mail and linked mail, but skips processed unlinked mail", () => {
    expect(gmailEvidenceNeedsReassessment(null, null)).toBe(true);
    expect(gmailEvidenceNeedsReassessment({ status: "pending", trelloCardId: null }, null)).toBe(true);
    expect(gmailEvidenceNeedsReassessment({ status: "processed", trelloCardId: null }, null)).toBe(false);
    expect(gmailEvidenceNeedsReassessment({ status: "archived", trelloCardId: "card-1" }, null)).toBe(true);
    expect(gmailEvidenceNeedsReassessment({ status: "processed", trelloCardId: null }, "card-1")).toBe(true);
  });

  it("skips reassessment when an unlinked incoming message is archived during import", () => {
    expect(gmailEvidenceNeedsReassessment(null, null, true)).toBe(false);
    expect(gmailEvidenceNeedsReassessment({ status: "pending", trelloCardId: null }, null, true)).toBe(false);
    expect(gmailEvidenceNeedsReassessment(null, "card-1", true)).toBe(true);
    expect(gmailEvidenceNeedsReassessment({ status: "pending", trelloCardId: "card-1" }, null, true)).toBe(true);
  });
});
