import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool, escapeIdentifier, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema.postgres";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import { COOKIE_NAME } from "../shared/const";

const controls = vi.hoisted(() => ({ db: undefined as any, sessionSecret: crypto.randomUUID() + crypto.randomUUID() }));
vi.mock("./db", () => ({ getDb: async () => controls.db, isSessionRevoked: async () => false }));
vi.mock("./_core/env", () => ({ ENV: { cookieSecret: controls.sessionSecret, oAuthServerUrl: "", appId: "" } }));
import { sdk } from "./_core/sdk";
import { createWorkerInvitation, acceptWorkerInvitation } from "./workerInvitations";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("worker session lifecycle full-migration PostgreSQL", { timeout: 30_000 }, () => {
  let admin: Pool;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let baseline: string;
  const name = `worker_session_${randomUUID().replaceAll("-", "")}`;
  const canonical = path.resolve(import.meta.dirname, "../drizzle-postgres-v1");
  const owned = () => {
    if (!/^worker_session_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe private database identity");
  };
  beforeAll(async () => {
    const fixture = new URL(requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production"));
    owned();
    admin = new Pool({ connectionString: fixture.href, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    fixture.pathname = `/${name}`;
    pool = new Pool({ connectionString: fixture.href, max: 6, connectionTimeoutMillis: 5000 });
    db = drizzle(pool, { schema }); controls.db = db;
    const journal = JSON.parse(await readFile(path.join(canonical, "meta/_journal.json"), "utf8"));
    const previous = journal.entries.filter((entry: { idx: number }) => entry.idx < 6);
    baseline = await mkdtemp(path.join(tmpdir(), "worker-session-migrations-"));
    await mkdir(path.join(baseline, "meta"));
    await writeFile(path.join(baseline, "meta/_journal.json"), JSON.stringify({ ...journal, entries: previous }));
    for (const entry of previous) await copyFile(path.join(canonical, `${entry.tag}.sql`), path.join(baseline, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: baseline });
    await pool.query(`INSERT INTO users (id,"openId",name,role) VALUES
      (90001,'legacy-founder','Founder','admin'),(90002,'legacy-worker','Worker','worker'),(90003,'legacy-reused','Worker','worker')`);
    await pool.query(`INSERT INTO va_profiles ("userId","founderId",name,email,status)
      VALUES (90002,90001,'Worker','legacy@example.invalid','active')`);
    await migrate(db, { migrationsFolder: canonical });
    vi.stubEnv("SESSION_APP_ID", "va-dashboard");
    vi.stubEnv("LOCAL_AUTH_BYPASS", "false");
  }, 125_000);
  afterAll(async () => {
    controls.db = undefined; vi.unstubAllEnvs();
    try {
      if (pool) await pool.end();
      if (admin) { owned(); await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`); }
    } finally {
      if (admin) await admin.end();
      if (baseline) await rm(baseline, { recursive: true, force: true });
    }
  });
  const read = async (id: number) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0];
  const req = (token: string) => ({ headers: { cookie: `${COOKIE_NAME}=${token}` }, socket: {}, hostname: "dashboard.example" }) as Request;
  const legacy = (openId: string) => new SignJWT({ openId, appId: "va-dashboard", name: "Worker" })
    .setProtectedHeader({ alg: "HS256" }).setJti(randomUUID()).setExpirationTime("1h")
    .sign(new TextEncoder().encode(controls.sessionSecret));
  async function worker() {
    const [user] = await db.insert(schema.users).values({ openId: `worker-${randomUUID()}`, role: "worker", name: "Worker" }).returning();
    const [profile] = await db.insert(schema.vaProfiles).values({ userId: user.id, founderId: 90001, name: "Worker", email: `${user.id}@example.invalid`, status: "active" }).returning();
    return { user: await read(user.id), profile };
  }

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }

  async function backendPid(client: PoolClient) {
    return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  }

  async function awaitBlocking(observer: PoolClient, waiter: number, blocker: number) {
    const deadline = performance.now() + 8_000;
    // Synchronize on PostgreSQL's actual lock graph, not elapsed time or task start order.
    while (performance.now() < deadline) {
      const result = await observer.query<{ blocked: boolean }>({
        text: "SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked",
        values: [blocker, waiter],
        query_timeout: 1_000,
      });
      if (result.rows[0].blocked) return;
    }
    throw new Error("Expected PostgreSQL lock barrier was not observed");
  }

  function mintObserved(user: typeof schema.users.$inferSelect) {
    return sdk.createSessionToken(user.openId, {
      name: "Worker", expectedIdentity: { userId: user.id, sessionEpoch: user.sessionEpoch },
    }).then(token => ({ ok: true as const, token }), error => ({ ok: false as const, error }));
  }

  it("rejects the old credential proof when password reset commits before a blocked mint", async () => {
    const { user } = await worker();
    const clients: PoolClient[] = [];
    let reset: PoolClient | undefined;
    let resetTransaction = false;
    let mint: ReturnType<typeof mintObserved> | undefined;
    try {
      reset = await pool.connect(); clients.push(reset);
      const signer = await pool.connect(); clients.push(signer);
      const observer = await pool.connect(); clients.push(observer);
      const resetPid = await backendPid(reset), signerPid = await backendPid(signer);
      await signer.query("SET statement_timeout = '10s'");
      await reset.query("BEGIN"); resetTransaction = true;
      await reset.query('UPDATE users SET "passwordHash" = $1 WHERE id = $2', ["synthetic-reset-wins", user.id]);
      controls.db = drizzle(signer, { schema });
      mint = mintObserved(user);
      await awaitBlocking(observer, signerPid, resetPid);
      await reset.query("COMMIT"); resetTransaction = false;
      const outcome = await mint;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ statusCode: 403 });
      expect((await read(user.id)).sessionEpoch).toBe((BigInt(user.sessionEpoch) + 1n).toString());
    } finally {
      controls.db = db;
      try {
        if (resetTransaction && reset) await reset.query("ROLLBACK");
      } finally {
        try { if (mint) await mint; }
        finally { for (const client of clients) client.release(true); }
      }
    }
  });

  it("holds the old epoch through signing and rejects its JWT after a blocked password reset commits", async () => {
    const { user } = await worker();
    const clients: PoolClient[] = [];
    const signing = gate(), resumeSigning = gate();
    const actualSign = SignJWT.prototype.sign;
    let restoreSign: (() => void) | undefined;
    let reset: PoolClient | undefined;
    let resetTransaction = false;
    let mint: ReturnType<typeof mintObserved> | undefined;
    let update: Promise<void> | undefined;
    try {
      const signer = await pool.connect(); clients.push(signer);
      reset = await pool.connect(); clients.push(reset);
      const observer = await pool.connect(); clients.push(observer);
      const signerPid = await backendPid(signer), resetPid = await backendPid(reset);
      await signer.query("SET statement_timeout = '10s'");
      await reset.query("BEGIN"); resetTransaction = true;
      await reset.query("SET LOCAL statement_timeout = '10s'");
      const signSpy = vi.spyOn(SignJWT.prototype, "sign").mockImplementation(async function (this: SignJWT, ...args: Parameters<SignJWT["sign"]>) {
        signing.release();
        await resumeSigning.promise;
        return actualSign.apply(this, args);
      });
      restoreSign = () => signSpy.mockRestore();
      controls.db = drizzle(signer, { schema });
      mint = mintObserved(user);
      await Promise.race([signing.promise, mint.then(() => { throw new Error("Mint settled before the signing barrier"); })]);
      // Capture rejection immediately, including when an assertion fails before awaiting the update.
      let updateError: unknown;
      update = reset.query('UPDATE users SET "passwordHash" = $1 WHERE id = $2', ["synthetic-mint-wins", user.id])
        .then(() => undefined, error => { updateError = error; });
      await awaitBlocking(observer, resetPid, signerPid);
      resumeSigning.release();
      const outcome = await mint;
      expect(outcome.ok).toBe(true);
      await update;
      if (updateError) throw updateError;
      await reset.query("COMMIT"); resetTransaction = false;
      controls.db = db;
      if (!outcome.ok) throw outcome.error;
      const decoded = await sdk.verifySession(outcome.token);
      expect(decoded).toMatchObject({ userId: user.id, sessionEpoch: user.sessionEpoch });
      const afterReset = await read(user.id);
      expect(afterReset.sessionEpoch).toBe((BigInt(user.sessionEpoch) + 1n).toString());
      expect(decoded!.sessionEpoch).not.toBe(afterReset.sessionEpoch);
      await expect(sdk.authenticateRequest(req(outcome.token))).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      resumeSigning.release();
      controls.db = db;
      try {
        if (mint) await mint;
        if (update) await update;
      } finally {
        restoreSign?.();
        try { if (resetTransaction && reset) await reset.query("ROLLBACK"); }
        finally { for (const client of clients) client.release(true); }
      }
    }
  });

  it("preserves existing zero epochs and migration reruns without altering identities", async () => {
    expect((await read(90002)).sessionEpoch).toBe("0");
    await expect(sdk.authenticateRequest(req(await legacy("legacy-worker")))).resolves.toMatchObject({ id: 90002 });
    await migrate(db, { migrationsFolder: canonical });
    expect((await read(90002)).sessionEpoch).toBe("0");
    expect((await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].count).toBe(138);
  });
  it("defaults/clamps NEW accounts to one and prevents legacy openId delete/recreate revival", async () => {
    const old = await legacy("legacy-reused");
    await db.delete(schema.users).where(eq(schema.users.id, 90003));
    const [recreated] = await db.insert(schema.users).values({ openId: "legacy-reused", role: "admin", sessionEpoch: "0" }).returning();
    expect(recreated.id).not.toBe(90003);
    expect(recreated.sessionEpoch).toBe("1");
    await expect(sdk.authenticateRequest(req(old))).rejects.toMatchObject({ statusCode: 403 });
    const [fresh] = await db.insert(schema.users).values({ openId: `new-${randomUUID()}`, role: "admin" }).returning();
    expect(fresh.sessionEpoch).toBe("1");
  });
  it("invalidates direct SQL password/openId/role changes but not ordinary user updates", async () => {
    const { user } = await worker();
    const token = await sdk.createSessionToken(user.openId, { name: "Worker" });
    await db.update(schema.users).set({ name: "Renamed" }).where(eq(schema.users.id, user.id));
    expect((await read(user.id)).sessionEpoch).toBe(user.sessionEpoch);
    for (const change of [{ passwordHash: "synthetic-hash" }, { openId: `renamed-${randomUUID()}` },
      { email: "changed@example.invalid" }, { loginMethod: "trello" }, { role: "user" as const }]) {
      const before = await read(user.id);
      await db.update(schema.users).set(change).where(eq(schema.users.id, user.id));
      expect(BigInt((await read(user.id)).sessionEpoch)).toBe(BigInt(before.sessionEpoch) + 1n);
    }
    await expect(sdk.authenticateRequest(req(token))).rejects.toMatchObject({ statusCode: 403 });
  });
  it("invalidates status/identity changes and old tokens stay revoked after reactivation", async () => {
    const { user, profile } = await worker();
    const token = await sdk.createSessionToken(user.openId, { name: "Worker" });
    for (const change of [{ status: "inactive" as const }, { status: "active" as const },
      { trelloMemberId: "new-member" }, { founderId: 90002 }]) {
      const before = await read(user.id);
      await db.update(schema.vaProfiles).set(change).where(eq(schema.vaProfiles.id, profile.id));
      expect(BigInt((await read(user.id)).sessionEpoch)).toBe(BigInt(before.sessionEpoch) + 1n);
    }
    await expect(sdk.authenticateRequest(req(token))).rejects.toMatchObject({ statusCode: 403 });
    await expect(sdk.authenticateRequest(req(await sdk.createSessionToken(user.openId, { name: "Worker" })))).resolves.toMatchObject({ id: user.id });
  });
  it("fences relinking/deletion and denies ambiguous or missing profiles globally", async () => {
    const a = await worker(), b = await worker();
    const beforeA = a.user.sessionEpoch, beforeB = b.user.sessionEpoch;
    await db.update(schema.vaProfiles).set({ userId: b.user.id }).where(eq(schema.vaProfiles.id, a.profile.id));
    expect(BigInt((await read(a.user.id)).sessionEpoch)).toBe(BigInt(beforeA) + 1n);
    expect(BigInt((await read(b.user.id)).sessionEpoch)).toBe(BigInt(beforeB) + 1n);
    for (const user of [a.user, b.user]) await expect(sdk.createSessionToken(user.openId, { name: "Worker" })).rejects.toMatchObject({ statusCode: 403 });
    await db.delete(schema.vaProfiles).where(eq(schema.vaProfiles.id, a.profile.id));
    await expect(sdk.createSessionToken(b.user.openId, { name: "Worker" })).resolves.toEqual(expect.any(String));
  });
  it("rejects stale credential proofs and non-monotonic/overflow writes without resetting audit", async () => {
    const { user } = await worker();
    await db.update(schema.users).set({ passwordHash: "rotated" }).where(eq(schema.users.id, user.id));
    await expect(sdk.createSessionToken(user.openId, { name: "Worker", expectedIdentity: { userId: user.id, sessionEpoch: user.sessionEpoch } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(db.update(schema.users).set({ sessionEpoch: "0" }).where(eq(schema.users.id, user.id))).rejects.toThrow();
    await db.update(schema.users).set({ sessionEpoch: "9007199254740993" }).where(eq(schema.users.id, user.id));
    const exactToken = await sdk.createSessionToken(user.openId, { name: "Worker" });
    expect((await sdk.verifySession(exactToken))?.sessionEpoch).toBe("9007199254740993");
    expect(JSON.stringify(await read(user.id))).toContain('"9007199254740993"');
    await db.update(schema.users).set({ sessionEpoch: "9223372036854775807" }).where(eq(schema.users.id, user.id));
    await expect(db.update(schema.users).set({ passwordHash: "overflow" }).where(eq(schema.users.id, user.id))).rejects.toThrow();
    expect((await read(user.id)).sessionEpoch).toBe("9223372036854775807");
    expect((await read(user.id)).passwordHash).toBe("rotated");
  });
  it("rolls back trigger invalidation together with lifecycle state and audit", async () => {
    const { user, profile } = await worker();
    await expect(db.transaction(async tx => {
      await tx.update(schema.vaProfiles).set({ status: "inactive" }).where(eq(schema.vaProfiles.id, profile.id));
      await tx.insert(schema.workerLifecycleAudit).values({ actorUserId: 90001, userId: user.id, founderId: 90001, workerProfileId: profile.id, action: "offboard", previousStatus: "active", nextStatus: "inactive" });
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    expect((await read(user.id)).sessionEpoch).toBe(user.sessionEpoch);
    expect(await db.select().from(schema.workerLifecycleAudit).where(eq(schema.workerLifecycleAudit.userId, user.id))).toEqual([]);
  });
  it("audits invitation creation/activation atomically and returns the post-trigger proof", async () => {
    const invitation = await createWorkerInvitation(90001, { name: "Invitee", email: `invite-${randomUUID().slice(0, 8)}@example.invalid` });
    const accepted = await acceptWorkerInvitation(invitation.token, "synthetic-long-password");
    const account = await read(accepted.userId);
    expect(accepted.sessionEpoch).toBe(account.sessionEpoch);
    const audit = await db.select().from(schema.workerLifecycleAudit).where(eq(schema.workerLifecycleAudit.userId, account.id));
    expect(audit).toEqual([
      expect.objectContaining({ actorUserId: 90001, action: "create", previousStatus: null, nextStatus: "inactive" }),
      expect.objectContaining({ actorUserId: account.id, action: "reactivate", previousStatus: "inactive", nextStatus: "active" }),
    ]);
    await expect(sdk.createSessionToken(account.openId, { name: "Invitee", expectedIdentity: { userId: account.id, sessionEpoch: accepted.sessionEpoch } })).resolves.toEqual(expect.any(String));
  });
  it("rolls back invitation creation and acceptance if their required audit cannot persist", async () => {
    const invitation = await createWorkerInvitation(90001, { name: "Invitee", email: `rollback-${randomUUID().slice(0, 8)}@example.invalid` });
    const before = await read(invitation.userId);
    await pool.query(`CREATE FUNCTION reject_session_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit unavailable'; END; $$;
      CREATE TRIGGER reject_session_test_audit BEFORE INSERT ON worker_lifecycle_audit
      FOR EACH ROW EXECUTE FUNCTION reject_session_test_audit()`);
    const email = `failed-${randomUUID().slice(0, 8)}@example.invalid`;
    try {
      await expect(createWorkerInvitation(90001, { name: "Failed", email })).rejects.toThrow();
      expect(await db.select().from(schema.users).where(eq(schema.users.openId, email))).toEqual([]);
      await expect(acceptWorkerInvitation(invitation.token, "synthetic-long-password")).rejects.toThrow();
      expect(await read(invitation.userId)).toEqual(before);
      expect((await db.select().from(schema.vaProfiles).where(eq(schema.vaProfiles.id, invitation.vaId)))[0].status).toBe("inactive");
      expect((await db.select().from(schema.workerInvitations).where(eq(schema.workerInvitations.id, invitation.invitationId)))[0].acceptedAt).toBeNull();
    } finally {
      await pool.query("DROP TRIGGER reject_session_test_audit ON worker_lifecycle_audit; DROP FUNCTION reject_session_test_audit()");
    }
  });
});
