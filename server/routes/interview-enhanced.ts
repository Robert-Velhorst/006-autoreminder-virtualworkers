import { encodeTrelloPathSegment } from '../utils/trello-path';
/**
 * Enhanced Interview Route
 *
 * Handles all ATIS interview phases (1-10) with database persistence.
 * Replaces the in-memory interview system with persistent storage.
 */

import { Router, Request, Response } from 'express';
import { TRPCError } from '@trpc/server';
import {
  getInterviewSession,
  getInterviewHistory,
  getInterviewResults,
  getUserInterviewSessions,
  getCardInterviewSessions,
  abandonInterviewSession,
  getUserInterviewStats,
} from '../services/interview-persistence';
import { requireAdmin } from '../middleware/auth';
import { interviewRouter } from './interview';

const router = Router();
router.use(requireAdmin);

function respondInterviewError(res: Response, error: unknown, fallback: string) {
  if (res.destroyed || res.headersSent) return;
  if (error instanceof TRPCError) {
    const known = {
      BAD_REQUEST: [400, 'Invalid interview request'],
      UNAUTHORIZED: [401, 'Unauthorized'],
      FORBIDDEN: [403, 'Interview access denied or authority changed'],
      NOT_FOUND: [404, 'Interview session or card not found'],
      CONFLICT: [409, 'Interview changed; reload before responding'],
      SERVICE_UNAVAILABLE: [503, 'Interview storage unavailable'],
      BAD_GATEWAY: [502, 'Could not verify interview card access'],
    } as const;
    const entry = known[error.code as keyof typeof known];
    if (entry) return res.status(entry[0]).json({ error: entry[1] });
  }
  return res.status(500).json({ error: fallback });
}

/**
 * POST /api/interview/start
 * Start a new interview session for a card
 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { cardId } = req.body;
    if (!encodeTrelloPathSegment(cardId)) {
      return res.status(400).json({ error: 'A valid Trello card ID is required' });
    }

    const result = await interviewRouter.createCaller({ req, res, user }).start({ cardId });
    return res.json({ ...result, phase: 1 });
  } catch (error) {
    console.error('[Interview] Error starting interview:', error);
    return respondInterviewError(
      res,
      error,
      'Failed to start interview. Retry shortly or check the service configuration.',
    );
  }
});

/**
 * POST /api/interview/:sessionId/respond
 * Process user response and get next question
 */
router.post('/:sessionId/respond', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;
    const { response } = req.body;

    if (typeof response !== 'string' || !response.trim()) {
      return res.status(400).json({ error: 'Missing response' });
    }

    // Get session
    const session = await getInterviewSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }

    if (
      session.userOpenId !== user.openId ||
      session.userId !== user.id ||
      (req.body.cardId !== undefined && req.body.cardId !== session.cardId)
    ) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await interviewRouter.createCaller({ req, res, user }).respond({
      cardId: session.cardId,
      sessionId,
      response,
    });

    // Check if interview is complete
    if (result.isComplete && result.finalGoal) {
      return res.json({
        isComplete: true,
        finalGoal: result.finalGoal,
        message: 'Interview completed successfully',
      });
    }

    return res.json({
      isComplete: false,
      nextMessage: result.nextMessage,
      message: result.nextMessage,
    });
  } catch (error) {
    console.error('[Interview] Error processing response:', error);
    if (error instanceof Error) {
      console.error('[Interview] Error stack:', error.stack);
    }
    return respondInterviewError(
      res,
      error,
      'Failed to process response. Retry shortly or check the service configuration.',
    );
  }
});

/**
 * GET /api/interview/card/:cardId/latest
 * Get the latest interview session for the current user on a card.
 * Prefer active sessions so the UI can resume where the user left off.
 */
router.get('/card/:cardId/latest', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { cardId } = req.params;
    const sessions = await getCardInterviewSessions(cardId);
    const userSessions = sessions
      .filter((session: any) => session.userOpenId === user.openId)
      .sort(
        (a: any, b: any) =>
          new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime(),
      );

    const preferredSession =
      userSessions.find((session: any) => session.status === 'active') ||
      userSessions.find((session: any) => session.status === 'completed') ||
      null;

    if (!preferredSession) {
      return res.json({ session: null });
    }

    let sessionData: any = null;
    try {
      if (preferredSession.sessionData) {
        const parsed =
          typeof preferredSession.sessionData === 'string'
            ? JSON.parse(preferredSession.sessionData)
            : preferredSession.sessionData;
        sessionData = parsed;
      }
    } catch (parseError) {
      console.error('[Interview] Error parsing sessionData:', parseError);
      sessionData = null;
    }

    let executionPlan = null;
    if (preferredSession.status === 'completed') {
      try {
        const results = await getInterviewResults(preferredSession.id);
        if (results?.executionPlan) {
          executionPlan =
            typeof results.executionPlan === 'string'
              ? JSON.parse(results.executionPlan)
              : results.executionPlan;
        }
      } catch (parseError) {
        console.error('[Interview] Error parsing executionPlan:', parseError);
      }
    }

    return res.json({
      session: {
        id: preferredSession.id,
        status: preferredSession.status,
        currentPhase: preferredSession.currentPhase,
        currentQuestion: preferredSession.currentQuestion,
        overallConfidence: preferredSession.overallConfidence,
        preAnalysisSummary: preferredSession.preAnalysisSummary,
        messages: sessionData?.messages || [],
        finalGoal: executionPlan,
        completedAt: preferredSession.completedAt,
        updatedAt: preferredSession.updatedAt,
      },
    });
  } catch (error) {
    console.error('[Interview] Error fetching latest card session:', error);
    return res
      .status(500)
      .json({
        error: 'Failed to fetch latest interview session. Retry shortly or check the service configuration.',
      });
  }
});

/**
 * GET /api/interview/:sessionId
 * Get interview session details
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;
    const session = await getInterviewSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userOpenId !== user.openId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    return res.json(session);
  } catch (error) {
    console.error('[Interview] Error fetching session:', error);
    return res.status(500).json({ error: 'Failed to fetch session' });
  }
});

/**
 * GET /api/interview/:sessionId/history
 * Get interview history (all questions and responses)
 */
router.get('/:sessionId/history', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;
    const session = await getInterviewSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userOpenId !== user.openId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const history = await getInterviewHistory(sessionId);
    return res.json(history);
  } catch (error) {
    console.error('[Interview] Error fetching history:', error);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /api/interview/:sessionId/results
 * Get interview results
 */
router.get('/:sessionId/results', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;
    const session = await getInterviewSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userOpenId !== user.openId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const results = await getInterviewResults(sessionId);
    return res.json(results);
  } catch (error) {
    console.error('[Interview] Error fetching results:', error);
    return res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/**
 * GET /api/interview/user/sessions
 * Get all interview sessions for current user
 */
router.get('/user/sessions', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sessions = await getUserInterviewSessions(user.openId);
    return res.json(sessions);
  } catch (error) {
    console.error('[Interview] Error fetching user sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * GET /api/interview/user/stats
 * Get interview statistics for current user
 */
router.get('/user/stats', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const stats = await getUserInterviewStats(user.openId);
    return res.json(stats);
  } catch (error) {
    console.error('[Interview] Error fetching stats:', error);
    return res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/interview/card/:cardId/sessions
 * Get all interview sessions for a card
 */
router.get('/card/:cardId/sessions', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.params;
    const sessions = await getCardInterviewSessions(cardId);
    return res.json(sessions);
  } catch (error) {
    console.error('[Interview] Error fetching card sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * POST /api/interview/:sessionId/abandon
 * Abandon an interview session
 */
router.post('/:sessionId/abandon', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;
    const session = await getInterviewSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userOpenId !== user.openId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await abandonInterviewSession(sessionId);
    return res.json({ message: 'Interview session abandoned' });
  } catch (error) {
    console.error('[Interview] Error abandoning session:', error);
    return res.status(500).json({ error: 'Failed to abandon session' });
  }
});

export default router;
