import { Router } from 'express';
import { saveHandoffNote, getHandoffContext, generateShiftSummary } from '../services/handoff-service';
import { requireAuthenticated, requestUser, resolveWorkerProfileId } from '../middleware/auth';
import { assignmentFailure } from '../taskAssignmentMutation';

const router = Router();
router.use(requireAuthenticated);

// POST /api/handoff/notes
router.post('/notes', async (req, res) => {
  const { taskId, notes } = req.body;
  if (typeof taskId !== 'string' || !taskId || typeof notes !== 'string' || !notes.trim()) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    const workerId = await resolveWorkerProfileId(req, req.body.workerId);
    if (!workerId) return res.status(403).json({ error: 'Worker profile not found' });
    await saveHandoffNote(taskId, workerId, notes, requestUser(req)!);
    res.json({ success: true });
  } catch (error) {
    const failure = assignmentFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to save handoff note' });
  }
});

// GET /api/handoff/:taskId
router.get('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const user = requestUser(req)!;
  try {
    const workerId = user.role === 'admin' ? undefined : await resolveWorkerProfileId(req);
    if (user.role !== 'admin' && !workerId) return res.status(403).json({ error: 'Worker profile not found' });
    const context = await getHandoffContext(taskId, user, workerId ?? undefined);
    res.json(context);
  } catch (error) {
    const failure = assignmentFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to get handoff context' });
  }
});

// POST /api/handoff/shift-summary
router.post('/shift-summary', async (req, res) => {
  try {
    const workerId = await resolveWorkerProfileId(req, req.body.workerId);
    if (!workerId) return res.status(403).json({ error: 'Worker profile not found' });
    await generateShiftSummary(workerId, requestUser(req)!);
    res.json({ success: true });
  } catch (error) {
    const failure = assignmentFailure(error);
    res.status(failure?.status ?? 500).json({ error: failure?.error ?? 'Failed to generate summary' });
  }
});

export default router;
