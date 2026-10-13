import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("manager review index migration on real MySQL", () => {
  it("preserves snapshots, supports legacy and new writes, and replays safely", async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !['/recovery_test', '/aptlss_test'].includes(target.pathname)) throw new Error("Dedicated local test DB required");
    const db = await mysql.createConnection(url!);
    const table = `review_index_test_${randomBytes(8).toString('hex')}`;
    try {
      await db.query(`CREATE TABLE \`${table}\` (id int PRIMARY KEY AUTO_INCREMENT, vaId int NOT NULL, proposalHash varchar(64), mode enum('shadow','active'), createdAt timestamp DEFAULT CURRENT_TIMESTAMP, snapshotJson longtext NOT NULL)`);
      const snapshot = JSON.stringify({ implementationDigest: 'a'.repeat(64), interventions: [{ severity: 'urgent' }], evidence: 'retained '.repeat(10000) });
      await db.query(`INSERT INTO \`${table}\` (vaId, proposalHash, mode, snapshotJson) VALUES (2, 'proposal', 'shadow', ?)`, [snapshot]);
      const migration = readFileSync(new URL('../drizzle/0046_manager_review_index.sql', import.meta.url), 'utf8').replaceAll('aptlss_manager_runs', table);
      for (let replay = 0; replay < 2; replay++) {
        for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await db.query(statement);
      }
      const [rows] = await db.query<any[]>(`SELECT snapshotJson, reviewDigest, reviewUrgent FROM \`${table}\``);
      expect(rows[0]).toEqual({ snapshotJson: snapshot, reviewDigest: 'a'.repeat(64), reviewUrgent: 1 });
      await db.query(`INSERT INTO \`${table}\` (vaId, proposalHash, mode, snapshotJson) VALUES (3, 'proposal', 'shadow', ?)`, [JSON.stringify({ interventions: [] })]);
      const [legacy] = await db.query<any[]>(`SELECT reviewDigest, reviewUrgent FROM \`${table}\` WHERE vaId=3`);
      expect(legacy[0]).toEqual({ reviewDigest: null, reviewUrgent: 0 });
      const [plan] = await db.query<any[]>(`EXPLAIN SELECT proposalHash, MAX(reviewUrgent) FROM \`${table}\` WHERE vaId=2 AND reviewDigest=? GROUP BY proposalHash`, ['a'.repeat(64)]);
      expect(plan[0].key).toBe(`${table}_review_idx`);
      expect(plan[0].Extra).toContain('Using index');
    } finally {
      await db.query(`DROP TABLE IF EXISTS \`${table}\``);
      await db.end();
    }
  }, 30000);
});
