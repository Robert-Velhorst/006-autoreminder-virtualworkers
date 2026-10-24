/**
 * ATIS Phases 3-10 API Routes
 * Endpoints for advanced task analysis
 */

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  analyzePhase3Decomposition,
  analyzePhase4RiskAssessment,
  analyzePhase5ResourceEstimation,
  analyzePhase6TimelineOptimization,
  analyzePhase7QAStrategy,
  analyzePhase8Documentation,
  analyzePhase9Dependencies,
  analyzePhase10Finalization,
  runAllPhases,
} from '../services/atis-phases-service';
import * as atisDb from '../db/atis-phases';
import { requireAdmin, requestUser } from '../middleware/auth';

const router = express.Router();
// This portal starts multi-phase LLM analyses and exposes their full output.
// Its only client route is administrator-protected, so enforce the same rule
// at the API boundary instead of relying on the frontend route guard.
router.use(requireAdmin);

function sendPhaseFailure(res: Response) {
  return res.status(500).json({
    success: false,
    error: 'Could not complete the ATIS analysis request. Retry shortly.',
  });
}

function ownsSession(user: NonNullable<ReturnType<typeof requestUser>>, session: { userId: string }) {
  return user.role === 'admin' || session.userId === user.openId || session.userId === String(user.id);
}

async function canAccessTask(req: Request, taskId: string) {
  const user = requestUser(req)!;
  if (user.role === 'admin') return true;
  const sessions = await atisDb.getAnalysisSessionByTask(taskId);
  return sessions.some(session => ownsSession(user, session));
}

/**
 * POST /api/atis/phases/start
 * Start a new ATIS analysis session
 */
router.post('/start', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: taskId, taskDescription, userId',
      });
    }

    // Run all phases
    const result = await runAllPhases(taskId, userId, taskDescription);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[ATIS Phases] Error starting analysis:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase3
 * Run Phase 3: Task Decomposition
 */
router.post('/phase3', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase3Decomposition(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 3] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase4
 * Run Phase 4: Risk Assessment
 */
router.post('/phase4', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase4RiskAssessment(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 4] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase5
 * Run Phase 5: Resource Estimation
 */
router.post('/phase5', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase5ResourceEstimation(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 5] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase6
 * Run Phase 6: Timeline Optimization
 */
router.post('/phase6', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase6TimelineOptimization(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 6] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase7
 * Run Phase 7: QA Strategy
 */
router.post('/phase7', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase7QAStrategy(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 7] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase8
 * Run Phase 8: Documentation Requirements
 */
router.post('/phase8', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase8Documentation(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 8] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase9
 * Run Phase 9: External Dependencies
 */
router.post('/phase9', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase9Dependencies(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 9] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * POST /api/atis/phases/phase10
 * Run Phase 10: Finalization & Execution Plan
 */
router.post('/phase10', async (req, res) => {
  try {
    const { taskId, taskDescription } = req.body;
    const userId = (req as any).user?.openId;

    if (!taskId || !taskDescription || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const result = await analyzePhase10Finalization(taskId, userId, taskDescription);
    res.json(result);
  } catch (error) {
    console.error('[ATIS Phase 10] Error:', error);
    sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/session/:sessionId
 * Get analysis session details
 */
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await atisDb.getAnalysisSession(sessionId);

    if (!session || session.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    if (!ownsSession(requestUser(req)!, session[0])) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }

    res.json({
      success: true,
      data: session[0],
    });
  } catch (error) {
    console.error('[ATIS] Error fetching session:', error);
    sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/task/:taskId
 * Get all analysis data for a task
 */
router.get('/task/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!(await canAccessTask(req, taskId))) {
      return res.status(403).json({ success: false, error: 'Task access denied' });
    }
    const data = await atisDb.getAllAnalysisData(taskId);

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('[ATIS] Error fetching task analysis:', error);
    sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/analyze/:taskId
 * Compatibility read model for the retained phase-analysis dashboard. This
 * reads the latest persisted run only; it never starts a new analysis.
 */
router.get('/analyze/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!(await canAccessTask(req, taskId))) {
      return res.status(403).json({ success: false, error: 'Task access denied' });
    }

    const [session] = await atisDb.getAnalysisSessionByTask(taskId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Analysis not found' });
    }

    let sessionData: Record<string, unknown> = {};
    try {
      const parsed = session.sessionData ? JSON.parse(session.sessionData) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sessionData = parsed as Record<string, unknown>;
      }
    } catch {
      // Older rows can contain malformed data. Preserve the session metadata
      // rather than failing the complete operator page.
    }

    return res.json({
      ...sessionData,
      sessionId: session.id,
      taskId,
      taskTitle: typeof sessionData.taskTitle === 'string' ? sessionData.taskTitle : taskId,
      status: session.status,
      currentPhase: session.currentPhase,
      phasesCompleted: session.phasesCompleted,
      overallConfidence: Number(sessionData.overallConfidence ?? 0),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    console.error('[ATIS] Error loading analysis:', error);
    return sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/subtasks/:taskId
 * Get subtasks for a task
 */
router.get('/subtasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!(await canAccessTask(req, taskId))) {
      return res.status(403).json({ success: false, error: 'Task access denied' });
    }
    const subtasks = await atisDb.getSubtasks(taskId);

    res.json({
      success: true,
      data: subtasks,
    });
  } catch (error) {
    console.error('[ATIS] Error fetching subtasks:', error);
    sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/risks/:taskId
 * Get risks for a task
 */
router.get('/risks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!(await canAccessTask(req, taskId))) {
      return res.status(403).json({ success: false, error: 'Task access denied' });
    }
    const risks = await atisDb.getRisks(taskId);

    res.json({
      success: true,
      data: risks,
    });
  } catch (error) {
    console.error('[ATIS] Error fetching risks:', error);
    sendPhaseFailure(res);
  }
});

/**
 * GET /api/atis/phases/resources/:taskId
 * Get resource requirements for a task
 */
router.get('/resources/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!(await canAccessTask(req, taskId))) {
      return res.status(403).json({ success: false, error: 'Task access denied' });
    }
    const resources = await atisDb.getResourceRequirements(taskId);

    res.json({
      success: true,
      data: resources,
    });
  } catch (error) {
    console.error('[ATIS] Error fetching resources:', error);
    sendPhaseFailure(res);
  }
});

export default router;
