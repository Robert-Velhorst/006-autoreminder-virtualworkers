import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('legacy communication ownership', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/routes/va-management.ts'), 'utf8');

  it('requires the founder to own a task before writing or reading its communication history', () => {
    const post = source.slice(source.indexOf("router.post('/communication'"), source.indexOf("router.get('/communication/:taskId'"));
    const get = source.slice(source.indexOf("router.get('/communication/:taskId'"), source.indexOf('// ============================================\n// TIME TRACKING'));

    expect(post).toContain('readCanonicalAssignment(db, user.id, taskId)');
    expect(post).toContain('withLockedAssignment(db, user, taskId');
    expect(get).toContain('readCanonicalAssignment(db, user.id, taskId)');
    expect(get).toContain('eq(communicationLog.fromUserId, user.id)');
    expect(get).toContain('eq(communicationLog.toUserId, user.id)');
  });

  it('only permits a founder to address a worker in that founder\'s workspace', () => {
    const post = source.slice(source.indexOf("router.post('/communication'"), source.indexOf("router.get('/communication/:taskId'"));

    expect(post).toContain('eq(vaProfiles.userId, recipientId)');
    expect(post).toContain("profile.status === 'active'");
    expect(post).toContain('active.length !== 1 || active[0].founderId !== user.id');
    expect(post).toContain('workerProfileIds: recipientProfileId');
    expect(post).toContain('withTimerAccountTransaction(db, user');
  });
});
