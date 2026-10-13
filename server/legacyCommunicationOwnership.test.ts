import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('legacy communication ownership', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/routes/va-management.ts'), 'utf8');

  it('requires the founder to own a task before writing or reading its communication history', () => {
    const post = source.slice(source.indexOf("router.post('/communication'"), source.indexOf("router.get('/communication/:taskId'"));
    const get = source.slice(source.indexOf("router.get('/communication/:taskId'"), source.indexOf('// ============================================\n// TIME TRACKING'));

    expect(post).toContain('and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id))');
    expect(get).toContain('and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id))');
  });

  it('only permits a founder to address a worker in that founder\'s workspace', () => {
    const post = source.slice(source.indexOf("router.post('/communication'"), source.indexOf("router.get('/communication/:taskId'"));

    expect(post).toContain('eq(vaProfiles.userId, recipientId)');
    expect(post).toContain('eq(vaProfiles.founderId, user.id)');
  });
});
