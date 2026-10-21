import { recordedMinutes } from '../../shared/timerDuration';
import { timeCompleteness } from '../canonicalTimer';
import { dateKeyInTimeZone, dateWindowInTimeZone } from '../../shared/workerTime';
import { resolveWorkerOperatorContextById } from '../workerOperatorContext';
/**
 * Context Aggregator Service
 * 
 * Collects and formats all relevant context for a Trello card to provide
 * to the AI service for generating intelligent, context-aware responses.
 * 
 * Context includes:
 * - Card title and description
 * - APTLSS/ATIS checklist steps and completion status
 * - Time entries and estimates
 * - Previous comments
 * - Worker profile information
 * - Due dates and deadlines
 */

import { getDb } from '../db';
import { vaProfiles, timeEntries, atisCardUnderstanding } from '../../drizzle/schema.postgres';
import { eq, and, desc } from 'drizzle-orm';
import { fetchWithRetry } from '../utils/retry';

function trelloUrl(path: string, parameters: Record<string, string>): string {
  const key = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  if (!key || !token) {
    throw new Error('Trello credentials are not configured');
  }
  return `https://api.trello.com/1/${path}?${new URLSearchParams({ key, token, ...parameters }).toString()}`;
}

interface CardContext {
  cardId: string;
  cardTitle: string;
  cardDescription: string;
  boardName: string;
  listName: string;
  dueDate: string | null;
  labels: string[];
  checklists: ChecklistContext[];
  recentComments: CommentContext[];
  timeTracking: TimeTrackingContext;
  workerInfo: WorkerContext | null;
  atisAnalysis: AtisContext | null;
}

interface ChecklistContext {
  name: string;
  items: {
    name: string;
    completed: boolean;
    position: number;
  }[];
  completionRate: number;
}

interface CommentContext {
  author: string;
  text: string;
  date: string;
}

interface TimeTrackingContext {
  complete: boolean;
  totalMinutesToday: number;
  totalMinutesAllTime: number;
  estimatedMinutes: number | null;
  entries: {
    date: string;
    minutes: number;
    description: string | null;
  }[];
}

interface WorkerContext {
  name: string;
  email: string | null;
  timezone: string | null;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
}

interface AtisContext {
  goal: string | null;
  deliverable: string | null;
  steps: string[];
  estimatedDuration: number | null;
}

/**
 * Fetch card details from Trello API
 */
async function fetchCardFromTrello(cardId: string): Promise<any> {
  const url = trelloUrl(`cards/${encodeURIComponent(cardId)}`, {
    fields: 'name,desc,due,labels,idBoard,idList',
    checklists: 'all',
    actions: 'commentCard',
    actions_limit: '10',
  });
  
  const response = await fetchWithRetry(url, undefined, { maxRetries: 0 });
  if (!response.ok) {
    throw new Error(`Failed to fetch card from Trello: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Fetch board name from Trello
 */
async function fetchBoardName(boardId: string): Promise<string> {
  const url = trelloUrl(`boards/${encodeURIComponent(boardId)}`, { fields: 'name' });
  
  try {
    const response = await fetchWithRetry(url, undefined, { maxRetries: 0 });
    if (response.ok) {
      const data = await response.json();
      return data.name;
    }
  } catch (error) {
    console.error('[ContextAggregator] Failed to fetch board name:', error);
  }
  return 'Unknown Board';
}

/**
 * Fetch list name from Trello
 */
async function fetchListName(listId: string): Promise<string> {
  const url = trelloUrl(`lists/${encodeURIComponent(listId)}`, { fields: 'name' });
  
  try {
    const response = await fetchWithRetry(url, undefined, { maxRetries: 0 });
    if (response.ok) {
      const data = await response.json();
      return data.name;
    }
  } catch (error) {
    console.error('[ContextAggregator] Failed to fetch list name:', error);
  }
  return 'Unknown List';
}

/**
 * Get time tracking data for a card
 */
async function getTimeTrackingData(cardId: string, trackedUserId?: number): Promise<TimeTrackingContext> {
  const db = await getDb();
  if (!db || !trackedUserId) {
    return {
      complete: false,
      totalMinutesToday: 0,
      totalMinutesAllTime: 0,
      estimatedMinutes: null,
      entries: []
    };
  }
  
  const profiles = await db.select().from(vaProfiles).where(and(eq(vaProfiles.userId, trackedUserId), eq(vaProfiles.status, 'active')));
  if (profiles.length !== 1) return { complete: false, totalMinutesToday: 0, totalMinutesAllTime: 0, estimatedMinutes: null, entries: [] };
  const worker = await resolveWorkerOperatorContextById(trackedUserId, db);
  if (worker.profileId !== profiles[0].id || worker.founderId !== profiles[0].founderId) {
    return { complete: false, totalMinutesToday: 0, totalMinutesAllTime: 0, estimatedMinutes: null, entries: [] };
  }
  const completeness = await timeCompleteness(db, profiles[0].founderId);
  // Use taskId field which stores the Trello card ID
  const entries = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.taskId, cardId), eq(timeEntries.trackedUserId, trackedUserId), eq(timeEntries.founderId, profiles[0].founderId), eq(timeEntries.isVoided, false)))
    .orderBy(desc(timeEntries.startTime))
    .limit(5001);

  const today = dateWindowInTimeZone(dateKeyInTimeZone(new Date(), worker.timezone), worker.timezone);
  
  let totalMinutesToday = 0;
  let totalMinutesAllTime = 0;
  
  const formattedEntries = entries.map((entry: any) => {
    const minutes = recordedMinutes(entry);
    totalMinutesAllTime += minutes;
    
    if (entry.startTime && new Date(entry.startTime) >= today.start && new Date(entry.startTime) < today.endExclusive) {
      totalMinutesToday += minutes;
    }
    
    return {
      date: entry.startTime ? new Date(entry.startTime).toISOString() : '',
      minutes,
      description: entry.description
    };
  });

  return {
    complete: completeness.complete && entries.length <= 5000,
    totalMinutesToday,
    totalMinutesAllTime,
    estimatedMinutes: null, // Will be filled from ATIS analysis
    entries: formattedEntries
  };
}

/**
 * Get worker profile information
 */
async function getWorkerInfo(vaId: number): Promise<WorkerContext | null> {
  const db = await getDb();
  if (!db) return null;
  
  try {
    const worker = await resolveWorkerOperatorContextById(vaId, db);
    if (!worker.profileId) return null;
    const profiles = await db
      .select()
      .from(vaProfiles)
      .where(and(eq(vaProfiles.id, worker.profileId), eq(vaProfiles.userId, vaId), eq(vaProfiles.founderId, worker.founderId!)))
      .limit(1);

    if (profiles.length > 0) {
      const profile = profiles[0];
      return {
        name: worker.displayName,
        email: profile.email || null,
        timezone: worker.timezone,
        workingHoursStart: worker.workStartTime,
        workingHoursEnd: worker.workEndTime
      };
    }
  } catch (error) {
    console.error('[ContextAggregator] Failed to get worker info');
  }
  
  return null;
}

/**
 * Get ATIS analysis for a card
 */
async function getAtisAnalysis(cardTrelloId: string): Promise<AtisContext | null> {
  const db = await getDb();
  if (!db) return null;
  
  try {
    const analyses = await db
      .select()
      .from(atisCardUnderstanding)
      .where(eq(atisCardUnderstanding.cardTrelloId, cardTrelloId))
      .limit(1);

    if (analyses.length > 0) {
      const analysis = analyses[0];
      return {
        goal: analysis.goal,
        deliverable: analysis.deliverable,
        steps: [], // Steps would need to be parsed from the analysis
        estimatedDuration: analysis.estimatedMinutes
      };
    }
  } catch (error) {
    console.error('[ContextAggregator] Failed to get ATIS analysis:', error);
  }
  
  return null;
}

/**
 * Aggregate all context for a card
 */
export async function aggregateCardContext(cardId: string, vaId?: number): Promise<CardContext> {
  // Fetch card from Trello
  const card = await fetchCardFromTrello(cardId);
  
  // Fetch board and list names
  const [boardName, listName] = await Promise.all([
    fetchBoardName(card.idBoard),
    fetchListName(card.idList)
  ]);
  
  // Process checklists
  const checklists: ChecklistContext[] = (card.checklists || []).map((checklist: any) => {
    const items = (checklist.checkItems || []).map((item: any) => ({
      name: item.name,
      completed: item.state === 'complete',
      position: item.pos
    })).sort((a: any, b: any) => a.position - b.position);
    
    const completedCount = items.filter((i: any) => i.completed).length;
    const completionRate = items.length > 0 ? (completedCount / items.length) * 100 : 0;
    
    return {
      name: checklist.name,
      items,
      completionRate
    };
  });
  
  // Process comments
  const recentComments: CommentContext[] = (card.actions || [])
    .filter((action: any) => action.type === 'commentCard')
    .map((action: any) => ({
      author: action.memberCreator?.fullName || 'Unknown',
      text: action.data?.text || '',
      date: action.date
    }));
  
  // Get time tracking data
  const timeTracking = await getTimeTrackingData(cardId, vaId);
  
  // Get worker info if VA ID provided
  const workerInfo = vaId ? await getWorkerInfo(vaId) : null;
  
  // Get ATIS analysis
  const atisAnalysis = await getAtisAnalysis(cardId);
  
  // Update estimated minutes from ATIS if available
  if (atisAnalysis?.estimatedDuration) {
    timeTracking.estimatedMinutes = atisAnalysis.estimatedDuration;
  }
  
  return {
    cardId,
    cardTitle: card.name,
    cardDescription: card.desc || '',
    boardName,
    listName,
    dueDate: card.due,
    labels: (card.labels || []).map((l: any) => l.name || l.color),
    checklists,
    recentComments,
    timeTracking,
    workerInfo,
    atisAnalysis
  };
}

/**
 * Format context into a string for AI consumption
 */
export function formatContextForAI(context: CardContext): string {
  const sections: string[] = [];
  
  // Card overview
  sections.push(`## Card: ${context.cardTitle}`);
  sections.push(`Board: ${context.boardName} | List: ${context.listName}`);
  
  if (context.dueDate) {
    const due = new Date(context.dueDate);
    sections.push(`Due: ${due.toLocaleDateString()} ${due.toLocaleTimeString()}`);
  }
  
  if (context.labels.length > 0) {
    sections.push(`Labels: ${context.labels.join(', ')}`);
  }
  
  // Description
  if (context.cardDescription) {
    sections.push(`\n## Description\n${context.cardDescription}`);
  }
  
  // ATIS Analysis
  if (context.atisAnalysis) {
    sections.push('\n## Task Analysis');
    if (context.atisAnalysis.goal) {
      sections.push(`Goal: ${context.atisAnalysis.goal}`);
    }
    if (context.atisAnalysis.deliverable) {
      sections.push(`Deliverable: ${context.atisAnalysis.deliverable}`);
    }
  }
  
  // Checklists
  if (context.checklists.length > 0) {
    sections.push('\n## Checklist Progress');
    for (const checklist of context.checklists) {
      sections.push(`\n### ${checklist.name} (${checklist.completionRate.toFixed(0)}% complete)`);
      for (const item of checklist.items) {
        const status = item.completed ? '✓' : '○';
        sections.push(`${status} ${item.name}`);
      }
    }
  }
  
  // Time tracking
  sections.push('\n## Time Tracking');
  sections.push(`Today: ${context.timeTracking.complete ? context.timeTracking.totalMinutesToday : 'Unavailable: ownership review required'} minutes`);
  sections.push(`Total: ${context.timeTracking.complete ? context.timeTracking.totalMinutesAllTime : 'Unavailable: ownership review required'} minutes`);
  if (context.timeTracking.estimatedMinutes) {
    sections.push(`Estimated: ${context.timeTracking.estimatedMinutes} minutes`);
  }
  
  // Worker info
  if (context.workerInfo) {
    sections.push('\n## Worker');
    sections.push(`Name: ${context.workerInfo.name}`);
    if (context.workerInfo.timezone) {
      sections.push(`Timezone: ${context.workerInfo.timezone}`);
    }
    if (context.workerInfo.workingHoursStart && context.workerInfo.workingHoursEnd) {
      sections.push(`Working Hours: ${context.workerInfo.workingHoursStart} - ${context.workerInfo.workingHoursEnd}`);
    }
  }
  
  // Recent comments (last 5)
  if (context.recentComments.length > 0) {
    sections.push('\n## Recent Comments');
    for (const comment of context.recentComments.slice(0, 5)) {
      const date = new Date(comment.date).toLocaleDateString();
      sections.push(`[${date}] ${comment.author}: ${comment.text.substring(0, 200)}${comment.text.length > 200 ? '...' : ''}`);
    }
  }
  
  return sections.join('\n');
}

export default {
  aggregateCardContext,
  formatContextForAI
};
