import { recordedMinutes } from '../../shared/timerDuration';
import { timeCompleteness } from '../canonicalTimer';
/**
 * Trello Chatbot Service
 * 
 * A project manager bot that lives inside Trello comments.
 * Handles @bot mentions, worker check-ins, reminders, and progress tracking.
 */

import { getDb } from '../db';
import { eq, and, desc, gte, inArray, ne, sql } from 'drizzle-orm';
import { 
  atisCards, 
  atisCardUnderstanding, 
  aptlssPlans,
  taskAssignments,
  timeEntries, 
  vaProfiles 
} from '../../drizzle/schema.postgres';
import { managerPilotWorkerIds } from '../aptlssManagerPilot';
import { areNotificationsEnabled } from './notificationPolicy';
import { encodeTrelloPathSegment } from '../utils/trello-path';

const TRELLO_REQUEST_TIMEOUT_MS = 15_000;

function trelloCredentials() {
  const key = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  return key && token ? { key, token } : null;
}

// Bot command patterns
const BOT_MENTION_PATTERN = /@bot\s+(\w+)(?:\s+(.*))?/i;

export interface BotCommand {
  command: string;
  args: string[];
  rawArgs: string;
  cardId: string;
  commentId: string;
  authorId: string;
  authorName: string;
}

export interface BotResponse {
  text: string;
  mentions?: string[];
}

/**
 * Parse a comment for @bot commands
 */
export function parseBotCommand(
  commentText: string,
  cardId: string,
  commentId: string,
  authorId: string,
  authorName: string
): BotCommand | null {
  const match = commentText.match(BOT_MENTION_PATTERN);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const rawArgs = match[2] || '';
  const args = rawArgs.split(/\s+/).filter(a => a.length > 0);

  return {
    command,
    args,
    rawArgs,
    cardId,
    commentId,
    authorId,
    authorName,
  };
}

export function isTrelloCommentAutomationEnabled(env: Record<string, string | undefined> = process.env) {
  return areNotificationsEnabled(env);
}

export const TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE =
  'Trello comment automation is disabled. Set NOTIFICATIONS_ENABLED=true after reviewing the outbound-action policy.';

const APTLSS_PILOT_CARD_LOOKUP_LIMIT = 101;

type TrelloCommentAttempt = { posted: true } | { posted: false; failureReason: string };
type TrelloCommentOrigin = { kind: 'webhook'; authorTrelloMemberId?: unknown };

function hasAptlssPilotConfiguration() {
  return Boolean(process.env.APTLSS_MANAGER_PILOT_WORKER_IDS?.trim());
}

async function getAptlssPilotCommentHoldReason(cardId: string, origin?: TrelloCommentOrigin): Promise<string | null> {
  if (!hasAptlssPilotConfiguration()) return null;
  if (process.env.APTLSS_MANAGER_SHADOW_ONLY !== 'true') {
    return 'Held for worker review because APTLSS pilot automation requires shadow-only mode.';
  }

  const pilotWorkerIds = managerPilotWorkerIds();
  if (pilotWorkerIds.length === 0) {
    return 'Held for worker review because the APTLSS pilot worker configuration is invalid.';
  }

  try {
    const db = await getDb();
    if (!db) return 'Held for worker review because APTLSS card ownership could not be verified.';

    if (origin?.kind === 'webhook') {
      const authorTrelloMemberId = typeof origin.authorTrelloMemberId === 'string'
        ? origin.authorTrelloMemberId.trim()
        : '';
      if (!authorTrelloMemberId) {
        return 'Held for worker review because the Trello author could not be verified.';
      }

      const authors = await db
        .select({ vaId: vaProfiles.userId })
        .from(vaProfiles)
        .where(eq(vaProfiles.trelloMemberId, authorTrelloMemberId))
        .limit(APTLSS_PILOT_CARD_LOOKUP_LIMIT);
      if (authors.length === 0 || authors.length >= APTLSS_PILOT_CARD_LOOKUP_LIMIT) {
        return 'Held for worker review because the Trello author could not be verified.';
      }
      if (authors.some(author => pilotWorkerIds.includes(author.vaId))) {
        return 'Held for worker review. APTLSS pilot workers cannot trigger automatic Trello replies.';
      }
    }

    const [plans, assignments] = await Promise.all([
      db
        .select({ vaId: aptlssPlans.vaId })
        .from(aptlssPlans)
        .where(eq(aptlssPlans.cardId, cardId))
        .limit(APTLSS_PILOT_CARD_LOOKUP_LIMIT),
      db
        .select({ vaId: vaProfiles.userId })
        .from(taskAssignments)
        .innerJoin(vaProfiles, eq(taskAssignments.vaId, vaProfiles.id))
        .where(and(eq(taskAssignments.taskId, cardId), ne(taskAssignments.status, 'completed')))
        .limit(APTLSS_PILOT_CARD_LOOKUP_LIMIT),
    ]);

    if (plans.length === 0 || plans.length >= APTLSS_PILOT_CARD_LOOKUP_LIMIT || assignments.length >= APTLSS_PILOT_CARD_LOOKUP_LIMIT) {
      return 'Held for worker review because APTLSS card ownership could not be verified.';
    }
    if (plans.some(plan => pilotWorkerIds.includes(plan.vaId)) || assignments.some(assignment => pilotWorkerIds.includes(assignment.vaId))) {
      return 'Held for worker review. The VA must review and explicitly post this comment.';
    }
    return null;
  } catch (error) {
    console.error('[TrelloChatbot] Could not verify APTLSS card ownership; holding automated comment', error);
    return 'Held for worker review because APTLSS card ownership could not be verified.';
  }
}

async function attemptTrelloComment(
  cardId: string,
  text: string,
  origin?: TrelloCommentOrigin,
): Promise<TrelloCommentAttempt> {
  if (!isTrelloCommentAutomationEnabled()) {
    console.log(`[TrelloChatbot] ${TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE}`);
    return { posted: false, failureReason: TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE };
  }

  const holdReason = await getAptlssPilotCommentHoldReason(cardId, origin);
  if (holdReason) {
    console.log(`[TrelloChatbot] ${holdReason}`);
    return { posted: false, failureReason: holdReason };
  }

  const encodedCardId = encodeTrelloPathSegment(cardId);
  if (!encodedCardId) return { posted: false, failureReason: "Invalid Trello card ID" };
  const credentials = trelloCredentials();
  if (!credentials) {
    console.error('[TrelloChatbot] Cannot post comment because Trello credentials are not configured');
    return { posted: false, failureReason: 'Trello credentials are not configured.' };
  }

  try {
    const response = await fetch(
      `https://api.trello.com/1/cards/${encodedCardId}/actions/comments?${new URLSearchParams(credentials).toString()}`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS),
      }
    );
    return response.ok
      ? { posted: true }
      : { posted: false, failureReason: 'Trello did not accept the comment.' };
  } catch (error) {
    console.error('[TrelloChatbot] Failed to post comment:', error);
    return { posted: false, failureReason: 'The Trello comment request failed before success could be confirmed.' };
  }
}

/**
 * Post a comment to a Trello card
 */
export async function postTrelloComment(cardId: string, text: string): Promise<boolean> {
  return (await attemptTrelloComment(cardId, text)).posted;
}

/**
 * Get card progress information
 */
async function getCardProgress(trelloCardId: string, memberId?: string): Promise<{
  cardName: string;
  totalSteps: number;
  completedSteps: number;
  timeTrackedToday: number | null;
  timeTrackedTotal: number | null;
  lastActivity: Date | null;
  checklist: Array<{ step: string; completed: boolean; type: string }>;
} | null> {
  try {
    const db = await getDb();
    if (!db) return null;

    // Get card from database
    const cardResult = await db
      .select()
      .from(atisCards)
      .where(eq(atisCards.trelloId, trelloCardId))
      .limit(1);

    const card = cardResult[0];
    if (!card) return null;

    // Get AI understanding with checklist
    const understandingResult = await db
      .select()
      .from(atisCardUnderstanding)
      .where(eq(atisCardUnderstanding.cardId, card.id))
      .orderBy(desc(atisCardUnderstanding.createdAt))
      .limit(1);

    const understanding = understandingResult[0];

    // Get step completions from raw SQL (table exists but not in schema exports)
    const completionsResult = await db.execute(
      sql`SELECT step_index FROM atis_checklist_completion WHERE card_id = ${card.id}`
    );
    const completionRows = completionsResult.rows;
    const completedStepIds = new Set(completionRows.map((c: any) => c.step_index));

    // Parse checklist from understanding
    let checklist: Array<{ step: string; completed: boolean; type: string }> = [];
    let totalSteps = 0;
    let completedSteps = 0;

    if (understanding?.aptlssChecklist) {
      try {
        const parsed = JSON.parse(understanding.aptlssChecklist);
        if (Array.isArray(parsed)) {
          checklist = parsed.map((item: any, index: number) => ({
            step: item.step || item.description || `Step ${index + 1}`,
            completed: completedStepIds.has(index),
            type: item.type || 'Task',
          }));
          totalSteps = checklist.length;
          completedSteps = checklist.filter(s => s.completed).length;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    const profiles = memberId ? await db.select().from(vaProfiles).where(and(eq(vaProfiles.trelloMemberId, memberId), eq(vaProfiles.status, 'active'))).limit(2) : [];
    const profile = profiles.length === 1 ? profiles[0] : null;
    const complete = profile ? (await timeCompleteness(db, profile.founderId)).complete : false;
    // Get time tracked today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Use taskId (varchar) for time entries lookup - match by trello card ID
    const timeEntriesToday = profile && complete ? await db
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.taskId, trelloCardId), eq(timeEntries.trackedUserId, profile.userId), eq(timeEntries.founderId, profile.founderId), eq(timeEntries.isVoided, false),
          gte(timeEntries.startTime, today)
        )
      ) : [];

    let timeTrackedToday = 0;
    for (const entry of timeEntriesToday) {
      if (entry.endTime) {
        timeTrackedToday += recordedMinutes(entry);
      }
    }

    // Get total time tracked
    const allTimeEntries = profile && complete ? await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.taskId, trelloCardId), eq(timeEntries.trackedUserId, profile.userId), eq(timeEntries.founderId, profile.founderId), eq(timeEntries.isVoided, false))) : [];

    let timeTrackedTotal = 0;
    let lastActivity: Date | null = null;
    for (const entry of allTimeEntries) {
      if (entry.endTime) {
        timeTrackedTotal += recordedMinutes(entry);
        if (!lastActivity || entry.endTime > lastActivity) {
          lastActivity = entry.endTime;
        }
      }
    }

    return {
      cardName: card.name,
      totalSteps,
      completedSteps,
      timeTrackedToday: complete ? Math.round(timeTrackedToday) : null,
      timeTrackedTotal: complete ? Math.round(timeTrackedTotal) : null,
      lastActivity,
      checklist,
    };
  } catch (error) {
    console.error('[TrelloChatbot] Failed to get card progress:', error);
    return null;
  }
}

/**
 * Get worker by name or mention
 */
async function getWorkerByName(name: string): Promise<{
  id: number;
  name: string;
  email: string;
} | null> {
  try {
    const db = await getDb();
    if (!db) return null;

    const workerResult = await db
      .select()
      .from(vaProfiles)
      .where(sql`LOWER(${vaProfiles.name}) LIKE LOWER(${`%${name}%`})`)
      .limit(1);

    const worker = workerResult[0];
    if (worker) {
      return {
        id: worker.id,
        name: worker.name,
        email: worker.email || '',
      };
    }
    return null;
  } catch (error) {
    console.error('[TrelloChatbot] Failed to get worker:', error);
    return null;
  }
}

/**
 * Format time in minutes to human-readable string
 */
function formatTime(minutes: number | null): string {
  if (minutes === null) return 'Unavailable: canonical worker context or ownership review required';
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Handle @bot status command
 * Shows current task progress
 */
async function handleStatusCommand(cmd: BotCommand): Promise<BotResponse> {
  const progress = await getCardProgress(cmd.cardId, cmd.authorId);
  
  if (!progress) {
    return {
      text: `📊 **Status Update**\n\nI couldn't find progress data for this card. Make sure it has been analyzed by APTLSS.`,
    };
  }

  const completionPercent = progress.totalSteps > 0 
    ? Math.round((progress.completedSteps / progress.totalSteps) * 100) 
    : 0;

  let statusEmoji = '🔴';
  if (completionPercent >= 100) statusEmoji = '✅';
  else if (completionPercent >= 75) statusEmoji = '🟢';
  else if (completionPercent >= 50) statusEmoji = '🟡';
  else if (completionPercent >= 25) statusEmoji = '🟠';

  let text = `📊 **Status Update**\n\n`;
  text += `${statusEmoji} **Progress:** ${progress.completedSteps}/${progress.totalSteps} steps (${completionPercent}%)\n`;
  text += `⏱️ **Time Today:** ${formatTime(progress.timeTrackedToday)}\n`;
  text += `📈 **Total Time:** ${formatTime(progress.timeTrackedTotal)}\n`;

  if (progress.lastActivity) {
    const lastActivityStr = progress.lastActivity.toLocaleString();
    text += `🕐 **Last Activity:** ${lastActivityStr}\n`;
  }

  // Show incomplete steps
  const incompleteSteps = progress.checklist.filter(s => !s.completed);
  if (incompleteSteps.length > 0 && incompleteSteps.length <= 5) {
    text += `\n**Remaining Steps:**\n`;
    incompleteSteps.forEach((step, i) => {
      text += `${i + 1}. ${step.step}\n`;
    });
  } else if (incompleteSteps.length > 5) {
    text += `\n**Next Steps:**\n`;
    incompleteSteps.slice(0, 3).forEach((step, i) => {
      text += `${i + 1}. ${step.step}\n`;
    });
    text += `...and ${incompleteSteps.length - 3} more steps\n`;
  }

  return { text };
}

/**
 * Handle @bot checkin command
 * Ask worker for progress update
 */
async function handleCheckinCommand(cmd: BotCommand): Promise<BotResponse> {
  const progress = await getCardProgress(cmd.cardId, cmd.authorId);
  
  let text = `👋 **Progress Check-in**\n\n`;
  text += `Hi ${cmd.authorName}! How's this task going?\n\n`;

  if (progress) {
    const incompleteSteps = progress.checklist.filter(s => !s.completed);
    if (incompleteSteps.length > 0) {
      text += `📋 **Current step:** ${incompleteSteps[0].step}\n\n`;
    }
    text += `You've completed ${progress.completedSteps}/${progress.totalSteps} steps so far.\n\n`;
  }

  text += `Please reply with:\n`;
  text += `• What you've accomplished\n`;
  text += `• Any blockers or questions\n`;
  text += `• Estimated time to completion\n`;

  return { text };
}

/**
 * Handle @bot remind command
 * Send reminder to specific worker
 */
async function handleRemindCommand(cmd: BotCommand): Promise<BotResponse> {
  // Extract worker name from args
  const workerMention = cmd.args.find(a => a.startsWith('@'));
  const workerName = workerMention ? workerMention.slice(1) : cmd.args[0];
  
  if (!workerName) {
    return {
      text: `⚠️ **Usage:** @bot remind @workername [message]\n\nExample: @bot remind @worker Please update the status on this task`,
    };
  }

  const worker = await getWorkerByName(workerName);
  const progress = await getCardProgress(cmd.cardId, cmd.authorId);

  let text = `🔔 **Reminder**\n\n`;
  
  if (worker) {
    text += `@${worker.name}, `;
  } else {
    text += `@${workerName}, `;
  }

  // Custom message if provided
  const customMessage = cmd.args.slice(workerMention ? 1 : 1).join(' ');
  if (customMessage) {
    text += `${customMessage}\n\n`;
  } else {
    text += `please check in on this task.\n\n`;
  }

  if (progress) {
    text += `📊 **Current Status:**\n`;
    text += `• ${progress.completedSteps}/${progress.totalSteps} steps completed\n`;
    text += `• ${formatTime(progress.timeTrackedToday)} tracked today\n`;
    
    const incompleteSteps = progress.checklist.filter(s => !s.completed);
    if (incompleteSteps.length > 0) {
      text += `\n**Next step:** ${incompleteSteps[0].step}\n`;
    }
  }

  return { 
    text,
    mentions: worker ? [worker.name] : [workerName],
  };
}

/**
 * Handle @bot time command
 * Show time tracked on this card
 */
async function handleTimeCommand(cmd: BotCommand): Promise<BotResponse> {
  const progress = await getCardProgress(cmd.cardId, cmd.authorId);
  
  if (!progress) {
    return {
      text: `⏱️ **Time Tracking**\n\nNo time entries found for this card.`,
    };
  }

  let text = `⏱️ **Time Tracking**\n\n`;
  text += `**Today:** ${formatTime(progress.timeTrackedToday)}\n`;
  text += `**Total:** ${formatTime(progress.timeTrackedTotal)}\n`;

  if (progress.lastActivity) {
    const lastActivityStr = progress.lastActivity.toLocaleString();
    text += `**Last Activity:** ${lastActivityStr}\n`;
  }

  // Calculate estimated remaining time based on progress
  if (progress.timeTrackedTotal !== null && progress.totalSteps > 0 && progress.completedSteps > 0 && progress.completedSteps < progress.totalSteps) {
    const avgTimePerStep = progress.timeTrackedTotal / progress.completedSteps;
    const remainingSteps = progress.totalSteps - progress.completedSteps;
    const estimatedRemaining = Math.round(avgTimePerStep * remainingSteps);
    text += `\n**Estimated Remaining:** ~${formatTime(estimatedRemaining)} (based on avg pace)\n`;
  }

  return { text };
}

/**
 * Handle @bot progress command
 * Show detailed progress breakdown
 */
async function handleProgressCommand(cmd: BotCommand): Promise<BotResponse> {
  const progress = await getCardProgress(cmd.cardId, cmd.authorId);
  
  if (!progress) {
    return {
      text: `📈 **Progress Report**\n\nNo progress data found. Please ensure this card has been analyzed by APTLSS.`,
    };
  }

  const completionPercent = progress.totalSteps > 0 
    ? Math.round((progress.completedSteps / progress.totalSteps) * 100) 
    : 0;

  let text = `📈 **Progress Report: ${progress.cardName}**\n\n`;
  
  // Progress bar visualization
  const barLength = 10;
  const filledBars = Math.round((completionPercent / 100) * barLength);
  const progressBar = '█'.repeat(filledBars) + '░'.repeat(barLength - filledBars);
  text += `[${progressBar}] ${completionPercent}%\n\n`;

  text += `**Steps:** ${progress.completedSteps}/${progress.totalSteps}\n`;
  text += `**Time Invested:** ${formatTime(progress.timeTrackedTotal)}\n\n`;

  // Show checklist with status
  if (progress.checklist.length > 0) {
    text += `**Checklist:**\n`;
    progress.checklist.forEach((step) => {
      const icon = step.completed ? '✅' : '⬜';
      const typeIcon = getTypeIcon(step.type);
      text += `${icon} ${typeIcon} ${step.step}\n`;
    });
  }

  return { text };
}

/**
 * Get icon for step type
 */
function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    'Action': '🎯',
    'Process': '⚙️',
    'Task': '📝',
    'Learn': '📚',
    'Support': '🤝',
    'Communication': '💬',
    'Review': '👀',
    'Research': '🔍',
  };
  return icons[type] || '📌';
}

/**
 * Handle @bot help command
 * Show available commands
 */
async function handleHelpCommand(): Promise<BotResponse> {
  let text = `🤖 **Bot Commands**\n\n`;
  text += `I'm your project manager assistant! Here's what I can do:\n\n`;
  text += `**@bot status** - Show current task progress, time tracked, and remaining steps\n\n`;
  text += `**@bot checkin** - Request a progress update (I'll ask how things are going)\n\n`;
  text += `**@bot remind @worker [message]** - Send a reminder to a specific worker\n\n`;
  text += `**@bot time** - Show time tracking summary for this card\n\n`;
  text += `**@bot progress** - Show detailed progress breakdown with checklist\n\n`;
  text += `**@bot help** - Show this help message\n\n`;
  text += `---\n`;
  text += `💡 **Tip:** I check in automatically at scheduled times to ask about progress!`;

  return { text };
}

/**
 * Process a bot command and generate response
 */
export async function processBotCommand(cmd: BotCommand): Promise<BotResponse> {
  console.log(`[TrelloChatbot] Processing command: ${cmd.command} from ${cmd.authorName}`);

  switch (cmd.command) {
    case 'status':
      return handleStatusCommand(cmd);
    case 'checkin':
    case 'check':
    case 'update':
      return handleCheckinCommand(cmd);
    case 'remind':
    case 'reminder':
    case 'ping':
      return handleRemindCommand(cmd);
    case 'time':
    case 'timer':
    case 'hours':
      return handleTimeCommand(cmd);
    case 'progress':
    case 'report':
      return handleProgressCommand(cmd);
    case 'help':
    case '?':
      return handleHelpCommand();
    default:
      return {
        text: `🤔 I don't recognize the command "${cmd.command}". Type **@bot help** to see available commands.`,
      };
  }
}

/**
 * Handle incoming Trello webhook for comment events
 */
export async function handleTrelloWebhook(payload: any): Promise<void> {
  try {
    // Check if this is a comment action
    if (payload.action?.type !== 'commentCard') {
      return;
    }

    const comment = payload.action.data?.text;
    const cardId = payload.action.data?.card?.id;
    const cardName = payload.action.data?.card?.name;
    const boardId = payload.action.data?.board?.id;
    const commentId = payload.action.id;
    const authorId = payload.action.memberCreator?.id;
    const authorName = payload.action.memberCreator?.fullName || payload.action.memberCreator?.username || 'Unknown';

    if (!comment || !cardId) {
      return;
    }

    // Check if comment mentions @bot
    if (!comment.toLowerCase().includes('@bot')) {
      return;
    }

    if (!isTrelloCommentAutomationEnabled()) {
      console.log(`[TrelloChatbot] ${TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE}`);
      return;
    }

    console.log(`[TrelloChatbot] Received @bot mention from ${authorName} on card ${cardId}`);

    // Parse the command
    const cmd = parseBotCommand(comment, cardId, commentId, authorId, authorName);
    
    // Import AI handler for natural language queries
    const { isNaturalLanguageQuery, handleNaturalLanguageQuery } = await import('./ai-chatbot-handler');
    
    // Store conversation in history
    const { storeConversation, updateConversationResponse } = await import('./chatbot-history');
    
    let response: BotResponse;
    let commandType = 'unknown';
    
    // Check if this is a natural language query (not a command)
    if (isNaturalLanguageQuery(comment)) {
      console.log('[TrelloChatbot] Detected natural language query, using AI response');
      commandType = 'ai_query';
      
      // Create a pseudo-command for the AI handler
      const aiCmd: BotCommand = {
        command: 'ai_query',
        args: comment.replace(/@bot\s*/i, '').trim().split(/\s+/),
        rawArgs: comment.replace(/@bot\s*/i, '').trim(),
        cardId,
        commentId,
        authorId,
        authorName,
      };
      
      response = await handleNaturalLanguageQuery(aiCmd);
    } else if (cmd) {
      // Process as a standard command
      commandType = cmd.command;
      response = await processBotCommand(cmd);
    } else {
      console.log('[TrelloChatbot] Could not parse command from comment');
      return;
    }
    
    const conversationId = await storeConversation({
      cardTrelloId: cardId,
      cardName: cardName,
      boardTrelloId: boardId,
      command: commandType,
      commandArgs: cmd?.args || [],
      authorTrelloId: authorId,
      authorName: authorName,
      incomingCommentId: commentId,
      responseStatus: 'pending',
      receivedAt: new Date(),
    });

    // Post response as comment
    const commentAttempt = await attemptTrelloComment(cardId, response.text, {
      kind: 'webhook',
      authorTrelloMemberId: authorId,
    });
    const posted = commentAttempt.posted;
    
    // Update conversation with response
    if (conversationId) {
      await updateConversationResponse(
        conversationId,
        '', // We don't get the response comment ID back from Trello
        response.text,
        posted ? 'success' : 'failed',
        posted ? undefined : commentAttempt.failureReason
      );
    }

    if (posted) {
      console.log(`[TrelloChatbot] Posted response to card ${cardId}`);
    } else {
      console.error(`[TrelloChatbot] Failed to post response to card ${cardId}`);
    }
  } catch (error) {
    console.error('[TrelloChatbot] Error handling webhook:', error);
  }
}

/**
 * Send a scheduled check-in to a card
 */
export async function sendScheduledCheckin(
  cardId: string, 
  workerName?: string
): Promise<boolean> {
  const progress = await getCardProgress(cardId);
  
  let text = `👋 **Scheduled Check-in**\n\n`;
  
  if (workerName) {
    text += `Hi @${workerName}! `;
  }
  
  text += `How's progress on this task?\n\n`;

  if (progress) {
    const completionPercent = progress.totalSteps > 0 
      ? Math.round((progress.completedSteps / progress.totalSteps) * 100) 
      : 0;
    
    text += `📊 **Current Status:** ${completionPercent}% complete (${progress.completedSteps}/${progress.totalSteps} steps)\n`;
    text += `⏱️ **Time Today:** ${formatTime(progress.timeTrackedToday)}\n\n`;

    const incompleteSteps = progress.checklist.filter(s => !s.completed);
    if (incompleteSteps.length > 0) {
      text += `**Next step:** ${incompleteSteps[0].step}\n\n`;
    }
  }

  text += `Please reply with your update! 💬`;

  return postTrelloComment(cardId, text);
}

/**
 * Send end-of-day summary to a card
 */
export async function sendEODSummary(cardId: string): Promise<boolean> {
  const progress = await getCardProgress(cardId);
  
  if (!progress) {
    return false;
  }

  const completionPercent = progress.totalSteps > 0 
    ? Math.round((progress.completedSteps / progress.totalSteps) * 100) 
    : 0;

  let text = `📋 **End of Day Summary**\n\n`;
  text += `**Progress:** ${completionPercent}% (${progress.completedSteps}/${progress.totalSteps} steps)\n`;
  text += `**Time Tracked Today:** ${formatTime(progress.timeTrackedToday)}\n`;
  text += `**Total Time:** ${formatTime(progress.timeTrackedTotal)}\n\n`;

  // Show what was completed today (would need to track this)
  const incompleteSteps = progress.checklist.filter(s => !s.completed);
  if (incompleteSteps.length > 0) {
    text += `**Tomorrow's Focus:**\n`;
    incompleteSteps.slice(0, 3).forEach((step, i) => {
      text += `${i + 1}. ${step.step}\n`;
    });
    if (incompleteSteps.length > 3) {
      text += `...and ${incompleteSteps.length - 3} more steps\n`;
    }
  } else {
    text += `🎉 **All steps completed!** Great work!\n`;
  }

  return postTrelloComment(cardId, text);
}

export default {
  parseBotCommand,
  processBotCommand,
  postTrelloComment,
  handleTrelloWebhook,
  sendScheduledCheckin,
  sendEODSummary,
};
