import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('../db', () => ({ getDb: mocks.getDb }));
import trelloWebhookRoutes, { normalizeConversationCountCardIds, verifyTrelloWebhook } from './trello-webhook';

describe('Trello webhook verification', () => {
  const originalSecret = process.env.TRELLO_WEBHOOK_SECRET;
  const originalPublicUrl = process.env.PUBLIC_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRELLO_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.PUBLIC_URL = 'https://dashboard.example';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.TRELLO_WEBHOOK_SECRET;
    else process.env.TRELLO_WEBHOOK_SECRET = originalSecret;
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
  });

  it('accepts only a signature bound to the exact body and callback URL', () => {
    const rawBody = Buffer.from(JSON.stringify({ action: { id: 'action-1' } }));
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const secret = 'test-application-secret';
    const signature = createHmac('sha1', secret)
      .update(Buffer.concat([rawBody, Buffer.from(callbackUrl)]))
      .digest('base64');

    expect(verifyTrelloWebhook({ rawBody, callbackUrl, secret, signature })).toBe(true);
    expect(verifyTrelloWebhook({ rawBody: Buffer.from('{}'), callbackUrl, secret, signature })).toBe(false);
    expect(verifyTrelloWebhook({ rawBody, callbackUrl: `${callbackUrl}/wrong`, secret, signature })).toBe(false);
  });

  it('bounds and validates card IDs before a conversation-count query', () => {
    expect(normalizeConversationCountCardIds(["card-a", "card-a", "card-b"])).toEqual(["card-a", "card-b"]);
    expect(normalizeConversationCountCardIds(["", 42, "x".repeat(129)])).toEqual([]);
    expect(() => normalizeConversationCountCardIds(Array.from({ length: 201 }, (_, index) => `card-${index}`))).toThrow("at most 200");
  });

  it('keeps the recent conversation feed behind the admin boundary', async () => {
    const app = express();
    app.use('/api/trello-webhook', trelloWebhookRoutes);

    await request(app)
      .get('/api/trello-webhook/recent?days=7')
      .expect(401, { error: 'Unauthorized' });
  });

  it('uses only the configured callback URL for registration and reachability checks', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/routes/trello-webhook.ts'), 'utf8');
    const registration = source.slice(source.indexOf("router.post('/register'"), source.indexOf("router.get('/list'"));
    const status = source.slice(source.indexOf("router.get('/status'"), source.indexOf("router.post('/conversation-counts'"));

    expect(registration).toContain('const configuredCallbackUrl = callbackUrl();');
    expect(registration).not.toContain("req.get('host')");
    expect(registration).toContain('signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS)');
    expect(registration).toContain("error: 'Failed to register webhook with Trello'");
    expect(status).toContain('const configuredCallbackUrl = callbackUrl();');
    expect(status).not.toContain("req.get('host')");
  });

  it('does not expose storage failures through the public signed callback', async () => {
    mocks.getDb.mockRejectedValue(new Error('ER_ACCESS_DENIED_ERROR: mysql password rejected'));
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({ type: 'updateCard', data: { card: { id: 'card-1' } } });
    const signature = createHmac('sha1', process.env.TRELLO_WEBHOOK_SECRET!)
      .update(Buffer.concat([Buffer.from(body), Buffer.from(callbackUrl)]))
      .digest('base64');
    const app = express();
    app.use(express.json({ verify: (req, _res, buffer) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
    app.use('/api/trello-webhook', trelloWebhookRoutes);

    const response = await request(app)
      .post('/api/trello-webhook')
      .set('x-trello-webhook', signature)
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Trello webhook processing failed' });
    expect(response.text).not.toContain('ER_ACCESS_DENIED_ERROR');
  });
});
