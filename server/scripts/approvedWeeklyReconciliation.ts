import { createHash } from 'node:crypto';
import type mysql from 'mysql2';
import type { Client } from 'pg';
import { quoteMySqlIdentifier } from './mysqlPostgresTransferCore';

type RawRow = Record<string, string | null>;
export type WeeklyReconciliationPlan = {
  version: 1;
  approval: string;
  sourceBackupSha256: string;
  ownerId: string;
  workerId: string;
  currency: 'EUR';
  amount: string;
  originals: RawRow[];
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sorted(row: RawRow): RawRow {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

// The retained ID is a reference anchor, not a choice of financial authority.
// All original fields are preserved in the restricted migration audit schema.
export function reconcileWeeklyRows(plan: WeeklyReconciliationPlan, actual: RawRow[]) {
  if (plan.version !== 1 || plan.currency !== 'EUR' || !/^[a-f0-9]{64}$/.test(plan.sourceBackupSha256)
    || typeof plan.approval !== 'string' || plan.approval.trim().length < 20
    || !/^[1-9]\d*$/.test(plan.ownerId) || !/^[1-9]\d*$/.test(plan.workerId)
    || plan.ownerId === plan.workerId || !/^\d+\.\d{2}$/.test(plan.amount)
    || BigInt(plan.amount.replace('.', '')) <= 0n || !Array.isArray(plan.originals)
    || plan.originals.length < 2 || plan.originals.length > 20) {
    throw new Error('Invalid explicitly approved weekly reconciliation');
  }
  const originals = plan.originals;
  if (originals.some(r => Object.values(r).some(v => v !== null && typeof v !== 'string'))
    || new Set(originals.map(r => r.id)).size !== originals.length
    || originals.some(r => !/^[1-9]\d*$/.test(r.id ?? ''))) throw new Error('Invalid original financial rows');
  const ordered = (rows: RawRow[]) => rows.map(sorted).sort((a, b) => BigInt(a.id!) < BigInt(b.id!) ? -1 : 1);
  if (fingerprint(ordered(originals)) !== fingerprint(ordered(actual))) throw new Error('Financial source changed since approval');
  const fields = Object.keys(originals[0]!);
  if (originals.some(r => Object.keys(r).length !== fields.length
    || fields.some(k => !Object.hasOwn(r, k)
      || (!['id', 'createdAt', 'updatedAt'].includes(k) && r[k] !== originals[0]![k])))) {
    throw new Error('Financial rows are not identical business records');
  }
  const first = ordered(originals)[0]!;
  if (first.vaId !== plan.workerId || first.paymentCycleId !== null || first.notes !== null
    || first.baseAmount !== plan.amount || first.projectedPay !== plan.amount
    || first.totalMerits !== '0.00' || first.totalDemerits !== '0.00'
    || fields.filter(k => /^(merit|demerit)/.test(k)).some(k => first[k] !== '0.00')
    || !/^\d{4}-\d{2}-\d{2}$/.test(first.weekStart ?? '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(first.weekEnd ?? '')) throw new Error('Financial meaning differs from approval');
  const canonical: RawRow = { ...first, founderId: plan.ownerId,
    notes: `Owner-confirmed historical weekly allowance: ${plan.currency} ${plan.amount}. Original records retained in migration audit.` };
  return { canonical, originals: ordered(originals), planSha256: fingerprint(plan) };
}

export async function prepareApprovedWeeklySource(source: mysql.Connection, plan: WeeklyReconciliationPlan) {
  reconcileWeeklyRows(plan, plan.originals);
  const query = async (sql: string, args: unknown[] = []) => {
    const [rows] = await source.promise().query<mysql.RowDataPacket[]>(sql, args);
    return rows;
  };
  const columns = await query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='weekly_pay_log' ORDER BY ORDINAL_POSITION");
  if (!columns.length) throw new Error('Missing financial source schema');
  const names = columns.map(c => String(c.name));
  const fields = names.map(c => `CAST(${quoteMySqlIdentifier(c)} AS CHAR) AS ${quoteMySqlIdentifier(c)}`).join(',');
  const ids = plan.originals.map(r => r.id);
  const raw = await query(`SELECT ${fields} FROM weekly_pay_log WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
  const result = reconcileWeeklyRows(plan, raw as RawRow[]);
  const users = await query('SELECT id, role FROM users WHERE id IN (?,?) ORDER BY id', [plan.ownerId, plan.workerId]);
  if (!users.some(u => String(u.id) === plan.ownerId && u.role === 'admin')
    || !users.some(u => String(u.id) === plan.workerId && u.role === 'worker')) throw new Error('Approved financial identities do not match source accounts');
  // Refuse to redirect any linked history implicitly, including unconstrained links.
  const refs = await query(`SELECT DISTINCT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
    FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='weeklyPayLogId'
    UNION SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.key_column_usage
    WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='weekly_pay_log'`);
  for (const ref of refs) {
    const links = await query(`SELECT COUNT(*) AS n FROM ${quoteMySqlIdentifier(String(ref.tableName))}
      WHERE ${quoteMySqlIdentifier(String(ref.columnName))} IN (${ids.map(() => '?').join(',')})`, ids);
    if (String(links[0]?.n) !== '0') throw new Error('Financial reconciliation has linked history requiring separate review');
  }
  const collision = await query('SELECT COUNT(*) AS n FROM weekly_pay_log WHERE founderId=? AND vaId=? AND weekStart=? AND id NOT IN (' + ids.map(() => '?').join(',') + ')',
    [plan.ownerId, plan.workerId, result.canonical.weekStart, ...ids]);
  if (String(collision[0]?.n) !== '0') throw new Error('Approved financial destination already exists');
  // Session-local temporary tables may be written in MySQL READ ONLY transactions.
  // Never update or delete a permanent source row, or disable constraints.
  await query('CREATE TEMPORARY TABLE va_reviewed_weekly LIKE weekly_pay_log');
  await query('INSERT INTO va_reviewed_weekly SELECT * FROM weekly_pay_log');
  await query(`DELETE FROM va_reviewed_weekly WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  await query(`INSERT INTO va_reviewed_weekly (${names.map(quoteMySqlIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`, names.map(n => result.canonical[n]));
  // Avoid ALTER/RENAME TABLE, which can implicitly commit the consistent snapshot.
  await query('CREATE TEMPORARY TABLE weekly_pay_log LIKE va_reviewed_weekly');
  await query('INSERT INTO weekly_pay_log SELECT * FROM va_reviewed_weekly');
  await query('DROP TEMPORARY TABLE va_reviewed_weekly');
  return { ...result, plan };
}

export async function archiveApprovedWeeklySource(target: Client, result: Awaited<ReturnType<typeof prepareApprovedWeeklySource>>) {
  await target.query('CREATE SCHEMA IF NOT EXISTS migration_audit');
  await target.query('REVOKE ALL ON SCHEMA migration_audit FROM PUBLIC');
  await target.query(`CREATE TABLE IF NOT EXISTS migration_audit.approved_weekly_reconciliations (
    plan_sha256 text PRIMARY KEY, recorded_at timestamptz NOT NULL DEFAULT now(),
    approval jsonb NOT NULL, original_rows jsonb NOT NULL, canonical_row jsonb NOT NULL)`);
  await target.query('REVOKE ALL ON migration_audit.approved_weekly_reconciliations FROM PUBLIC');
  await target.query(`INSERT INTO migration_audit.approved_weekly_reconciliations
    (plan_sha256, approval, original_rows, canonical_row) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb)`,
    [result.planSha256, JSON.stringify(result.plan), JSON.stringify(result.originals), JSON.stringify(result.canonical)]);
  const checked = await target.query(`SELECT count(*)::text AS n FROM migration_audit.approved_weekly_reconciliations
    WHERE plan_sha256=$1 AND approval=$2::jsonb AND original_rows=$3::jsonb AND canonical_row=$4::jsonb`,
    [result.planSha256, JSON.stringify(result.plan), JSON.stringify(result.originals), JSON.stringify(result.canonical)]);
  if (checked.rows[0]?.n !== '1') throw new Error('Original financial archive verification failed');
}
