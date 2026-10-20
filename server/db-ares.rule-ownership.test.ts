import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aresValidationRules } from '../drizzle/schema.postgres';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./db', () => ({ getDb: mocks.getDb }));

import { deleteAresValidationRule, getAresValidationRule, updateAresValidationRule } from './db-ares';

const dialect = new PgDialect();
const compile = (where: SQL) => dialect.sqlToQuery(where);
const expectedScope = compile(and(
  eq(aresValidationRules.id, 'rule-1'),
  eq(aresValidationRules.configId, 'config-1'),
)!);

describe('ARES database rule mutation predicates', () => {
  const returnedRule = { id: 'rule-1', configId: 'config-1', enabled: false };
  let rows: unknown[];
  let predicates: ReturnType<typeof compile>[];
  let database: any;

  beforeEach(() => {
    vi.resetAllMocks();
    rows = [returnedRule];
    predicates = [];
    const where = vi.fn((predicate: SQL) => {
      predicates.push(compile(predicate));
      return { returning: vi.fn(async () => rows) };
    });
    database = {
      query: { aresValidationRules: { findFirst: vi.fn(async ({ where }: { where: SQL }) => {
        predicates.push(compile(where));
        return rows[0];
      }) } },
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
      delete: vi.fn(() => ({ where })),
    };
    mocks.getDb.mockResolvedValue(database);
  });

  it('looks up the rule using both its ID and configuration', async () => {
    expect(await getAresValidationRule('rule-1', 'config-1')).toEqual(returnedRule);
    expect(predicates).toEqual([expectedScope]);
  });

  it('updates only the scoped rule and returns the atomic write result', async () => {
    expect(await updateAresValidationRule('rule-1', 'config-1', { enabled: false }))
      .toEqual(returnedRule);
    expect(database.update).toHaveBeenCalledWith(aresValidationRules);
    expect(predicates).toEqual([expectedScope]);
    expect(database.query.aresValidationRules.findFirst).not.toHaveBeenCalled();
  });

  it('deletes only the scoped rule', async () => {
    expect(await deleteAresValidationRule('rule-1', 'config-1')).toBe(true);
    expect(database.delete).toHaveBeenCalledWith(aresValidationRules);
    expect(predicates).toEqual([expectedScope]);
  });

  it('returns null when no rule matches the update scope', async () => {
    rows = [];
    expect(await updateAresValidationRule('rule-1', 'config-1', { enabled: false })).toBeNull();
    expect(predicates).toEqual([expectedScope]);
  });

  it('returns false when no rule matches the delete scope', async () => {
    rows = [];
    expect(await deleteAresValidationRule('rule-1', 'config-1')).toBe(false);
    expect(predicates).toEqual([expectedScope]);
  });

  it('returns null for a missing scoped lookup', async () => {
    rows = [];
    expect(await getAresValidationRule('rule-1', 'config-1')).toBeNull();
  });
});
