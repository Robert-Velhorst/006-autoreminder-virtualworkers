import { getDb } from '../db';
import { dailyBriefings, taskAssignments, users, vaProfiles, type User } from '../../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';
import { AssignmentError, assertCanonicalAssignmentRows, type AssignmentActor } from '../taskAssignmentMutation';
import { withLockedAssignment } from '../taskAssignmentService';
import { selectWorkerProfile } from '../workerOperatorContext';

async function database() {
  const db = await getDb();
  if (!db) throw new AssignmentError(503, 'Database unavailable');
  return db;
}

export async function saveHandoffNote(taskId: string, workerId: number, notes: string, actor: AssignmentActor): Promise<boolean> {
  return withLockedAssignment(await database(), actor, taskId, async (tx, assignment) => {
    if (assignment.vaId !== workerId) throw new AssignmentError(404, 'Assigned task not found');
    const result = await tx.update(taskAssignments).set({ handoffNotes: notes, lastWorkedAt: new Date() })
      .where(eq(taskAssignments.id, assignment.id));
    if (result.rowCount !== 1) throw new AssignmentError(409, 'Assignment changed; reload before trying again');
    return true;
  });
}

export async function getHandoffContext(taskId: string, actor: AssignmentActor, workerId?: number) {
  return withLockedAssignment(await database(), actor, taskId, async (_tx, assignment) => {
    if (workerId !== undefined && assignment.vaId !== workerId) throw new AssignmentError(404, 'Assigned task not found');
    return { notes: assignment.handoffNotes, lastWorkedAt: assignment.lastWorkedAt, vaId: assignment.vaId };
  });
}

export async function generateShiftSummary(workerId: number, actor: AssignmentActor): Promise<boolean> {
  const db = await database();
  const [observed] = await db.select().from(vaProfiles).where(eq(vaProfiles.id, workerId)).limit(1);
  if (!observed) throw new AssignmentError(404, 'Worker profile not found');
  return db.transaction(async tx => {
    const accounts = new Map<number, User>();
    for (const id of [...new Set([actor.id, observed.userId, observed.founderId])].sort((a, b) => a - b)) {
      const [account] = await tx.select().from(users).where(eq(users.id, id)).for('no key update');
      if (account) accounts.set(id, account);
    }
    const freshActor = accounts.get(actor.id);
    if (!freshActor || freshActor.role !== actor.role || !['admin', 'worker'].includes(freshActor.role)) {
      throw new AssignmentError(403, 'Account permissions changed');
    }
    if (freshActor.role === 'worker' && freshActor.id !== observed.userId) throw new AssignmentError(403, 'Worker access denied');
    if (freshActor.role === 'admin' && freshActor.id !== observed.founderId) throw new AssignmentError(404, 'Worker profile not found');
    if (accounts.get(observed.founderId)?.role !== 'admin' || accounts.get(observed.userId)?.role !== 'worker') {
      throw new AssignmentError(403, 'Worker or founder access changed');
    }
    const profiles = await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, observed.userId))
      .orderBy(vaProfiles.id).for('update');
    const worker = selectWorkerProfile(profiles);
    if (!worker || worker.id !== workerId || worker.founderId !== observed.founderId) throw new AssignmentError(409, 'Worker ownership changed');
    const founderId = worker.founderId;
    const founderRows = await tx.select().from(taskAssignments)
      .where(eq(taskAssignments.founderId, founderId)).orderBy(taskAssignments.taskId, taskAssignments.id);
    assertCanonicalAssignmentRows(founderRows);
    const assignments = founderRows.filter(row => row.vaId === workerId);
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: worker.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: string) => dateParts.find(part => part.type === type)?.value ?? '';
    const briefingDate = `${value('year')}-${value('month')}-${value('day')}`;
    const content = JSON.stringify({
      generatedAt: new Date().toISOString(),
      counts: assignments.reduce<Record<string, number>>((counts, task) => {
        counts[task.status] = (counts[task.status] ?? 0) + 1;
        return counts;
      }, {}),
      handoffs: assignments.filter(task => task.handoffNotes?.trim()).map(task => ({
        taskId: task.taskId, status: task.status, notes: task.handoffNotes, lastWorkedAt: task.lastWorkedAt,
      })),
    });
    const [existing] = await tx.select({ id: dailyBriefings.id }).from(dailyBriefings).where(and(
      eq(dailyBriefings.vaId, workerId), eq(dailyBriefings.founderId, founderId),
      eq(dailyBriefings.briefingDate, briefingDate), eq(dailyBriefings.briefingType, 'end_of_day'),
    )).limit(1);
    if (existing) await tx.update(dailyBriefings).set({ content }).where(eq(dailyBriefings.id, existing.id));
    else await tx.insert(dailyBriefings).values({ vaId: workerId, founderId,
      briefingDate, briefingType: 'end_of_day', content });
    return true;
  });
}
