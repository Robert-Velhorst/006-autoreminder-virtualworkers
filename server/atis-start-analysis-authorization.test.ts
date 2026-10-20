import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS start-analysis authorization', () => {
  it('authorizes the requested Trello card before legacy aggregation', () => {
    const source = readFileSync(new URL('./routers.ts', import.meta.url), 'utf8');
    const atis = source.slice(source.indexOf('atis: router({'), source.indexOf('scheduling: router({'));

    expect(atis).toContain('startAnalysis: operatorAccountProcedure');
    expect(atis).toContain("fetchAuthorizedTrelloCard(ctx.user, input.taskId, { fields: 'id,idMembers' })");
  });

  it('resolves the caller worker profile before enriching AI context', () => {
    const source = readFileSync(new URL('./routers.ts', import.meta.url), 'utf8');
    const atis = source.slice(source.indexOf('atis: router({'), source.indexOf('scheduling: router({'));

    expect(atis).toContain('where(eq(vaProfiles.userId, workerUserId))');
    expect(atis).toContain('aggregateCardContext(input.taskId, workerProfile?.id)');
  });
});
