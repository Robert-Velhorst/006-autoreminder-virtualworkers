import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import * as schema from "../drizzle/schema.postgres";
import { retainGoogleDriveEvidenceRecord, retainGmailEvidenceRecord } from "./googleEvidence";

const databaseUrl = process.env.APTLSS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Gmail evidence PostgreSQL ownership regressions",
  { timeout: 30_000 },
  () => {
    let pool: Pool | undefined;
    let lock: PoolClient | undefined;
    let lockName: string | undefined;
    let db: NodePgDatabase<typeof schema> | undefined;
    const messageIds: string[] = [];
    const evidenceSourceIds: string[] = [];
    const workerIds: number[] = [];

    beforeAll(async () => {
      const target = new URL(requireIsolatedPostgresTestDatabase(databaseUrl, process.env.NODE_ENV === "production"));
      pool = new Pool({ connectionString: databaseUrl!, max: 8, connectionTimeoutMillis: 10_000, });
      db = drizzle(pool, { schema });
      const { rows: identity } = await pool.query("SELECT current_database() AS name, current_setting('server_version') AS version");
      expect(identity[0]?.name).toBe(target.pathname.slice(1));
      expect(identity[0]?.version).toMatch(/^18\./);

      lock = await pool.connect();
      lockName = `google-evidence-${randomUUID().replaceAll("-", "")}`;
      const { rows: lockRows } = await lock.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);

    });

    afterEach(async () => {
      if (!db) return;
      const ownedIds = messageIds.splice(0);
      if (ownedIds.length) {
        await db.delete(schema.emailTasks).where(inArray(schema.emailTasks.gmailMessageId, ownedIds));
      }
      const ownedSources = evidenceSourceIds.splice(0);
      if (ownedSources.length) {
        await db.delete(schema.workspaceEvidenceItems).where(inArray(schema.workspaceEvidenceItems.sourceId, ownedSources));
      }
      const ownedWorkers = workerIds.splice(0);
      if (ownedWorkers.length) {
        await db.delete(schema.users).where(inArray(schema.users.id, ownedWorkers));
      }
    });

    afterAll(async () => {
      if (lock) {
        if (lockName) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
        lock.release();
      }
      if (pool) await pool.end();
    });

    it("keeps the first worker's row and content when two workers import the same new Gmail ID", async () => {
      for (let round = 0; round < 6; round++) {
        const gmailMessageId = `google-evidence-it-${randomUUID()}`;
        messageIds.push(gmailMessageId);
        const attempts = [
          { vaId: 2_000_001 + round * 2, snippet: `worker-a-${round}` },
          { vaId: 2_000_002 + round * 2, snippet: `worker-b-${round}` },
        ];
        const valuesFor = (attempt: typeof attempts[number]) => ({
          vaId: attempt.vaId,
          gmailMessageId,
          gmailThreadId: `thread-${gmailMessageId}`,
          subject: `Subject from ${attempt.snippet}`,
          fromAddress: `${attempt.snippet}@example.test`,
          fromName: attempt.snippet,
          snippet: attempt.snippet,
          receivedAt: new Date("2026-09-26T10:00:00.000Z"),
          category: "non_financial" as const,
          status: "pending" as const,
          deadlineAt: null,
          trelloCardId: null,
          trelloCardName: null,
          trelloCardUrl: null,
          suggestedNextAction: "Review the message",
          llmSummary: null,
        });

        const results = await Promise.all(attempts.map((attempt) =>
          db!.transaction((tx) => retainGmailEvidenceRecord(tx, valuesFor(attempt)))
        ));
        const acceptedAttempts = attempts.filter((_, index) => results[index]?.retained);
        expect(acceptedAttempts).toHaveLength(1);

        const [retained] = await db!.select().from(schema.emailTasks)
          .where(eq(schema.emailTasks.gmailMessageId, gmailMessageId)).limit(1);
        expect(retained).toMatchObject({
          vaId: acceptedAttempts[0]!.vaId,
          snippet: acceptedAttempts[0]!.snippet,
          subject: `Subject from ${acceptedAttempts[0]!.snippet}`,
        });

        const thirdWorker = await db!.transaction((tx) =>
          retainGmailEvidenceRecord(tx, valuesFor({ vaId: 2_100_000 + round, snippet: `third-${round}` }))
        );
        expect(thirdWorker.retained).toBe(false);
        const [afterRejectedImport] = await db!.select().from(schema.emailTasks)
          .where(eq(schema.emailTasks.gmailMessageId, gmailMessageId)).limit(1);
        expect(afterRejectedImport).toMatchObject({
          vaId: acceptedAttempts[0]!.vaId,
          snippet: acceptedAttempts[0]!.snippet,
        });
      }
    });

    it("serializes concurrent Drive first imports and refuses to replace unversioned retained content", async () => {
      const openId = `google-evidence-drive-it-${randomUUID()}`;
      const [createdWorker] = await db!.insert(schema.users).values({ openId, role: "worker" }).returning();
      workerIds.push(createdWorker.id);

      const fileId = randomUUID();
      const sourceId = `${createdWorker.id}:${fileId}`;
      evidenceSourceIds.push(sourceId);
      const olderModifiedAt = new Date("2026-09-26T10:00:00.000Z");
      const newerModifiedAt = new Date("2026-09-26T10:01:00.000Z");
      const valuesFor = (revision: "older" | "newer") => {
        const modifiedAt = revision === "older" ? olderModifiedAt : newerModifiedAt;
        return {
          vaId: createdWorker.id,
          source: "google_drive" as const,
          sourceId,
          sourceContainerId: `worker:${createdWorker.id}`,
          kind: "file",
          title: `${revision} Drive metadata`,
          summary: "Integration fixture",
          content: `${revision} description`,
          sourceUrl: `https://drive.google.com/file/d/${fileId}/view`,
          mimeType: "application/pdf",
          modifiedAt,
          observedAt: modifiedAt,
          contentHash: `${revision}-hash-${randomUUID()}`,
          metadataJson: JSON.stringify({ fileId, revision }),
          active: true,
        };
      };

      await Promise.all(["older", "newer"].map((revision) =>
        db!.transaction((tx) => retainGoogleDriveEvidenceRecord(tx, valuesFor(revision as "older" | "newer")))
      ));

      const rows = await db!.select().from(schema.workspaceEvidenceItems).where(and(
        eq(schema.workspaceEvidenceItems.vaId, createdWorker.id),
        eq(schema.workspaceEvidenceItems.sourceId, sourceId),
      ));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        modifiedAt: newerModifiedAt,
        title: "newer Drive metadata",
        content: "newer description",
      });

      const legacySourceId = `${createdWorker.id}:${randomUUID()}`;
      evidenceSourceIds.push(legacySourceId);
      const legacyValues = {
        ...valuesFor("older"),
        sourceId: legacySourceId,
        title: "Unversioned retained metadata",
        content: "Do not replace without a comparable source revision",
        modifiedAt: null,
        contentHash: "legacy-unversioned-hash",
      };
      await db!.insert(schema.workspaceEvidenceItems).values(legacyValues);
      await expect(db!.transaction((tx) => retainGoogleDriveEvidenceRecord(tx, {
        ...legacyValues,
        title: "Unverifiable incoming metadata",
        content: "Potentially stale incoming content",
        modifiedAt: newerModifiedAt,
        contentHash: "incoming-versioned-hash",
      }))).rejects.toThrow("without a provably newer modification time");

      const [legacyAfterRejectedRevision] = await db!.select().from(schema.workspaceEvidenceItems).where(and(
        eq(schema.workspaceEvidenceItems.vaId, createdWorker.id),
        eq(schema.workspaceEvidenceItems.sourceId, legacySourceId),
      ));
      expect(legacyAfterRejectedRevision).toMatchObject({
        title: "Unversioned retained metadata",
        content: "Do not replace without a comparable source revision",
        modifiedAt: null,
        contentHash: "legacy-unversioned-hash",
      });
    });
  }
);
