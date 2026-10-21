import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { startCodexLlmRunner } from '../codexLlmRunner';
import { getCodexLlmStatus } from '../_core/codexLlm';

export type SyntheticTurn = { answer?: string; review?: 'adequate' | 'needs_more_reasoning' | 'missing_evidence';
  reason?: string; raw?: string; usage?: { input_tokens: number; output_tokens: number }; failure?: string;
  hold?: boolean; tool?: boolean };
export async function codexLlmFixture(plan: { turns?: SyntheticTurn[]; holdLogin?: boolean; noSubscription?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(),'codex-llm-fixture-'));
  const base = join(directory,'queue'), root = join(base,'llm-v1'), work = join(directory,'private');
  await mkdir(work,{ recursive: true });
  await copyFile(new URL('./fixtures/codex-cli-login.cjs',import.meta.url),join(work,'login'));
  await copyFile(new URL('./fixtures/codex-cli-exec.cjs',import.meta.url),join(work,'exec'));
  await writeFile(join(work,'test-plan.json'),JSON.stringify(plan));
  vi.stubEnv('APTLSS_CODEX_QUEUE_DIR',base);
  const controller = new AbortController();
  const running = startCodexLlmRunner(root,work,process.execPath,controller.signal);
  // Observe startup failures immediately while retaining the original rejection for close().
  void running.catch(() => {});
  await vi.waitFor(async () => { if (!(await getCodexLlmStatus()).available) throw new Error('Fixture runner not ready'); });
  return { root,work,base,controller,
    waitFile: async (name: string) => vi.waitFor(async () => { await readFile(join(work,name)); },{ timeout: 5000 }),
    release: async (name: string) => writeFile(join(work,name),'release'),
    calls: async () => { try { return (await readFile(join(work,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    close: async () => { controller.abort(); try { await running; } finally { await rm(directory,{ recursive: true,force: true }); } },
  };
}
