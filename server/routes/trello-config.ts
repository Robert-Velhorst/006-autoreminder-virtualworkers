import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { appSettings, vaProfiles } from '../../drizzle/schema';
import { getDb } from '../db';
import { requestUser, requireAdmin, requireAuthenticated } from '../middleware/auth';
import { fetchWithRetry } from '../utils/retry';
import { selectWorkerProfile } from '../workerOperatorContext';

const router = Router();
router.use(requireAuthenticated);
router.use((req, res, next) => {
  const user = requestUser(req)!;
  if (user.role !== 'admin' && user.role !== 'worker') {
    return res.status(403).json({ error: 'Trello operations require an admin or worker account' });
  }
  next();
});

function completionLabelsKey(userId: number) {
  return `trelloCompletionLabels:${userId}`;
}

async function getCompletionLabels(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [row] = await db.select({ value: appSettings.value }).from(appSettings)
    .where(eq(appSettings.key, completionLabelsKey(userId))).limit(1);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
}

async function saveCompletionLabels(userId: number, labels: string[]) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const key = completionLabelsKey(userId);
  await db.insert(appSettings).values({ vaId: userId, key, value: JSON.stringify(labels) })
    .onDuplicateKeyUpdate({ set: { vaId: userId, value: JSON.stringify(labels) } });
}

type ChecklistItemReference = { checklistId: string; checkItemId: string };

function cardContainsChecklistItem(
  card: { checklists?: unknown },
  checklistId: string,
  checkItemId: string,
) {
  if (!Array.isArray(card.checklists)) return false;

  const checklist = card.checklists.find((candidate: unknown) =>
    typeof candidate === 'object' && candidate !== null
    && 'id' in candidate && candidate.id === checklistId,
  );
  if (!checklist || typeof checklist !== 'object' || !('checkItems' in checklist)
    || !Array.isArray(checklist.checkItems)) return false;

  return checklist.checkItems.some((item: unknown) =>
    typeof item === 'object' && item !== null && 'id' in item && item.id === checkItemId,
  );
}

async function requireAssignedCard(
  req: Request,
  res: Response,
  cardId: string,
  checklistItem?: ChecklistItemReference,
) {
  const user = requestUser(req)!;
  if (user.role === 'admin' && !checklistItem) return true;

  let memberId: string | null = null;
  if (user.role === 'worker') {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return false;
    }
    const profiles = await db.select({ trelloMemberId: vaProfiles.trelloMemberId, status: vaProfiles.status })
      .from(vaProfiles).where(eq(vaProfiles.userId, user.id)).orderBy(vaProfiles.id);
    const profile = selectWorkerProfile(profiles);
    if (profiles.length > 0 && !profile) {
      res.status(409).json({ error: 'Your worker profile is ambiguous. Ask an administrator to resolve it before updating Trello.' });
      return false;
    }
    if (profile?.status !== 'active') {
      res.status(403).json({ error: 'An active worker profile is required to update Trello' });
      return false;
    }
    memberId = profile.trelloMemberId?.trim() || null;
    if (!memberId) {
      res.status(403).json({ error: 'Your worker profile is not linked to a Trello member' });
      return false;
    }
  }
  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_TOKEN;
  if (!apiKey || !apiToken) {
    res.status(503).json({ error: 'Trello credentials not configured' });
    return false;
  }
  const query = new URLSearchParams({ key: apiKey, token: apiToken, fields: 'idMembers' });
  if (checklistItem) query.set('checklists', 'all');
  const response = await fetchWithRetry(
    `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}?${query.toString()}`,
    undefined,
    { maxRetries: 0 },
  );
  if (!response.ok) {
    res.status(response.status === 404 ? 404 : 502).json({ error: response.status === 404 ? 'Trello card not found' : 'Could not verify Trello card access' });
    return false;
  }
  const card = await response.json() as { idMembers?: unknown; checklists?: unknown };
  if (memberId && (!Array.isArray(card.idMembers) || !card.idMembers.includes(memberId))) {
    res.status(403).json({ error: 'This Trello card is not assigned to your linked member account' });
    return false;
  }
  if (checklistItem && !cardContainsChecklistItem(card, checklistItem.checklistId, checklistItem.checkItemId)) {
    res.status(403).json({ error: 'The checklist item does not belong to the selected Trello card' });
    return false;
  }
  return true;
}

router.param('cardId', async (req, res, next, cardId) => {
  try {
    if (await requireAssignedCard(req, res, cardId)) next();
  } catch (error) {
    console.error('[Trello] Card authorization failed:', error);
    if (!res.headersSent) res.status(502).json({ error: 'Could not verify Trello card access' });
  }
});

/**
 * GET /api/trello/labels
 * Fetch all available labels from the connected Trello board
 */
router.get('/labels', requireAdmin, async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Get the first board (assuming single board setup)
    const boardsUrl = `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${apiToken}`;
    const boardsResponse = await fetchWithRetry(boardsUrl, undefined, { maxRetries: 0 });
    const boards = await boardsResponse.json();

    if (!boards || boards.length === 0) {
      return res.json({ labels: [] });
    }

    // Get labels from the first board
    const boardId = boards[0].id;
    const labelsUrl = `https://api.trello.com/1/boards/${boardId}/labels?key=${apiKey}&token=${apiToken}`;
    const labelsResponse = await fetchWithRetry(labelsUrl, undefined, { maxRetries: 0 });
    const labels = await labelsResponse.json();

    // Transform labels to include only necessary fields
    const transformedLabels = labels.map((label: any) => ({
      id: label.id,
      name: label.name || 'Untitled',
      color: label.color || '#cccccc',
    }));

    res.json({ labels: transformedLabels });
  } catch (error) {
    console.error('[Trello] Error fetching labels:', error);
    res.status(500).json({ error: 'Failed to fetch Trello labels' });
  }
});

/**
 * GET /api/trello/completion-labels
 * Get the current completion labels configuration for the user
 */
router.get('/completion-labels', async (req: Request, res: Response) => {
  try {
    const user = requestUser(req)!;
    const labels = await getCompletionLabels(user.id);

    res.json({
      labels,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Trello] Error fetching completion labels config:', error);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

/**
 * POST /api/trello/completion-labels
 * Save the completion labels configuration for the user
 */
router.post('/completion-labels', async (req: Request, res: Response) => {
  try {
    const user = requestUser(req)!;

    const { labels } = req.body;

    if (!Array.isArray(labels)) {
      return res.status(400).json({ error: 'Labels must be an array' });
    }

    const normalizedLabels = (labels as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 50);
    await saveCompletionLabels(user.id, normalizedLabels);

    res.json({
      success: true,
      labels: normalizedLabels,
      message: 'Completion labels configuration saved successfully',
    });
  } catch (error) {
    console.error('[Trello] Error saving completion labels config:', error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

/**
 * PUT /api/trello/tasks/:taskId/complete
 * Update task completion status via Trello checklist item
 */
router.put('/tasks/:taskId/complete', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { isCompleted, cardId, checklistId, checkItemId } = req.body;

    if (![cardId, checklistId, checkItemId].every(value => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ error: 'Missing required fields: cardId, checklistId, checkItemId' });
    }
    if (typeof isCompleted !== 'boolean') {
      return res.status(400).json({ error: 'isCompleted must be a boolean' });
    }
    if (!await requireAssignedCard(req, res, cardId, { checklistId, checkItemId })) return;

    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Update the checklist item state
    const updateUrl = `https://api.trello.com/1/checklists/${encodeURIComponent(checklistId)}/checkItems/${encodeURIComponent(checkItemId)}?key=${apiKey}&token=${apiToken}`;
    
    const updateResponse = await fetchWithRetry(updateUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: isCompleted ? 'complete' : 'incomplete',
      }),
    }, { maxRetries: 0, timeoutMs: 15_000 });

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('[Trello] Failed to update checklist item:', errorText);
      
      // Provide better error messages
      let userFriendlyError = 'Failed to update task in Trello';
      if (updateResponse.status === 401 || errorText.includes('unauthorized')) {
        userFriendlyError = 'Permission denied: You do not have access to this card or checklist.';
      } else if (updateResponse.status === 404 || errorText.includes('invalid')) {
        userFriendlyError = 'Task not found: The checklist item may have been deleted.';
      }
      
      return res.status(updateResponse.status).json({ 
        error: userFriendlyError,
      });
    }

    const result = await updateResponse.json();

    res.json({
      success: true,
      taskId,
      isCompleted,
      checkItemId,
      message: `Task marked as ${isCompleted ? 'complete' : 'incomplete'} in Trello`,
    });
  } catch (error) {
    console.error('[Trello] Error updating task completion:', error);
    res.status(500).json({ error: 'Failed to update task completion' });
  }
});

/**
 * PUT /api/trello/cards/:cardId/status
 * Update card status directly (fallback when checklist data is unavailable)
 */
router.put('/cards/:cardId/status', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.params;
    const { isCompleted } = req.body;

    if (!cardId) {
      return res.status(400).json({ error: 'Missing required field: cardId' });
    }
    if (typeof isCompleted !== 'boolean') {
      return res.status(400).json({ error: 'isCompleted must be a boolean' });
    }

    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Fetch the card to get its current labels
    const cardUrl = `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}?key=${apiKey}&token=${apiToken}&fields=labels,idLabels`;
    const cardResponse = await fetchWithRetry(cardUrl, undefined, { maxRetries: 0, timeoutMs: 15_000 });

    if (!cardResponse.ok) {
      const errorText = await cardResponse.text();
      console.error('[Trello] Failed to fetch card:', errorText);
      
      // Provide better error messages based on the HTTP status
      let userFriendlyError = 'Failed to fetch card';
      if (cardResponse.status === 401 || errorText.includes('unauthorized')) {
        userFriendlyError = 'Permission denied: You do not have access to this card. Check your Trello token permissions or board access.';
      } else if (cardResponse.status === 404 || errorText.includes('invalid id')) {
        userFriendlyError = 'Card not found: This card may have been deleted or archived.';
      }
      
      return res.status(cardResponse.status === 404 ? 404 : 502).json({ error: userFriendlyError });
    }

    const card = await cardResponse.json();
    const currentLabels = card.idLabels || [];
    
    // Get the completion label ID from user config
    const user = requestUser(req)!;
    const userLabels = await getCompletionLabels(user.id);
    const completionLabelId = userLabels[0] || null; // Use first configured label or none
    // Without an explicit completion label there is no safe Trello mutation to
    // perform. Report the missing setup rather than acknowledging fake success.
    if (!completionLabelId) {
      return res.status(409).json({
        success: false,
        setupRequired: 'completion_label',
        error: 'Configure a Trello completion label before changing card status',
      });
    }
    
    // Update labels based on completion status
    let newLabels = currentLabels;
    
    if (isCompleted && !currentLabels.includes(completionLabelId)) {
      newLabels = [...currentLabels, completionLabelId];
    } else if (!isCompleted && currentLabels.includes(completionLabelId)) {
      newLabels = currentLabels.filter((id: string) => id !== completionLabelId);
    }

    // Update the card with new labels
    const updateUrl = `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}?key=${apiKey}&token=${apiToken}`;
    const updateResponse = await fetchWithRetry(updateUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idLabels: newLabels,
      }),
    }, { maxRetries: 0, timeoutMs: 15_000 });

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('[Trello] Failed to update card status:', errorText);
      return res.status(updateResponse.status === 404 ? 404 : 502).json({
        error: updateResponse.status === 404 ? 'Trello card not found' : 'Trello did not accept the card status update',
      });
    }

    res.json({
      success: true,
      cardId,
      isCompleted,
      message: `Card status updated to ${isCompleted ? 'complete' : 'incomplete'}`,
    });
  } catch (error) {
    console.error('[Trello] Error updating card status:', error);
    res.status(502).json({ error: 'Could not update the Trello card status' });
  }
});

/**
 * Update or clear a card due date. Worker access is checked by router.param;
 * admins may update any card visible to the configured Trello account.
 */
router.put('/cards/:cardId/due', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.params;
    const rawDueDate = req.body?.dueDate;
    if (rawDueDate !== null && rawDueDate !== undefined && typeof rawDueDate !== 'string') {
      return res.status(400).json({ error: 'dueDate must be an ISO date string or null' });
    }
    const dueDate = typeof rawDueDate === 'string' && rawDueDate.trim() ? rawDueDate.trim() : null;
    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
      return res.status(400).json({ error: 'dueDate must be a valid ISO date string' });
    }
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;
    if (!apiKey || !apiToken) return res.status(503).json({ error: 'Trello credentials not configured' });

    const response = await fetchWithRetry(
      `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}?key=${apiKey}&token=${apiToken}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due: dueDate }),
      },
      { maxRetries: 0 },
    );
    if (!response.ok) {
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the due date update',
      });
    }
    const card = await response.json() as { id?: string; name?: string; due?: string | null };
    return res.json({ success: true, cardId, dueDate, trelloCard: card });
  } catch (error) {
    console.error('[Trello] Due date update failed:', error);
    return res.status(502).json({ error: 'Could not update the Trello due date' });
  }
});

/**
 * GET /api/trello/boards/list
 * Fetch all available boards for the connected Trello user
 */
router.get('/boards/list', requireAdmin, async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    const boardsUrl = `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${apiToken}`;
    const boardsResponse = await fetchWithRetry(boardsUrl, undefined, { maxRetries: 0 });
    const boards = await boardsResponse.json();

    if (!boards || boards.length === 0) {
      return res.json({ boards: [] });
    }

    const transformedBoards = boards.map((board: any) => ({
      id: board.id,
      name: board.name,
      url: board.url,
      closed: board.closed,
    }));

    res.json({ boards: transformedBoards });
  } catch (error) {
    console.error('[Trello] Error fetching boards:', error);
    res.status(500).json({ error: 'Failed to fetch Trello boards' });
  }
});

/**
 * PUT /api/trello/cards/:cardId/update
 * Update card details (name, desc, labels) in Trello
 */
router.put('/cards/:cardId/update', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.params;
    const { name, desc, idLabels } = req.body;
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'name must be a non-empty string when provided' });
    }
    if (desc !== undefined && typeof desc !== 'string') {
      return res.status(400).json({ error: 'desc must be a string when provided' });
    }
    if (idLabels !== undefined && (!Array.isArray(idLabels) || !idLabels.every((label) => typeof label === 'string'))) {
      return res.status(400).json({ error: 'idLabels must be an array of strings when provided' });
    }
    if (name === undefined && desc === undefined && idLabels === undefined) {
      return res.status(400).json({ error: 'Provide at least one card field to update' });
    }
    
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    const updateUrl = new URL(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`);
    updateUrl.searchParams.append('key', apiKey);
    updateUrl.searchParams.append('token', apiToken);

    if (name) updateUrl.searchParams.append('name', name);
    if (desc !== undefined) updateUrl.searchParams.append('desc', desc);
    if (idLabels) updateUrl.searchParams.append('idLabels', idLabels.join(','));

    const response = await fetchWithRetry(updateUrl.toString(), {
      method: 'PUT',
    }, { maxRetries: 1, timeoutMs: 15_000 });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Trello] Failed to update card:', errorText);
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the card update',
      });
    }

    const updatedCard = await response.json();
    res.json({ success: true, card: updatedCard });
  } catch (error) {
    console.error('[Trello] Error updating card:', error);
    res.status(500).json({ error: 'Failed to update Trello card' });
  }
});

/**
 * PUT /api/trello/cards/:cardId/members
 * Update card members in Trello
 */
router.put('/cards/:cardId/members', async (req: Request, res: Response) => {
  try {
    if (requestUser(req)!.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change Trello card membership' });
    }
    const { cardId } = req.params;
    const { idMembers } = req.body;
    if (!Array.isArray(idMembers) || !idMembers.every((memberId) => typeof memberId === 'string')) {
      return res.status(400).json({ error: 'idMembers must be an array of strings' });
    }
    
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    const updateUrl = new URL(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`);
    updateUrl.searchParams.set('key', apiKey);
    updateUrl.searchParams.set('token', apiToken);
    updateUrl.searchParams.set('idMembers', idMembers.join(','));

    const response = await fetchWithRetry(updateUrl.toString(), {
      method: 'PUT',
    }, { maxRetries: 1, timeoutMs: 15_000 });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Trello] Failed to update card members:', errorText);
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the card member update',
      });
    }

    const updatedCard = await response.json();
    res.json({ success: true, card: updatedCard });
  } catch (error) {
    console.error('[Trello] Error updating card members:', error);
    res.status(500).json({ error: 'Failed to update Trello card members' });
  }
});

export default router;
