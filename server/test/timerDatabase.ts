import { PgDialect } from 'drizzle-orm/pg-core';
import { users, vaProfiles, timeEntries } from '../../drizzle/schema.postgres';
import { vi } from 'vitest';

export type TestRow = Record<string, any>;
export function matchesTimerWhere(row: TestRow, condition: any): boolean {
  if (!condition) return true;
  const chunks = condition.queryChunks ?? [];
  const nested = chunks.filter((chunk: any) => chunk?.queryChunks);
  const text = chunks.flatMap((chunk: any) => Array.isArray(chunk?.value) ? chunk.value : []).join('');
  if (nested.length) return /\bor\b/i.test(text) ? nested.some((child: any) => matchesTimerWhere(row, child))
    : nested.every((child: any) => matchesTimerWhere(row, child));
  const column = chunks.find((chunk: any) => typeof chunk?.name === 'string');
  if (!column) return true;
  if (/is not null/i.test(text)) return row[column.name] != null;
  if (/is null/i.test(text)) return row[column.name] == null;
  const params: any[] = [];
  const visit = (chunk: any) => {
    if (Array.isArray(chunk)) return chunk.forEach(visit);
    if (chunk && 'encoder' in chunk && 'value' in chunk) params.push(chunk.value);
    else if (chunk?.queryChunks) visit(chunk.queryChunks);
  };
  visit(chunks);
  if (/\bin\b/i.test(text)) return params.includes(row[column.name]);
  const a = row[column.name] instanceof Date ? row[column.name].getTime() : row[column.name];
  const b = params[0] instanceof Date ? params[0].getTime() : params[0];
  if (/>=/.test(text)) return a >= b;
  if (/<=/.test(text)) return a <= b;
  if (/!=|<>/.test(text)) return a !== b;
  return a === b;
}

// A transactional row store for route tests, not evidence of PG lock behavior.
// Native integration tests separately exercise real locks, triggers and indexes.
export function timerTestDatabase(rows: Map<unknown, TestRow[]>, hooks: {
  beforeLock?: (table: unknown, condition: any) => Promise<void>;
  beforeUpdate?: (table: unknown) => void;
  afterInsert?: (table: unknown, value: TestRow) => void;
} = {}) {
  const inserts: Array<{ table: unknown; values: TestRow }> = [];
  const updates: Array<{ table: unknown; values: TestRow }> = [];
  const selected = (table: unknown, condition: any) => (rows.get(table) ?? []).filter(row => matchesTimerWhere(row, condition));
  const db: any = {
    select: (selection?: TestRow) => {
      let table: unknown; let condition: any; let limit = Infinity;
      const result = () => {
        const found = selected(table, condition).slice(0, limit);
        if (selection?.count) return [{ count: found.length }];
        if (!selection) return structuredClone(found);
        return found.map(row => Object.fromEntries(Object.entries(selection).map(([key, column]: [string, any]) => [key, row[column.name]])));
      };
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: any) => { condition = value; return query; },
        orderBy: () => query, groupBy: () => query, having: () => query,
        limit: (value: number) => { limit = value; return query; },
        for: async () => { await hooks.beforeLock?.(table, condition); return result(); },
        then: (resolve: any, reject: any) => Promise.resolve().then(result).then(resolve, reject),
        catch: (reject: any) => Promise.resolve().then(result).catch(reject),
      };
      return query;
    },
    update: (table: unknown) => {
      let values: TestRow; let condition: any;
      const execute = () => {
        hooks.beforeUpdate?.(table);
        const found = selected(table, condition);
        found.forEach(row => Object.assign(row, values));
        updates.push({ table, values });
        return structuredClone(found);
      };
      const query: any = { set: (value: TestRow) => { values = value; return query; },
        where: (value: any) => { condition = value; return query; }, returning: async () => execute(),
        then: (resolve: any, reject: any) => Promise.resolve().then(() => ({ rowCount: execute().length })).then(resolve, reject) };
      return query;
    },
    insert: (table: unknown) => ({ values: (value: TestRow) => {
      const execute = () => {
        const tableRows = rows.get(table) ?? [];
        const row = { id: Math.max(0, ...tableRows.map(row => Number(row.id))) + 1,
          ...(table === timeEntries ? { endTime: null, isVoided: false, durationSeconds: null, durationMinutes: null, notes: null } : {}), ...value };
        tableRows.push(row); rows.set(table, tableRows); inserts.push({ table, values: value });
        hooks.afterInsert?.(table, value);
        return structuredClone([row]);
      };
      return { returning: async () => execute(), then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
    } }),
    execute: async () => ({ rows: [{ id: '1' }] }),
    transaction: async (work: (tx: any) => Promise<any>) => {
      const snapshot = new Map([...rows].map(([table, value]) => [table, structuredClone(value)]));
      try { return await work(db); }
      catch (error) { rows.clear(); snapshot.forEach((value, table) => rows.set(table, value)); throw error; }
    },
  };
  for (const key of Object.keys(db)) db[key] = vi.fn(db[key]);
  return { db, rows, inserts, updates };
}
