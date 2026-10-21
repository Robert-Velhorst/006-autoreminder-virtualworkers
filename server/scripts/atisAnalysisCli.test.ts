import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AtisAnalysisJob, AtisAnalysisPreview } from '../../shared/atisAnalysis';
import { loadAtisAnalysisCliCore, parseAtisAnalysisCli, runAtisAnalysisCli, type AtisAnalysisCliCore } from './atisAnalysisCli';

const actualBoundary = vi.hoisted(() => ({ config: vi.fn(), preview: vi.fn(), confirm: vi.fn(), get: vi.fn() }));
vi.mock('dotenv', () => ({ config: actualBoundary.config }));
vi.mock('../atisAnalysisAdmission', () => ({ createAtisAnalysisPreview: actualBoundary.preview,
  confirmAtisAnalysisPreview: actualBoundary.confirm, getAtisAnalysisJob: actualBoundary.get }));

const previewId = '11111111-1111-4111-8111-111111111111';
const requestKey = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const owner = ['--owner-user-id', '42'];
const confirm = [...owner, '--confirm-ai-reanalysis', '--preview-id', previewId, '--request-key', requestKey];
const actor = { id: 42, role: 'admin' };
function job(changes: Partial<AtisAnalysisJob> = {}): AtisAnalysisJob {
  return { id: previewId, state: 'completed', matched: 2, total: 2, remaining: 0, processed: 2,
    generated: 2, fallback: 0, missing: 0, failed: 0, uncertain: 0, pending: 0, items: [], ...changes };
}
function fixture(previewChanges: Partial<AtisAnalysisPreview> = {}) {
  const preview: AtisAnalysisPreview = { id: previewId, expiresAt: '2026-10-22T09:00:00Z',
    matched: 2, total: 2, remaining: 0, cards: [{ id: 1, name: 'Private card name' }], ...previewChanges };
  const core = { createAtisAnalysisPreview: vi.fn().mockResolvedValue(preview),
    confirmAtisAnalysisPreview: vi.fn().mockResolvedValue(job()), getAtisAnalysisJob: vi.fn().mockResolvedValue(job()) } satisfies AtisAnalysisCliCore;
  const messages: string[] = [];
  let time = 0;
  const options = { loadCore: vi.fn().mockResolvedValue(core), write: (message: string) => { messages.push(message); },
    requestKey: () => requestKey, now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }),
    pollIntervalMs: 1, maxStatusReads: 3, pollWindowMs: 10 };
  return { core, options, messages, run: (argv = owner) => runAtisAnalysisCli(argv, 'all', 'server/scripts/reanalyze_all.ts', options) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('ATIS CLI admission parsing', () => {
  it.each([
    [], ['--confirm-ai-reanalysis'], ['--owner-user-id'], ['--owner-user-id', '0'], ['--owner-user-id', '-1'],
    ['--owner-user-id', '1.5'], ['--owner-user-id', '1x'], ['--owner-user-id', '9007199254740992'],
    [...owner, '--owner-user-id', '1'], [...owner, '--unknown'], [...owner, '--limit', '101'],
    [...owner, '--limit', '0'], [...owner, '--limit', '1.5'], [...owner, '--after-card-id', '0'],
    [...owner, '--preview-id', previewId], [...owner, '--request-key', requestKey],
    [...owner, '--acknowledge-interrupted-operation-id', '1'],
    [...owner, '--confirm-ai-reanalysis'], [...owner, '--confirm-ai-reanalysis', '--preview-id', previewId],
    [...confirm, '--limit', '10'], [...confirm, '--after-card-id', '10'], [...confirm, '--confirm-ai-reanalysis'],
    [...confirm, '--acknowledge-interrupted-operation-id', '0'],
    [...owner, '--confirm-ai-reanalysis', '--preview-id', 'not-a-uuid', '--request-key', requestKey],
    [...owner, '--confirm-ai-reanalysis', '--preview-id', previewId, '--request-key', 'not-a-uuid'],
  ].map(argv => ({ argv })))('rejects invalid/ambiguous input before loading any core or DB: $argv', async ({ argv }) => {
    const f = fixture();
    expect(await f.run(argv)).toBe(2);
    expect(f.options.loadCore).not.toHaveBeenCalled();
    expect(f.core.createAtisAnalysisPreview).not.toHaveBeenCalled();
    expect(f.core.confirmAtisAnalysisPreview).not.toHaveBeenCalled();
  });

  it('retains bounded all-card mode and explicit continuation', () => {
    expect(parseAtisAnalysisCli([...owner, '--limit', '80', '--after-card-id', '123'], 'all'))
      .toEqual({ kind: 'preview', ownerUserId: 42, selection: { mode: 'reanalyze', forceAll: true, limit: 80, afterCardId: 123 } });
  });
  it('delegates active-placeholder eligibility to the canonical selector', () => {
    expect(parseAtisAnalysisCli(owner, 'active_placeholders')).toEqual({ kind: 'preview', ownerUserId: 42,
      selection: { mode: 'active_placeholders', limit: 100 } });
  });
  it('passes the exact explicit replay/recovery identities without selecting again', () => {
    expect(parseAtisAnalysisCli([...confirm, '--acknowledge-interrupted-operation-id', '19'], 'all')).toEqual({
      kind: 'confirm', ownerUserId: 42, previewId, requestKey, acknowledgeInterruptedOperationId: 19,
    });
  });
});

describe('ATIS CLI injected core execution', () => {
  it.each(['reanalyze_all', 'reanalyze_active_placeholders'])('prints a source-free compiled confirmation command for %s', async name => {
    const f = fixture();
    const path = `dist/tools/${name}.js`;
    expect(await runAtisAnalysisCli(owner, name === 'reanalyze_all' ? 'all' : 'active_placeholders', path, f.options)).toBe(0);
    const command = f.messages.find(message => message.startsWith('node '));
    expect(command).toBe(`node ${path} --owner-user-id 42 --confirm-ai-reanalysis --preview-id ${previewId} --request-key ${requestKey}`);
    expect(command).not.toMatch(/tsx|server\/scripts/);
    expect(f.core.confirmAtisAnalysisPreview).not.toHaveBeenCalled();
  });
  it('keeps the TypeScript loader in source confirmation commands', async () => {
    const f = fixture();
    expect(await f.run()).toBe(0);
    expect(f.messages.find(message => message.startsWith('node '))).toBe(
      `node --import tsx server/scripts/reanalyze_all.ts --owner-user-id 42 --confirm-ai-reanalysis --preview-id ${previewId} --request-key ${requestKey}`);
  });
  it.each(['dist/tools/tool.js;echo-secret', 'dist/tools/tool.js\nother-command', 'dist/tools/tool file.js', '-tool.js', 'dist/tools/tool.sh'])
    ('does not print a confirmation command for unsafe/unsupported path %j', async scriptPath => {
      const f = fixture();
      const result = await runAtisAnalysisCli(owner, 'all', scriptPath, f.options);
      expect(result).toBe(1);
      expect(f.messages.some(message => message.startsWith('node '))).toBe(false);
      expect(f.core.confirmAtisAnalysisPreview).not.toHaveBeenCalled();
    });
  it('default owner invocation is preview-only and prints one stable explicit command without private card data', async () => {
    const f = fixture({ matched: 105, total: 100, remaining: 5, nextAfterCardId: 100, recoveryOperationId: 19 });
    expect(await f.run()).toBe(0);
    expect(f.core.createAtisAnalysisPreview).toHaveBeenCalledExactlyOnceWith(actor, { mode: 'reanalyze', forceAll: true, limit: 100 });
    expect(f.core.confirmAtisAnalysisPreview).not.toHaveBeenCalled(); expect(f.core.getAtisAnalysisJob).not.toHaveBeenCalled();
    const text = f.messages.join('\n');
    expect(text).toContain(`Preview ${previewId}; expires=2026-10-22T09:00:00.000Z`);
    expect(text).toContain('not all matching cards'); expect(text).toContain('--after-card-id 100');
    expect(text).toContain(`--preview-id ${previewId} --request-key ${requestKey} --acknowledge-interrupted-operation-id 19`);
    expect(text).not.toContain('Private card name');
  });
  it('help is read-only even before core loading', async () => {
    const f = fixture(); expect(await f.run(['--help'])).toBe(0); expect(f.options.loadCore).not.toHaveBeenCalled();
  });
  it('uses the active-placeholder selector without processing directly', async () => {
    const f = fixture();
    expect(await runAtisAnalysisCli(owner, 'active_placeholders', 'server/scripts/reanalyze_active_placeholders.ts', f.options)).toBe(0);
    expect(f.core.createAtisAnalysisPreview).toHaveBeenCalledExactlyOnceWith(actor, { mode: 'active_placeholders', limit: 100 });
    expect(f.core.confirmAtisAnalysisPreview).not.toHaveBeenCalled();
  });
  it('confirms exactly once and polls only the recorded job ID', async () => {
    const f = fixture();
    f.core.confirmAtisAnalysisPreview.mockResolvedValue(job({ id: otherId, state: 'queued', generated: 0, pending: 2 }));
    f.core.getAtisAnalysisJob.mockResolvedValueOnce(job({ id: otherId, state: 'running', generated: 1, pending: 1 }))
      .mockResolvedValueOnce(job({ id: otherId }));
    expect(await f.run([...confirm, '--acknowledge-interrupted-operation-id', '19'])).toBe(0);
    expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledExactlyOnceWith(actor, previewId, { requestKey, acknowledgeInterruptedOperationId: 19 });
    expect(f.core.createAtisAnalysisPreview).not.toHaveBeenCalled();
    expect(f.core.getAtisAnalysisJob.mock.calls).toEqual([[actor, otherId], [actor, otherId]]);
  });
  it.each([
    { state: 'failed' }, { state: 'interrupted' }, { uncertain: 1 }, { fallback: 1 }, { missing: 1 },
    { failed: 1 }, { pending: 1 }, { remaining: 3 }, { generated: 1 },
  ] as Partial<AtisAnalysisJob>[])('reports a nonzero incomplete result for %j, not all-finished', async change => {
    const f = fixture(); f.core.confirmAtisAnalysisPreview.mockResolvedValue(job(change));
    expect(await f.run(confirm)).toBe(1);
    expect(f.messages.join('\n')).toContain('Incomplete or unverified');
    expect(f.messages.join('\n')).not.toContain('The selected preview batch was generated');
    expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
  });
  it('bounds status reads and does not claim polling timeout cancelled work', async () => {
    const f = fixture();
    f.core.confirmAtisAnalysisPreview.mockResolvedValue(job({ state: 'running' }));
    f.core.getAtisAnalysisJob.mockResolvedValue(job({ state: 'running' }));
    expect(await f.run(confirm)).toBe(1);
    expect(f.core.getAtisAnalysisJob).toHaveBeenCalledTimes(3);
    expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
    expect(f.messages.join('\n')).toContain('server work was not cancelled');
  });
  it('bounds the elapsed polling window independently of read count', async () => {
    const f = fixture(); f.options.pollWindowMs = 2;
    f.core.confirmAtisAnalysisPreview.mockResolvedValue(job({ state: 'running' }));
    f.core.getAtisAnalysisJob.mockResolvedValue(job({ state: 'running' }));
    expect(await f.run(confirm)).toBe(1); expect(f.core.getAtisAnalysisJob).toHaveBeenCalledTimes(1);
  });
  it('never retries a rejected confirmation or prints raw errors/credentials', async () => {
    const f = fixture();
    f.core.confirmAtisAnalysisPreview.mockRejectedValue(new Error('postgres://private:credential@example.invalid secret-token'));
    expect(await f.run(confirm)).toBe(1);
    expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
    expect(f.core.getAtisAnalysisJob).not.toHaveBeenCalled();
    expect(f.messages.join('\n')).not.toMatch(/credential|secret-token|postgres:/);
  });
  it('does not retry POST after a rejected status read or mismatched ID', async () => {
    for (const response of [null, job({ id: otherId })]) {
      const f = fixture(); f.core.confirmAtisAnalysisPreview.mockResolvedValue(job({ state: 'queued' }));
      f.core.getAtisAnalysisJob.mockResolvedValue(response);
      expect(await f.run(confirm)).toBe(1); expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
      expect(f.core.getAtisAnalysisJob).toHaveBeenCalledOnce();
    }
    const f = fixture(); f.core.confirmAtisAnalysisPreview.mockResolvedValue(job({ state: 'queued' }));
    f.core.getAtisAnalysisJob.mockRejectedValue(new Error('DB unavailable'));
    expect(await f.run(confirm)).toBe(1); expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
  });
  it('bounds a hanging confirmation without another write or cancelling it', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.core.confirmAtisAnalysisPreview.mockReturnValue(new Promise(() => {}));
    const run = f.run(confirm);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await run).toBe(1); expect(f.core.confirmAtisAnalysisPreview).toHaveBeenCalledOnce();
    expect(f.messages.join('\n')).toContain('No automatic retry');
  });
  it('both entrypoints import without dotenv/core loading or automatic execution', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const all = await import('./reanalyze_all'); const placeholders = await import('./reanalyze_active_placeholders');
    expect(typeof all.main).toBe('function'); expect(typeof placeholders.main).toBe('function');
    expect(log).not.toHaveBeenCalled();
    expect(actualBoundary.config).not.toHaveBeenCalled();
    expect(actualBoundary.preview).not.toHaveBeenCalled(); expect(actualBoundary.confirm).not.toHaveBeenCalled();
  });
  it('keeps the real entrypoints free of direct provider work and destructive understanding writes', () => {
    for (const path of ['./reanalyze_all.ts', './reanalyze_active_placeholders.ts', './atisAnalysisCli.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/processCardUnderstanding|invokeLLM|\.delete\s*\(|\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    }
  });
  it('loads environment quietly only when requested, then maps actor to the real core owner-ID contract', async () => {
    const core = await loadAtisAnalysisCliCore();
    await core.createAtisAnalysisPreview(actor, { mode: 'active_placeholders', limit: 10 });
    await core.confirmAtisAnalysisPreview(actor, previewId, { requestKey });
    await core.getAtisAnalysisJob(actor, previewId);
    expect(actualBoundary.config).toHaveBeenCalledExactlyOnceWith({ quiet: true });
    expect(actualBoundary.preview).toHaveBeenCalledExactlyOnceWith(42, { mode: 'active_placeholders', limit: 10 });
    expect(actualBoundary.confirm).toHaveBeenCalledExactlyOnceWith(42, previewId, { requestKey });
    expect(actualBoundary.get).toHaveBeenCalledExactlyOnceWith(42, previewId);
  });
});
