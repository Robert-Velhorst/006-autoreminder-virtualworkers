import { getDb } from '../db';
import { dailyBriefings, taskAssignments, vaProfiles } from '../../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';

export async function saveHandoffNote(taskId: string, workerId: number, notes: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    await db.update(taskAssignments)
      .set({ 
        handoffNotes: notes,
        lastWorkedAt: new Date()
      })
      .where(and(
        eq(taskAssignments.taskId, taskId),
        eq(taskAssignments.vaId, workerId)
      ));
    return true;
  } catch (error) {
    console.error('Failed to save handoff note:', error);
    return false;
  }
}

export async function getHandoffContext(taskId: string, workerId?: number): Promise<any> {
  const db = await getDb();
  if (!db) return null;

  try {
    const task = await db.select({
      notes: taskAssignments.handoffNotes,
      lastWorkedAt: taskAssignments.lastWorkedAt,
      vaId: taskAssignments.vaId
    }).from(taskAssignments)
      .where(workerId
        ? and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.vaId, workerId))
        : eq(taskAssignments.taskId, taskId))
      .limit(1);

    if (task.length === 0) return null;
    return task[0];
  } catch (error) {
    console.error('Failed to get handoff context:', error);
    return null;
  }
}

export async function generateShiftSummary(workerId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    const [worker] = await db.select().from(vaProfiles).where(eq(vaProfiles.id, workerId)).limit(1);
    if (!worker) return false;

    const assignments = await db.select({
      taskId: taskAssignments.taskId,
      status: taskAssignments.status,
      handoffNotes: taskAssignments.handoffNotes,
      lastWorkedAt: taskAssignments.lastWorkedAt,
    }).from(taskAssignments).where(eq(taskAssignments.vaId, workerId));

    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: worker.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: string) => dateParts.find(part => part.type === type)?.value ?? '';
    const briefingDate = `${value('year')}-${value('month')}-${value('day')}`;

    const content = JSON.stringify({
      generatedAt: new Date().toISOString(),
      counts: assignments.reduce<Record<string, number>>((counts, task) => {
        counts[task.status] = (counts[task.status] ?? 0) + 1;
        return counts;
      }, {}),
      handoffs: assignments
        .filter(task => task.handoffNotes?.trim())
        .map(task => ({
          taskId: task.taskId,
          status: task.status,
          notes: task.handoffNotes,
          lastWorkedAt: task.lastWorkedAt,
        })),
    });

    const [existing] = await db.select({ id: dailyBriefings.id }).from(dailyBriefings).where(and(
      eq(dailyBriefings.vaId, workerId),
      eq(dailyBriefings.briefingDate, briefingDate),
      eq(dailyBriefings.briefingType, 'end_of_day'),
    )).limit(1);

    if (existing) {
      await db.update(dailyBriefings).set({ content }).where(eq(dailyBriefings.id, existing.id));
    } else {
      await db.insert(dailyBriefings).values({
        vaId: workerId,
        founderId: worker.founderId,
        briefingDate,
        briefingType: 'end_of_day',
        content,
      });
    }

    return true;
  } catch (error) {
    console.error('Failed to generate shift summary:', error);
    return false;
  }
}
