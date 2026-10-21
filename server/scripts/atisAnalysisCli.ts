import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AtisAnalysisJob, AtisAnalysisPreview, AtisAnalysisSelection } from '../../shared/atisAnalysis';

type Actor = { id: number; role: 'admin' };
export interface AtisAnalysisCliCore {
  createAtisAnalysisPreview(actor: Actor, selection: AtisAnalysisSelection): Promise<AtisAnalysisPreview>;
  confirmAtisAnalysisPreview(actor: Actor, id: string, input: { requestKey: string; acknowledgeInterruptedOperationId?: number }): Promise<AtisAnalysisJob>;
  getAtisAnalysisJob(actor: Actor, id: string): Promise<AtisAnalysisJob | null>;
}
export async function loadAtisAnalysisCliCore(): Promise<AtisAnalysisCliCore> {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
  const core = await import('../atisAnalysisAdmission');
  return {
    createAtisAnalysisPreview: (actor, selection) => core.createAtisAnalysisPreview(actor.id, selection),
    confirmAtisAnalysisPreview: (actor, id, input) => core.confirmAtisAnalysisPreview(actor.id, id, input),
    getAtisAnalysisJob: (actor, id) => core.getAtisAnalysisJob(actor.id, id),
  };
}
export type CliMode = 'all' | 'active_placeholders';
type Command = { kind: 'help' } | { kind: 'preview'; ownerUserId: number; selection: AtisAnalysisSelection }
  | { kind: 'confirm'; ownerUserId: number; previewId: string; requestKey: string; acknowledgeInterruptedOperationId?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FLAGS = new Set(['--owner-user-id', '--limit', '--after-card-id', '--preview-id', '--request-key', '--acknowledge-interrupted-operation-id']);
function positive(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid CLI input');
  return Number(value);
}
function uuid(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error('Invalid CLI input');
  return value.toLowerCase();
}
export function parseAtisAnalysisCli(argv: readonly string[], mode: CliMode): Command {
  if (argv.length === 1 && argv[0] === '--help') return { kind: 'help' };
  const values = new Map<string, string>();
  let confirm = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--confirm-ai-reanalysis') {
      if (confirm) throw new Error('Duplicate flag');
      confirm = true; continue;
    }
    if (!FLAGS.has(flag) || values.has(flag) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Invalid CLI input');
    values.set(flag, argv[++index]);
  }
  const ownerUserId = positive(values.get('--owner-user-id'));
  if (confirm) {
    if (values.has('--limit') || values.has('--after-card-id')) throw new Error('Confirmation must use a frozen preview');
    return { kind: 'confirm', ownerUserId, previewId: uuid(values.get('--preview-id')), requestKey: uuid(values.get('--request-key')),
      ...(values.has('--acknowledge-interrupted-operation-id')
        ? { acknowledgeInterruptedOperationId: positive(values.get('--acknowledge-interrupted-operation-id')) } : {}) };
  }
  if (values.has('--preview-id') || values.has('--request-key') || values.has('--acknowledge-interrupted-operation-id')) throw new Error('Explicit confirmation required');
  const limit = values.has('--limit') ? positive(values.get('--limit')) : 100;
  if (limit > 100) throw new Error('Invalid CLI input');
  return { kind: 'preview', ownerUserId, selection: { mode: mode === 'all' ? 'reanalyze' : 'active_placeholders', limit,
    ...(mode === 'all' ? { forceAll: true } : {}),
    ...(values.has('--after-card-id') ? { afterCardId: positive(values.get('--after-card-id')) } : {}) } };
}
export function isAtisCliMain(moduleUrl: string): boolean {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === moduleUrl;
}
type Options = {
  loadCore: () => Promise<AtisAnalysisCliCore>;
  write?: (message: string) => void;
  requestKey?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxStatusReads?: number;
  pollWindowMs?: number;
  requestTimeoutMs?: number;
};
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Unconfirmed')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const nonnegative = (...values: number[]) => values.every(value => Number.isSafeInteger(value) && value >= 0);
function validJob(job: AtisAnalysisJob | null): job is AtisAnalysisJob {
  return Boolean(job && UUID.test(job.id) && ['queued', 'running', 'completed', 'failed', 'interrupted'].includes(job.state)
    && nonnegative(job.matched, job.total, job.remaining, job.processed, job.generated, job.fallback, job.missing, job.failed, job.uncertain, job.pending)
    && job.total <= 100);
}
function terminal(job: AtisAnalysisJob, write: (message: string) => void): number | undefined {
  if (job.state === 'queued' || job.state === 'running') return undefined;
  write(`Job ${job.id}: ${job.state}; selected=${job.total}, generated=${job.generated}, fallback=${job.fallback}, missing=${job.missing}, failed=${job.failed}, uncertain=${job.uncertain}, pending=${job.pending}, unselected=${job.remaining}.`);
  if (job.state !== 'completed' || job.generated !== job.total || job.fallback || job.missing || job.failed || job.uncertain || job.pending || job.remaining) {
    write('Incomplete or unverified outcome. Review the recorded job and any remaining batch before taking further action.');
    return 1;
  }
  write(job.total ? 'The selected preview batch was generated. No additional cards were requested.' : 'No cards were selected; no analysis was required.');
  return 0;
}

export async function runAtisAnalysisCli(argv: readonly string[], mode: CliMode, scriptPath: string, options: Options): Promise<number> {
  const write = options.write ?? console.log;
  let command: Command;
  try { command = parseAtisAnalysisCli(argv, mode); }
  catch {
    write('Usage: --owner-user-id POSITIVE_ID [--limit 1..100] [--after-card-id POSITIVE_ID]');
    write('Confirm only: --owner-user-id POSITIVE_ID --confirm-ai-reanalysis --preview-id UUID --request-key UUID [--acknowledge-interrupted-operation-id POSITIVE_ID]');
    return 2;
  }
  if (command.kind === 'help') {
    write('Specify --owner-user-id POSITIVE_ID for a DB-only preview. Only explicit confirmation with its preview ID and stable request key can request analysis.');
    return 0;
  }
  const actor: Actor = { id: command.ownerUserId, role: 'admin' };
  const timeout = options.requestTimeoutMs ?? 30_000;
  try {
    const core = await bounded(options.loadCore(), timeout);
    if (command.kind === 'preview') {
      const preview = await bounded(core.createAtisAnalysisPreview(actor, command.selection), timeout);
      if (!UUID.test(preview.id) || !Number.isFinite(Date.parse(preview.expiresAt))
        || !nonnegative(preview.matched, preview.total, preview.remaining) || preview.total > 100
        || !/^(?!-)[a-zA-Z0-9_./-]+\.(?:js|ts)$/.test(scriptPath)) throw new Error('Invalid preview');
      const requestKey = uuid((options.requestKey ?? randomUUID)());
      write('Preview only. No AI analysis was requested.');
      write(`Preview ${preview.id}; expires=${new Date(preview.expiresAt).toISOString()}; matched=${preview.matched}, selected=${preview.total}, unselected=${preview.remaining}.`);
      if (preview.remaining) write('This is a bounded batch, not all matching cards. Remaining cards need a separate preview.');
      if (preview.nextAfterCardId !== undefined && Number.isSafeInteger(preview.nextAfterCardId) && preview.nextAfterCardId > 0) write(`Next batch cursor: --after-card-id ${preview.nextAfterCardId}`);
      let acknowledge = '';
      if (preview.recoveryOperationId !== undefined) {
        positive(String(preview.recoveryOperationId));
        write(`Interrupted operation ${preview.recoveryOperationId} requires review before explicit acknowledgement.`);
        acknowledge = ` --acknowledge-interrupted-operation-id ${preview.recoveryOperationId}`;
      }
      write('After reviewing this frozen preview, explicitly confirm with the same request key:');
      const runtime = scriptPath.endsWith('.js') ? 'node' : 'node --import tsx';
      write(`${runtime} ${scriptPath} --owner-user-id ${actor.id} --confirm-ai-reanalysis --preview-id ${preview.id} --request-key ${requestKey}${acknowledge}`);
      return 0;
    }
    // Exactly one mutating call. An uncertain response never triggers retry.
    const submitted = await bounded(core.confirmAtisAnalysisPreview(actor, command.previewId, {
      requestKey: command.requestKey, ...(command.acknowledgeInterruptedOperationId === undefined ? {}
        : { acknowledgeInterruptedOperationId: command.acknowledgeInterruptedOperationId }),
    }), timeout);
    if (!validJob(submitted)) throw new Error('Unconfirmed');
    const terminalCode = terminal(submitted, write);
    if (terminalCode !== undefined) return terminalCode;
    const jobId = submitted.id;
    write(`Job ${jobId} recorded. Status polling is read-only; stopping polling does not cancel server work.`);
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const deadline = now() + (options.pollWindowMs ?? 5 * 60_000);
    for (let read = 0; read < (options.maxStatusReads ?? 120); read++) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(options.pollIntervalMs ?? 2_000, remaining));
      const readTime = deadline - now();
      if (readTime <= 0) break;
      const job = await bounded(core.getAtisAnalysisJob(actor, jobId), Math.min(timeout, readTime));
      if (!validJob(job) || job.id !== jobId) throw new Error('Unconfirmed');
      const result = terminal(job, write);
      if (result !== undefined) return result;
    }
    write(`Unconfirmed job ${jobId}. Polling stopped; server work was not cancelled. Inspect its status before taking further action.`);
    return 1;
  } catch {
    write(command.kind === 'confirm'
      ? `Confirmation or job outcome is unconfirmed for preview ${command.previewId}. No automatic retry was made; server work may still be running. Inspect durable status before retrying with the same request key.`
      : 'Preview unavailable or rejected. No confirmation was attempted.');
    return 1;
  }
}
