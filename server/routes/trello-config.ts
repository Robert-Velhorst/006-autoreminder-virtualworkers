import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { appSettings, vaProfiles } from '../../drizzle/schema';
import { getDb } from '../db';
import { requestUser, requireAdmin, requireAuthenticated } from '../middleware/auth';
import { fetchWithRetry } from '../utils/retry';
import { selectWorkerProfile } from '../workerOperatorContext';
import { isManagerPilotWorker } from '../aptlssManagerPilot';

const router = Router();
router.use(requireAuthenticated);
router.use((req, res, next) => {
  const user = requestUser(req)!;
  if (user.role !== 'admin' && user.role !== 'worker') {
    return res.status(403).json({ error: 'Trello operations require an admin or worker account' });
  }
  next();
});

type TrelloCredentials = { apiKey: string; token: string };

function getTrelloCredentials(): TrelloCredentials | null {
  const apiKey = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  return apiKey && token ? { apiKey, token } : null;
}

function trelloApiUrl(credentials: TrelloCredentials, resource: string, params: Record<string, string> = {}) {
  const url = new URL(`/1/${resource}`, 'https://api.trello.com');
  url.searchParams.set('key', credentials.apiKey);
  url.searchParams.set('token', credentials.token);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function trelloRequest(url: URL, init?: RequestInit) {
  return fetchWithRetry(url.toString(), { ...init, redirect: 'error' }, {
    maxRetries: 0,
    retryableStatuses: [],
    timeoutMs: 15_000,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function completionLabelsKey(userId: number) {
  return `trelloCompletionLabels:${userId}`;
}

async function getCompletionLabels(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [row] = await db.select({ value: appSettings.value }).from(appSettings)
    .where(eq(appSettings.key, completionLabelsKey(userId))).limit(1);
  if (!row) return [];
  if (!row.value) throw new Error('Invalid Trello completion label configuration');
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed) || parsed.length > 50 || parsed.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Invalid Trello completion label configuration');
    }
    return parsed as string[];
  } catch {
    throw new Error('Invalid Trello completion label configuration');
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

function rejectShadowPilotCompletion(req: Request, res: Response) {
  const user = requestUser(req)!;
  if (req.body?.isCompleted !== true || process.env.APTLSS_MANAGER_SHADOW_ONLY !== 'true'
    || !isManagerPilotWorker(user.id)) return false;
  res.status(409).json({ error: 'Checklist completion is paused while APTLSS is in shadow mode. Report the completed work through Work guidance; the task remains open until it is verified.' });
  return true;
}

async function workerCompletionLabelsForUpdate(req: Request, res: Response) {
  const user = requestUser(req)!;
  if (user.role !== 'worker' || !Array.isArray(req.body?.idLabels)) return undefined;

  const completionLabels = await getCompletionLabels(user.id);
  const isShadowPilot = process.env.APTLSS_MANAGER_SHADOW_ONLY === 'true' && isManagerPilotWorker(user.id);
  if (isShadowPilot && req.body.idLabels.some((label: unknown) =>
    typeof label === 'string' && completionLabels.includes(label))) {
    res.status(409).json({ error: 'Applying a configured completion label is paused while APTLSS is in shadow mode. Report completed work through Work guidance; the task remains open until it is verified.' });
    return undefined;
  }

  return completionLabels;
}

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
  completionLabelsToPreserve?: string[],
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
  const credentials = getTrelloCredentials();
  if (!credentials) {
    res.status(503).json({ error: 'Trello credentials not configured' });
    return false;
  }
  const preserveCompletionLabels = Boolean(completionLabelsToPreserve?.length);
  const params: Record<string, string> = { fields: preserveCompletionLabels ? 'idMembers,idLabels' : 'idMembers' };
  if (checklistItem) params.checklists = 'all';
  const response = await trelloRequest(trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`, params));
  if (!response.ok) {
    res.status(response.status === 404 ? 404 : 502).json({ error: response.status === 404 ? 'Trello card not found' : 'Could not verify Trello card access' });
    return false;
  }
  const card = await response.json() as { idMembers?: unknown; idLabels?: unknown; checklists?: unknown };
  if (memberId) {
    if (!Array.isArray(card.idMembers) || !card.idMembers.every((id) => typeof id === 'string')) {
      res.status(502).json({ error: 'Could not verify Trello card access' });
      return false;
    }
    if (!card.idMembers.includes(memberId)) {
      res.status(403).json({ error: 'This Trello card is not assigned to your linked member account' });
      return false;
    }
  }
  if (preserveCompletionLabels) {
    if (!Array.isArray(card.idLabels) || !Array.isArray(req.body?.idLabels)) {
      res.status(502).json({ error: 'Could not verify Trello completion label protection' });
      return false;
    }

    const currentLabels = new Set(card.idLabels.filter((label): label is string => typeof label === 'string'));
    const retainedCompletionLabels = completionLabelsToPreserve!.filter((label) => currentLabels.has(label));
    // Trello treats idLabels as a replacement list, so keep existing completion
    // markers while allowing workers to edit the card's ordinary labels.
    req.body.idLabels = [...new Set([...req.body.idLabels, ...retainedCompletionLabels])];
  }
  if (checklistItem && !cardContainsChecklistItem(card, checklistItem.checklistId, checklistItem.checkItemId)) {
    res.status(403).json({ error: 'The checklist item does not belong to the selected Trello card' });
    return false;
  }
  return true;
}

router.param('cardId', async (req, res, next, cardId) => {
  try {
    const user = requestUser(req)!;
    const mutationPath = req.path.replace(/\/+$/, '').toLowerCase();
    if (req.method === 'PUT' && mutationPath.endsWith('/members') && user.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can change Trello card membership' });
      return;
    }
    if (req.method === 'PUT' && mutationPath.endsWith('/status') && rejectShadowPilotCompletion(req, res)) return;
    const completionLabels = req.method === 'PUT' && mutationPath.endsWith('/update')
      ? await workerCompletionLabelsForUpdate(req, res)
      : undefined;
    if (res.headersSent) return;
    if (await requireAssignedCard(req, res, cardId, undefined, completionLabels)) next();
  } catch (error) {
    console.error('[Trello] Card authorization failed');
    if (!res.headersSent) res.status(502).json({ error: 'Could not verify Trello card access' });
  }
});

/**
 * GET /api/trello/labels
 * Fetch all available labels from the connected Trello board
 */
router.get('/labels', requireAdmin, async (req: Request, res: Response) => {
  try {
    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    const boardsResponse = await trelloRequest(trelloApiUrl(credentials, 'members/me/boards'));
    if (!boardsResponse.ok) return res.status(502).json({ error: 'Could not fetch Trello boards' });
    const boards = await boardsResponse.json() as unknown;
    if (!Array.isArray(boards)) return res.status(502).json({ error: 'Could not verify Trello boards' });
    if (boards.length === 0) {
      return res.json({ labels: [] });
    }

    const firstBoard = boards[0];
    if (!isRecord(firstBoard) || typeof firstBoard.id !== 'string' || !firstBoard.id) {
      return res.status(502).json({ error: 'Could not verify Trello boards' });
    }
    const labelsResponse = await trelloRequest(trelloApiUrl(
      credentials,
      `boards/${encodeURIComponent(firstBoard.id)}/labels`,
    ));
    if (!labelsResponse.ok) return res.status(502).json({ error: 'Could not fetch Trello labels' });
    const labels = await labelsResponse.json() as unknown;
    if (!Array.isArray(labels) || !labels.every((label) => isRecord(label) && typeof label.id === 'string')) {
      return res.status(502).json({ error: 'Could not verify Trello labels' });
    }

    const transformedLabels = labels.map((label) => ({
      id: label.id,
      name: typeof label.name === 'string' && label.name ? label.name : 'Untitled',
      color: typeof label.color === 'string' && label.color ? label.color : '#cccccc',
    }));

    res.json({ labels: transformedLabels });
  } catch (error) {
    console.error('[Trello] Error fetching labels');
    res.status(502).json({ error: 'Failed to fetch Trello labels' });
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
    console.error('[Trello] Error fetching completion labels config');
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

    const labels = req.body?.labels;

    if (!Array.isArray(labels)) {
      return res.status(400).json({ error: 'Labels must be an array' });
    }

    const normalizedLabels = (labels as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 50);

    if (process.env.APTLSS_MANAGER_SHADOW_ONLY === 'true' && isManagerPilotWorker(user.id)) {
      const currentLabels = await getCompletionLabels(user.id);
      if (currentLabels.some((label) => !normalizedLabels.includes(label))) {
        return res.status(409).json({ error: 'Completion label protection cannot be weakened while APTLSS is in shadow mode' });
      }
    }

    await saveCompletionLabels(user.id, normalizedLabels);

    res.json({
      success: true,
      labels: normalizedLabels,
      message: 'Completion labels configuration saved successfully',
    });
  } catch (error) {
    console.error('[Trello] Error saving completion labels config');
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
    if (rejectShadowPilotCompletion(req, res)) return;
    if (!await requireAssignedCard(req, res, cardId, { checklistId, checkItemId })) return;

    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    // Update the checklist item state
    const updateUrl = trelloApiUrl(
      credentials,
      `checklists/${encodeURIComponent(checklistId)}/checkItems/${encodeURIComponent(checkItemId)}`,
    );
    const updateResponse = await trelloRequest(updateUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: isCompleted ? 'complete' : 'incomplete',
      }),
    });

    if (!updateResponse.ok) {
      console.error('[Trello] Failed to update checklist item', updateResponse.status);
      let userFriendlyError = 'Failed to update task in Trello';
      if (updateResponse.status === 401) {
        userFriendlyError = 'Permission denied: You do not have access to this card or checklist.';
      } else if (updateResponse.status === 404) {
        userFriendlyError = 'Task not found: The checklist item may have been deleted.';
      }
      
      return res.status(updateResponse.status).json({ 
        error: userFriendlyError,
      });
    }

    res.json({
      success: true,
      taskId,
      isCompleted,
      checkItemId,
      message: `Task marked as ${isCompleted ? 'complete' : 'incomplete'} in Trello`,
    });
  } catch (error) {
    console.error('[Trello] Error updating task completion');
    res.status(502).json({ error: 'Failed to update task completion' });
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

    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    // Fetch the card to get its current labels
    const cardUrl = trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`, { fields: 'labels,idLabels' });
    const cardResponse = await trelloRequest(cardUrl);

    if (!cardResponse.ok) {
      console.error('[Trello] Failed to fetch card', cardResponse.status);
      return res.status(cardResponse.status === 404 ? 404 : 502).json({
        error: cardResponse.status === 404 ? 'Card not found: This card may have been deleted or archived.' : 'Could not verify Trello card access',
      });
    }

    const card = await cardResponse.json() as unknown;
    if (!isRecord(card) || !Array.isArray(card.idLabels) || !card.idLabels.every((label) => typeof label === 'string')) {
      return res.status(502).json({ error: 'Could not verify Trello card labels' });
    }
    const currentLabels = card.idLabels as string[];

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
    const updateUrl = trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`);
    const updateResponse = await trelloRequest(updateUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idLabels: newLabels }),
    });

    if (!updateResponse.ok) {
      console.error('[Trello] Failed to update card status', updateResponse.status);
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
    console.error('[Trello] Error updating card status');
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
    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    const response = await trelloRequest(trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ due: dueDate }),
    });
    if (!response.ok) {
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the due date update',
      });
    }
    return res.json({ success: true, cardId, dueDate });
  } catch (error) {
    console.error('[Trello] Due date update failed');
    return res.status(502).json({ error: 'Could not update the Trello due date' });
  }
});

/**
 * GET /api/trello/boards/list
 * Fetch all available boards for the connected Trello user
 */
router.get('/boards/list', requireAdmin, async (req: Request, res: Response) => {
  try {
    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    const boardsResponse = await trelloRequest(trelloApiUrl(credentials, 'members/me/boards'));
    if (!boardsResponse.ok) return res.status(502).json({ error: 'Could not fetch Trello boards' });
    const boards = await boardsResponse.json() as unknown;
    if (!Array.isArray(boards) || !boards.every((board) => isRecord(board) && typeof board.id === 'string' && typeof board.name === 'string')) {
      return res.status(502).json({ error: 'Could not verify Trello boards' });
    }
    if (boards.length === 0) {
      return res.json({ boards: [] });
    }

    const transformedBoards = boards.map((board) => ({
      id: board.id,
      name: board.name,
      ...(typeof board.url === 'string' ? { url: board.url } : {}),
      ...(typeof board.closed === 'boolean' ? { closed: board.closed } : {}),
    }));

    res.json({ boards: transformedBoards });
  } catch (error) {
    console.error('[Trello] Error fetching boards');
    res.status(502).json({ error: 'Failed to fetch Trello boards' });
  }
});

/**
 * PUT /api/trello/cards/:cardId/update
 * Update card details (name, desc, labels) in Trello
 */
router.put('/cards/:cardId/update', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.params;
    const { name, desc, idLabels } = req.body ?? {};
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

    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    const updateUrl = trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`);

    if (name) updateUrl.searchParams.append('name', name);
    if (desc !== undefined) updateUrl.searchParams.append('desc', desc);
    if (idLabels) updateUrl.searchParams.append('idLabels', idLabels.join(','));

    const response = await trelloRequest(updateUrl, {
      method: 'PUT',
    });

    if (!response.ok) {
      console.error('[Trello] Failed to update card', response.status);
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the card update',
      });
    }

    res.json({
      success: true,
      card: {
        id: cardId,
        ...(name !== undefined ? { name } : {}),
        ...(desc !== undefined ? { desc } : {}),
        ...(idLabels !== undefined ? { idLabels } : {}),
      },
    });
  } catch (error) {
    console.error('[Trello] Error updating card');
    res.status(502).json({ error: 'Failed to update Trello card' });
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

    const credentials = getTrelloCredentials();
    if (!credentials) return res.status(503).json({ error: 'Trello credentials not configured' });

    const updateUrl = trelloApiUrl(credentials, `cards/${encodeURIComponent(cardId)}`);
    updateUrl.searchParams.set('idMembers', idMembers.join(','));

    const response = await trelloRequest(updateUrl, {
      method: 'PUT',
    });

    if (!response.ok) {
      console.error('[Trello] Failed to update card members', response.status);
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'Trello card not found' : 'Trello did not accept the card member update',
      });
    }

    res.json({ success: true, card: { id: cardId, idMembers } });
  } catch (error) {
    console.error('[Trello] Error updating card members');
    res.status(502).json({ error: 'Failed to update Trello card members' });
  }
});

export default router;
