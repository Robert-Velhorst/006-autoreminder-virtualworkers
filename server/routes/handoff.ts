import { Router } from 'express';
import { saveHandoffNote, getHandoffContext, generateShiftSummary } from '../services/handoff-service';
import { requireAuthenticated, requestUser, resolveWorkerProfileId } from '../middleware/auth';
import { assignmentFailure } from '../taskAssignmentMutation';
import { timerFailure } from '../canonicalTimer';

const router = Router();
router.use(requireAuthenticated);

// POST /api/handoff/notes
router.post('/notes', async (req, res) => {
  const { taskId, notes } = req.body;
  const workerId = await resolveWorkerProfileId(req, req.body.workerId);
  if (!taskId || !workerId || typeof notes !== 'string' || !notes.trim()) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
  const success = await saveHandoffNote(taskId, workerId, notes, requestUser(req)!);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save handoff note' });
  }
  } catch (error) {
    const failure = assignmentFailure(error) ?? timerFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to save handoff note' });
  }
});

// GET /api/handoff/:taskId
router.get('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const user = requestUser(req)!;
  const workerId = user.role === 'admin' ? undefined : await resolveWorkerProfileId(req);
  if (user.role !== 'admin' && !workerId) return res.status(403).json({ error: 'Worker profile not found' });
  try {
  const context = await getHandoffContext(taskId, user, workerId ?? undefined);
  if (context) {
    res.json(context);
  } else {
    res.status(404).json({ error: 'Context not found' });
  }
  } catch (error) {
    const failure = assignmentFailure(error) ?? timerFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to get handoff context' });
  }
});

// POST /api/handoff/shift-summary
router.post('/shift-summary', async (req, res) => {
  const workerId = await resolveWorkerProfileId(req, req.body.workerId);
  if (!workerId) {
    return res.status(400).json({ error: 'Missing workerId' });
  }

  try {
  const success = await generateShiftSummary(workerId, requestUser(req)!);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to generate summary' });
  }
  } catch (error) {
    const failure = assignmentFailure(error) ?? timerFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to generate summary' });
  }
});

export default router;
