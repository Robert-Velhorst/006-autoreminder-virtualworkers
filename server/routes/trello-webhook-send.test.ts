import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeConversation: vi.fn(),
  isTrelloCommentAutomationEnabled: vi.fn(),
  postTrelloComment: vi.fn(),
  sendScheduledCheckin: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuthenticated: (req: any, _res: any, next: any) => {
    req.user = { id: 1, role: 'admin', name: 'Admin' };
    next();
  },
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { id: 1, role: 'admin', name: 'Admin' };
    next();
  },
}));
vi.mock('../services/chatbot-history', () => ({
  getCardConversations: vi.fn(),
  storeConversation: mocks.storeConversation,
}));
vi.mock('../services/trello-chatbot', () => ({
  isTrelloCommentAutomationEnabled: mocks.isTrelloCommentAutomationEnabled,
  postTrelloComment: mocks.postTrelloComment,
  sendScheduledCheckin: mocks.sendScheduledCheckin,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: 'Trello comment automation is disabled.',
}));

import trelloWebhookRoutes from './trello-webhook';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/trello-webhook', trelloWebhookRoutes);
  return app;
}

describe('explicit Trello send routes and duplicate protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrelloCommentAutomationEnabled.mockReturnValue(true);
    mocks.postTrelloComment.mockResolvedValue(true);
    mocks.sendScheduledCheckin.mockResolvedValue(true);
    mocks.storeConversation.mockResolvedValue(42);
  });

  it.each([
    ['returns no row id', async () => { mocks.storeConversation.mockResolvedValueOnce(null); }],
    ['throws', async () => { mocks.storeConversation.mockRejectedValueOnce(new Error('history unavailable')); }],
  ])('reports a confirmed manual post without inviting a duplicate retry when history storage %s', async (_case, arrange) => {
    await arrange();

    const response = await request(createApp())
      .post('/api/trello-webhook/send')
      .send({ cardId: 'card-1', message: 'Please review this update.' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      posted: true,
      historySaved: false,
      retryAllowed: false,
    });
    expect(response.body.warning).toMatch(/posted to Trello/i);
    expect(response.body.warning).toMatch(/do not retry/i);
    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
    expect(mocks.storeConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['returns no row id', async () => { mocks.storeConversation.mockResolvedValueOnce(null); }],
    ['throws', async () => { mocks.storeConversation.mockRejectedValueOnce(new Error('history unavailable')); }],
  ])('reports a confirmed check-in without inviting a duplicate retry when history storage %s', async (_case, arrange) => {
    await arrange();

    const response = await request(createApp())
      .post('/api/trello-webhook/checkin')
      .send({ cardId: 'card-1' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      posted: true,
      historySaved: false,
      retryAllowed: false,
    });
    expect(response.body.warning).toMatch(/posted to Trello/i);
    expect(response.body.warning).toMatch(/do not retry/i);
    expect(mocks.sendScheduledCheckin).toHaveBeenCalledTimes(1);
    expect(mocks.storeConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['manual send', '/send', { cardId: 'card-1', message: 'Update' }, () => mocks.postTrelloComment.mockResolvedValueOnce(false)],
    ['check-in', '/checkin', { cardId: 'card-1' }, () => mocks.sendScheduledCheckin.mockResolvedValueOnce(false)],
  ])('does not invite retry when the %s outcome is unconfirmed', async (_name, path, body, arrange) => {
    arrange();

    const response = await request(createApp())
      .post(`/api/trello-webhook${path}`)
      .send(body)
      .expect(409);

    expect(response.body).toMatchObject({
      success: false,
      deliveryStatus: 'unknown',
      retryAllowed: false,
    });
    expect(response.body.error).toMatch(/may already be on the card/i);
    expect(response.body.nextStep).toMatch(/open the Trello card/i);
    expect(mocks.storeConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['manual send', '/send', { cardId: 'card-1', message: 'Update' }, () => mocks.postTrelloComment.mockRejectedValueOnce(new Error('connection lost'))],
    ['check-in', '/checkin', { cardId: 'card-1' }, () => mocks.sendScheduledCheckin.mockRejectedValueOnce(new Error('connection lost'))],
  ])('returns an explicit non-retryable outcome when the %s provider call throws', async (_name, path, body, arrange) => {
    arrange();

    const response = await request(createApp())
      .post(`/api/trello-webhook${path}`)
      .send(body)
      .expect(409);

    expect(response.body).toMatchObject({ deliveryStatus: 'unknown', retryAllowed: false });
    expect(response.body.nextStep).toMatch(/do not send it again/i);
    expect(mocks.storeConversation).not.toHaveBeenCalled();
  });

  it('does not bypass the existing Trello/worker review gate', async () => {
    mocks.postTrelloComment.mockResolvedValueOnce(false);

    const response = await request(createApp())
      .post('/api/trello-webhook/send')
      .send({ cardId: 'pilot-card', message: 'Update' })
      .expect(409);

    expect(response.body.retryAllowed).toBe(false);
    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
    expect(mocks.storeConversation).not.toHaveBeenCalled();
  });
});
