/**
 * Interview Persistence Service
 * 
 * Manages interview sessions with database persistence instead of in-memory storage.
 * Supports all ATIS phases (1-10) with comprehensive state tracking.
 */

import { getDb } from '../db';
import { 
  interviewSessions, 
  interviewHistory, 
  interviewResults,
  type InsertInterviewSession,
  type InsertInterviewHistory,
  type InsertInterviewResult,
} from '../../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

interface InterviewState {
  phase: number;
  currentQuestion: number;
  questionsAsked: number;
  responsesProvided: number;
  overallConfidence: number;
  preAnalysisSummary?: string;
  responses: Map<string, string>;
  validationScores: Map<string, number>;
}

interface InterviewQuestion {
  phase: number;
  questionNumber: number;
  question: string;
  validationType: 'specificity' | 'measurable' | 'actionable' | 'complete';
}

/**
 * Create a new interview session
 */
export async function createInterviewSession(
  cardId: string,
  userId: number,
  userOpenId: string,
  preAnalysisSummary?: string
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  const sessionId = uuidv4();
  const initialState: InterviewState = {
    phase: 1,
    currentQuestion: 0,
    questionsAsked: 0,
    responsesProvided: 0,
    overallConfidence: 0,
    preAnalysisSummary,
    responses: new Map(),
    validationScores: new Map(),
  };

  const session: InsertInterviewSession = {
    id: sessionId,
    cardId,
    userId,
    userOpenId,
    status: 'active',
    currentPhase: 1,
    currentQuestion: 0,
    preAnalysisSummary,
    questionsAsked: 0,
    responsesProvided: 0,
    overallConfidence: 0,
    sessionData: JSON.stringify(initialState),
  };

  await db.insert(interviewSessions).values(session);
  return sessionId;
}

/**
 * Get interview session
 */
export async function getInterviewSession(sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  const [session] = await db.select()
    .from(interviewSessions)
    .where(eq(interviewSessions.id, sessionId))
    .limit(1);

  return session;
}

/**
 * Update interview session state
 */
export async function updateInterviewSessionState(
  sessionId: string,
  updates: {
    currentPhase?: number;
    currentQuestion?: number;
    questionsAsked?: number;
    responsesProvided?: number;
    overallConfidence?: number;
    preAnalysisSummary?: string;
    sessionData?: any;
    status?: 'active' | 'completed' | 'abandoned';
    completedAt?: Date | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  await db.update(interviewSessions)
    .set({
      currentPhase: updates.currentPhase,
      currentQuestion: updates.currentQuestion,
      questionsAsked: updates.questionsAsked,
      responsesProvided: updates.responsesProvided,
      overallConfidence: updates.overallConfidence,
      preAnalysisSummary: updates.preAnalysisSummary,
      sessionData: updates.sessionData !== undefined ? JSON.stringify(updates.sessionData) : undefined,
      status: updates.status,
      completedAt: updates.completedAt,
      updatedAt: new Date(),
    })
    .where(eq(interviewSessions.id, sessionId));
}

/**
 * Update interview session with new response
 */
export async function recordInterviewResponse(
  sessionId: string,
  phase: number,
  questionNumber: number,
  question: string,
  response: string,
  isValid: boolean,
  validationScore: number,
  validationNotes?: string,
  confidenceScore?: number,
  requiresEscalation?: boolean,
  sessionDataOverride?: any
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  // Record in history
  const historyId = uuidv4();
  
  // Get session to populate missing fields
  const session = await getInterviewSession(sessionId);
  if (!session) throw new Error('Session not found');

  const history: any = {
    id: historyId,
    sessionId,
    cardId: session.cardId,
    userOpenId: session.userOpenId,
    phase,
    questionNumber,
    question: question || 'N/A',
    response: response || 'N/A',
    isValid: isValid ? 1 : 0,
    validationScore,
    validationNotes,
    confidenceScore: confidenceScore || 0,
    requiresEscalation: requiresEscalation ? 1 : 0,
  };
  
  // Only add userId if session has it
  if (session.userId) {
    history.userId = session.userId;
  }

  try {
    await db.insert(interviewHistory).values(history as InsertInterviewHistory);
  } catch (insertError) {
    console.error('[Interview] Error inserting history:', insertError);
    // If the insert fails due to schema mismatch, log and continue
    // The session update will still happen
  }

  // Update session
  let currentState: any = {};
  try {
    if (sessionDataOverride) {
      currentState = typeof sessionDataOverride === 'string' 
        ? JSON.parse(sessionDataOverride) 
        : sessionDataOverride;
    } else if (session.sessionData) {
      currentState = typeof session.sessionData === 'string'
        ? JSON.parse(session.sessionData)
        : session.sessionData;
    }
  } catch (parseError) {
    console.error('[Interview] Error parsing session data:', parseError);
    currentState = {};
  }

  const validationCount = Array.isArray(currentState?.validations)
    ? currentState.validations.length
    : (session.questionsAsked || 0) + 1;
  const responseCount = Array.isArray(currentState?.validations)
    ? currentState.validations.length
    : (session.responsesProvided || 0) + 1;
  const updatedState = {
    ...currentState,
    currentPhase: phase,
    currentQuestion: Array.isArray(currentState?.validations)
      ? validationCount
      : questionNumber + 1,
    questionsAsked: validationCount,
    responsesProvided: responseCount,
    overallConfidence: currentState.overallConfidence ?? confidenceScore ?? session.overallConfidence ?? 0,
  };

  // Sanitize state for JSON serialization - deep conversion
  const sanitizeForJSON = (obj: any): any => {
    if (obj === null || obj === undefined) return obj;
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Map) return Object.fromEntries(obj);
    if (obj instanceof Set) return Array.from(obj);
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitizeForJSON);
    
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'function') continue; // Skip functions
      sanitized[key] = sanitizeForJSON(value);
    }
    return sanitized;
  };

  const sanitizedState = sanitizeForJSON(updatedState);

  try {
    const sessionDataStr = JSON.stringify(sanitizedState);
    await db.update(interviewSessions)
      .set({
        currentPhase: phase,
        currentQuestion: questionNumber + 1,
        questionsAsked: (session.questionsAsked || 0) + 1,
        responsesProvided: (session.responsesProvided || 0) + 1,
        overallConfidence: confidenceScore || session.overallConfidence,
        sessionData: sessionDataStr,
        updatedAt: new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));
  } catch (error) {
    console.error('[Interview] Error updating session state:', error);
    console.error('[Interview] Sanitized state:', JSON.stringify(sanitizedState, null, 2).substring(0, 500));
    throw error;
  }
}

/**
 * Complete interview and save results
 */
export async function completeInterview(
  sessionId: string,
  finalGoal: string,
  finalDeliverable: string,
  finalAPTLSSChecklist: any[],
  finalConfidence: number,
  clarityScore: number,
  completenessScore: number,
  executionPlan?: any,
  estimatedDuration?: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  const session = await getInterviewSession(sessionId);
  if (!session) throw new Error('Session not found');

  // Get all history for this session to calculate metrics
  const history = await db.select()
    .from(interviewHistory)
    .where(eq(interviewHistory.sessionId, sessionId));

  const resultId = uuidv4();
  const result: InsertInterviewResult = {
    id: resultId,
    sessionId,
    cardId: session.cardId,
    userId: session.userId,
    userOpenId: session.userOpenId,
    finalGoal,
    finalDeliverable,
    finalAPTLSSChecklist: JSON.stringify(finalAPTLSSChecklist),
    finalConfidence,
    clarityScore,
    completenessScore,
    executionPlan: executionPlan ? JSON.stringify(executionPlan) : null,
    estimatedDuration,
    totalQuestionsAsked: history.length,
    totalResponsesProvided: history.filter((h: any) => h.response).length,
    escalationsRequired: history.filter((h: any) => h.requiresEscalation).length,
    completedAt: new Date(),
  };

  await db.insert(interviewResults).values(result);

  // Update session status
  await db.update(interviewSessions)
    .set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(interviewSessions.id, sessionId));
}

/**
 * Get interview history for a session
 */
export async function getInterviewHistory(sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  return db.select()
    .from(interviewHistory)
    .where(eq(interviewHistory.sessionId, sessionId));
}

/**
 * Get interview results
 */
export async function getInterviewResults(sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  const [result] = await db.select()
    .from(interviewResults)
    .where(eq(interviewResults.sessionId, sessionId))
    .limit(1);

  return result;
}

/**
 * Get all interview sessions for a user
 */
export async function getUserInterviewSessions(userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  return db.select()
    .from(interviewSessions)
    .where(eq(interviewSessions.userOpenId, userOpenId));
}

/**
 * Get all interview sessions for a card
 */
export async function getCardInterviewSessions(cardId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  return db.select()
    .from(interviewSessions)
    .where(eq(interviewSessions.cardId, cardId));
}

/**
 * Abandon interview session
 */
export async function abandonInterviewSession(sessionId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  await db.update(interviewSessions)
    .set({
      status: 'abandoned',
      updatedAt: new Date(),
    })
    .where(eq(interviewSessions.id, sessionId));
}

/**
 * Get interview statistics for a user
 */
export async function getUserInterviewStats(userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database connection failed');

  const sessions = await db.select()
    .from(interviewSessions)
    .where(eq(interviewSessions.userOpenId, userOpenId));

  const completedSessions = sessions.filter((s: any) => s.status === 'completed');
  const totalConfidence = completedSessions.reduce((sum: number, s: any) => sum + (s.overallConfidence || 0), 0);
  const avgConfidence = completedSessions.length > 0 ? totalConfidence / completedSessions.length : 0;

  return {
    totalSessions: sessions.length,
    completedSessions: completedSessions.length,
    activeSessions: sessions.filter((s: any) => s.status === 'active').length,
    abandonedSessions: sessions.filter((s: any) => s.status === 'abandoned').length,
    averageConfidence: Math.round(avgConfidence),
    totalQuestionsAsked: sessions.reduce((sum: number, s: any) => sum + (s.questionsAsked || 0), 0),
  };
}
