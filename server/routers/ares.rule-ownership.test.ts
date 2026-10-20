import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrpcContext } from '../_core/context';

const db = vi.hoisted(() => ({
  getAresConfiguration: vi.fn(),
  getAresValidationRule: vi.fn(),
  updateAresValidationRule: vi.fn(),
  deleteAresValidationRule: vi.fn(),
}));
vi.mock('../db-ares', () => db);

import { aresRouter } from './ares';

const config = { id: 'owned-config', userId: 11 };
const rule = { id: 'owned-rule', configId: config.id, ruleName: 'Original', enabled: true };
const caller = (user: TrpcContext['user'] = { id: 11 } as TrpcContext['user']) =>
  aresRouter.createCaller({ user, req: {}, res: {} } as TrpcContext);

describe('ARES rule ownership through the real router', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.getAresConfiguration.mockResolvedValue(config);
    db.getAresValidationRule.mockImplementation(async (id, configId) =>
      id === rule.id && configId === rule.configId ? rule : null);
    db.updateAresValidationRule.mockResolvedValue({ ...rule, enabled: false });
    db.deleteAresValidationRule.mockResolvedValue(true);
  });

  for (const action of ['update', 'delete'] as const) {
    const invoke = (input: { configId: string; ruleId: string }, user = caller()) =>
      action === 'update'
        ? user.updateValidationRule({ ...input, enabled: false })
        : user.deleteValidationRule(input);

    it(`${action}: rejects a foreign rule paired with an owned configuration before writing`, async () => {
      await expect(invoke({ configId: config.id, ruleId: 'foreign-rule' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.getAresValidationRule).toHaveBeenCalledWith('foreign-rule', config.id);
      expect(db.updateAresValidationRule).not.toHaveBeenCalled();
      expect(db.deleteAresValidationRule).not.toHaveBeenCalled();
    });

    it(`${action}: rejects a foreign configuration before reading or writing its rule`, async () => {
      db.getAresConfiguration.mockResolvedValue({ id: 'foreign-config', userId: 22 });
      await expect(invoke({ configId: 'foreign-config', ruleId: 'foreign-rule' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.getAresValidationRule).not.toHaveBeenCalled();
      expect(db.updateAresValidationRule).not.toHaveBeenCalled();
      expect(db.deleteAresValidationRule).not.toHaveBeenCalled();
    });

    it(`${action}: preserves successful owned-rule behavior and passes the authorized scope`, async () => {
      const result = await invoke({ configId: config.id, ruleId: rule.id });
      if (action === 'update') {
        expect(result).toMatchObject({ id: rule.id, enabled: false });
        expect(db.updateAresValidationRule).toHaveBeenCalledWith(rule.id, config.id,
          expect.objectContaining({ enabled: false }));
      } else {
        expect(result).toEqual({ success: true });
        expect(db.deleteAresValidationRule).toHaveBeenCalledWith(rule.id, config.id);
      }
    });

    it(`${action}: does not report success if the rule disappears after the ownership check`, async () => {
      db.updateAresValidationRule.mockResolvedValue(null);
      db.deleteAresValidationRule.mockResolvedValue(false);
      await expect(invoke({ configId: config.id, ruleId: rule.id }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it(`${action}: requires authentication`, async () => {
      await expect(invoke({ configId: config.id, ruleId: rule.id }, caller(null)))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(db.getAresConfiguration).not.toHaveBeenCalled();
    });

    it(`${action}: preserves database failures as server errors`, async () => {
      db.updateAresValidationRule.mockRejectedValue(new Error('database unavailable'));
      db.deleteAresValidationRule.mockRejectedValue(new Error('database unavailable'));
      await expect(invoke({ configId: config.id, ruleId: rule.id }))
        .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  }
});
