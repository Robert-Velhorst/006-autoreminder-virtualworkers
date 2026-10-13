import { and, desc, eq } from "drizzle-orm";
import { aptlssManagerChecks, aptlssManagerRuns, aptlssManagerState } from "../drizzle/schema";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import type { getDb } from "./db";
import { restoreManagerHistorySnapshot } from "./aptlssManagerHistory";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function loadManagerHistoryCheck(db: Db, vaId: number, checkId: number) {
  const [check] = await db.select().from(aptlssManagerChecks)
    .where(and(eq(aptlssManagerChecks.vaId, vaId), eq(aptlssManagerChecks.id, checkId))).limit(1);
  if (!check) throw new Error("Manager assessment history is unavailable in this worker scope.");
  const [run] = await db.select().from(aptlssManagerRuns)
    .where(and(eq(aptlssManagerRuns.vaId, vaId), eq(aptlssManagerRuns.id, check.runId))).limit(1);
  if (!run) throw new Error("Manager assessment history is unavailable in this worker scope.");
  return { check, snapshot: restoreManagerHistorySnapshot(run.snapshotJson, run.id, check) };
}

/** A current check never makes an old or failed assessment fresh by itself. */
export async function readCurrentManagerHistory(db: Db, vaId: number) {
  const [state] = await db.select().from(aptlssManagerState).where(eq(aptlssManagerState.vaId, vaId)).limit(1);
  const [run] = await db.select().from(aptlssManagerRuns).where(eq(aptlssManagerRuns.vaId, vaId)).orderBy(desc(aptlssManagerRuns.id)).limit(1);
  let snapshot: ManagerSnapshot | null = null;
  try { snapshot = run ? JSON.parse(run.snapshotJson) : null; } catch { /* Existing malformed runs remain fail-closed. */ }
  if (state?.currentCheckId != null) {
    const retained = await loadManagerHistoryCheck(db, vaId, state.currentCheckId);
    // Older binaries can append normal full runs without maintaining this new
    // pointer. Their newer immutable run wins; a mismatched current check does not.
    if (retained.check.runId === run?.id) {
      if ((state.inputHash !== null && state.inputHash !== retained.check.inputHash)
        || state.sourceHash !== retained.check.sourceHash) throw new Error("Manager assessment state does not match its retained history.");
      snapshot = retained.snapshot;
    }
  }
  if (snapshot) {
    snapshot.runId = run!.id;
    if (state) {
      snapshot.policy = { enabled: state.enabled, intervalMinutes: state.intervalMinutes, mode: state.mode };
      // Policy/correction invalidation is not a new successful assessment.
      if (state.inputHash === null) snapshot.executionCoverageComplete = false;
    }
  }
  return { state, run, snapshot };
}
