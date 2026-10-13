import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  hash: vi.fn(async () => "test-password-hash"),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("bcryptjs", () => ({ default: { hash: mocks.hash } }));

import { users, vaProfiles, workerInvitations } from "../drizzle/schema";
import {
  acceptWorkerInvitation,
  createWorkerInvitation,
  hashWorkerInvitationToken,
  WorkerInvitationError,
} from "./workerInvitations";

type InvitationFixture = {
  invitation: Record<string, unknown>;
  user: Record<string, unknown>;
  profile: Record<string, unknown>;
  lockWaitMs?: number;
};

function projectSelection(
  selection: Record<string, unknown>,
  fixture: InvitationFixture
) {
  const rows = new Map<unknown, Record<string, unknown>>([
    [workerInvitations, fixture.invitation],
    [users, fixture.user],
    [vaProfiles, fixture.profile],
  ]);
  return Object.fromEntries(
    Object.entries(selection).map(([key, rawColumn]) => {
      const column = rawColumn as { table?: unknown; name?: string };
      return [key, rows.get(column.table)?.[column.name ?? ""]];
    })
  );
}

function createAcceptanceDatabase(fixture: InvitationFixture, token: string) {
  const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  let transactionTail = Promise.resolve();

  const tx = {
    select: (selection: Record<string, unknown>) => {
      let source: unknown;
      let lockForUpdate = false;
      const query: any = {
        from: (table: unknown) => {
          source = table;
          return query;
        },
        innerJoin: () => query,
        where: () => query,
        limit: () => query,
        for: (strength: string) => {
          lockForUpdate = strength === "update";
          return query;
        },
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject: (error: unknown) => unknown
        ) => {
          const read = async () => {
            if (lockForUpdate && fixture.lockWaitMs)
              await new Promise(done => setTimeout(done, fixture.lockWaitMs));
            if (source !== workerInvitations) return [];
            if (
              fixture.invitation.tokenHash !==
                hashWorkerInvitationToken(token) ||
              fixture.invitation.acceptedAt != null ||
              fixture.invitation.revokedAt != null
            )
              return [];
            return [projectSelection(selection, fixture)];
          };
          return read().then(resolve, reject);
        },
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (rawValues: Record<string, unknown>) => ({
        where: async () => {
          const values = structuredClone(rawValues);
          let target: Record<string, unknown>;
          let eligible = false;
          if (table === workerInvitations) {
            target = fixture.invitation;
            eligible =
              target.acceptedAt == null &&
              target.revokedAt == null &&
              target.expiresAt instanceof Date &&
              values.acceptedAt instanceof Date &&
              target.expiresAt.getTime() > values.acceptedAt.getTime();
          } else if (table === users) {
            target = fixture.user;
            eligible =
              target.id === 42 &&
              target.openId === "worker@example.com" &&
              target.email === "worker@example.com" &&
              target.role === "worker" &&
              target.passwordHash == null;
          } else {
            target = fixture.profile;
            eligible =
              target.id === 21 &&
              target.userId === 42 &&
              target.founderId === 7 &&
              target.email === "worker@example.com" &&
              target.status === "inactive";
          }
          if (eligible) {
            Object.assign(target, values);
            writes.push({ table, values });
          }
          return [{ affectedRows: eligible ? 1 : 0 }];
        },
      }),
    }),
  };

  const db = {
    transaction: async (
      callback: (transaction: typeof tx) => Promise<unknown>
    ) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    },
  };
  return { db, fixture, writes };
}

function activeInvitationFixture(
  overrides: Partial<InvitationFixture> = {}
): InvitationFixture {
  const token = "single-use-invitation-token";
  return {
    invitation: {
      id: 77,
      userId: 42,
      vaId: 21,
      founderId: 7,
      email: "worker@example.com",
      tokenHash: hashWorkerInvitationToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    },
    user: {
      id: 42,
      openId: "worker@example.com",
      email: "worker@example.com",
      name: "Invited Worker",
      role: "worker",
      passwordHash: null,
    },
    profile: {
      id: 21,
      userId: 42,
      founderId: 7,
      email: "worker@example.com",
      status: "inactive",
    },
    ...overrides,
  };
}

describe("worker invitation trust boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue("test-password-hash");
  });

  it("creates only a worker account and binds the profile to the authenticated founder and created user", async () => {
    const inserted = new Map<unknown, Record<string, unknown>>();
    let nextId = 40;
    const makeInsert = (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.set(table, structuredClone(values));
        nextId += 1;
        const id = nextId;
        return { $returningId: async () => [{ id }] };
      },
    });
    const tx = { insert: makeInsert };
    const db = {
      select: () => {
        const query: any = {
          from: () => query,
          where: () => query,
          limit: () => query,
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return query;
      },
      insert: makeInsert,
      transaction: async (
        callback: (transaction: typeof tx) => Promise<unknown>
      ) => callback(tx),
    };
    mocks.getDb.mockResolvedValue(db);

    const input = {
      name: "Invited Worker",
      email: " Worker@Example.com ",
      role: "admin",
      userId: 1,
      vaId: 1,
      founderId: 999,
      token: "caller-controlled-token",
    } as unknown as Parameters<typeof createWorkerInvitation>[1];
    const result = await createWorkerInvitation(7, input);

    expect(inserted.get(users)).toMatchObject({
      openId: "worker@example.com",
      email: "worker@example.com",
      role: "worker",
      passwordHash: null,
    });
    expect(inserted.get(vaProfiles)).toMatchObject({
      userId: result.userId,
      founderId: 7,
      email: "worker@example.com",
      status: "inactive",
    });
    expect(inserted.get(workerInvitations)).toMatchObject({
      userId: result.userId,
      vaId: result.vaId,
      founderId: 7,
      email: "worker@example.com",
      tokenHash: hashWorkerInvitationToken(result.token),
    });
    expect(inserted.get(workerInvitations)?.tokenHash).not.toBe(result.token);
  });

  it("rejects invalid founder IDs before creating any invitation", async () => {
    await expect(
      createWorkerInvitation(0, { name: "Worker", email: "worker@example.com" })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["administrator role", { user: { role: "admin" } }],
    ["changed login identity", { user: { openId: "other@example.com" } }],
    ["changed account email", { user: { email: "other@example.com" } }],
    ["changed profile owner", { profile: { userId: 84 } }],
    ["changed founder assignment", { profile: { founderId: 99 } }],
    ["already active profile", { profile: { status: "active" } }],
    [
      "account with an existing password",
      { user: { passwordHash: "already-set" } },
    ],
  ])("refuses acceptance after %s changes", async (_label, changes) => {
    const token = "single-use-invitation-token";
    const fixture = activeInvitationFixture({
      user: { ...activeInvitationFixture().user, ...changes.user },
      profile: { ...activeInvitationFixture().profile, ...changes.profile },
    });
    const fake = createAcceptanceDatabase(fixture, token);
    mocks.getDb.mockResolvedValue(fake.db);

    await expect(
      acceptWorkerInvitation(token, "long-enough-password")
    ).rejects.toBeInstanceOf(WorkerInvitationError);
    expect(fake.writes).toHaveLength(0);
  });

  it("checks expiry after a simulated row-lock wait", async () => {
    const token = "single-use-invitation-token";
    const fixture = activeInvitationFixture({
      invitation: {
        ...activeInvitationFixture().invitation,
        expiresAt: new Date(Date.now() + 10),
      },
      lockWaitMs: 30,
    });
    const fake = createAcceptanceDatabase(fixture, token);
    mocks.getDb.mockResolvedValue(fake.db);

    await expect(
      acceptWorkerInvitation(token, "long-enough-password")
    ).rejects.toMatchObject({ code: "invalid" });
    expect(fake.writes).toHaveLength(0);
  });

  it("allows exactly one acceptance when the same one-time token is replayed concurrently", async () => {
    const token = "single-use-invitation-token";
    const fake = createAcceptanceDatabase(activeInvitationFixture(), token);
    mocks.getDb.mockResolvedValue(fake.db);

    const results = await Promise.allSettled([
      acceptWorkerInvitation(token, "long-enough-password"),
      acceptWorkerInvitation(token, "long-enough-password"),
    ]);

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    expect(
      fake.writes.filter(write => write.table === workerInvitations)
    ).toHaveLength(1);
    expect(fake.fixture.profile.status).toBe("active");
  });
});
