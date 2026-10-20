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
  const originalPublicUrl = process.env.TRELLO_WEBHOOK_CALLBACK_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRELLO_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.TRELLO_WEBHOOK_CALLBACK_URL = 'https://dashboard.example/api/trello-webhook';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.TRELLO_WEBHOOK_SECRET;
    else process.env.TRELLO_WEBHOOK_SECRET = originalSecret;
    if (originalPublicUrl === undefined) delete process.env.TRELLO_WEBHOOK_CALLBACK_URL;
    else process.env.TRELLO_WEBHOOK_CALLBACK_URL = originalPublicUrl;
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
    expect(status).toContain('const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();');
    expect(status).not.toContain("req.get('host')");
  });

  it('does not expose storage failures through the public signed callback', async () => {
    mocks.getDb.mockRejectedValue(new Error('ER_ACCESS_DENIED_ERROR: mysql password rejected'));
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: { id: 'action-storage-failure', type: 'updateCard', data: { card: { id: 'card-1' }, board: { id: 'board-1' } } },
      model: { id: 'board-1' },
    });
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

  it('does not acknowledge a signed event when storage is unavailable', async () => {
    mocks.getDb.mockResolvedValue(null);
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: { id: 'action-storage-unavailable', type: 'updateCard', data: { card: { id: 'card-1' }, board: { id: 'board-1' } } },
      model: { id: 'board-1' },
    });
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

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Trello webhook storage is unavailable' });
  });

  it('rejects signed events without a stable action ID before touching storage', async () => {
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: { type: 'updateCard', data: { card: { id: 'card-1' }, board: { id: 'board-1' } } },
      model: { id: 'board-1' },
    });
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

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Trello action ID is required' });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('does not acknowledge a signed event when inserting its archive record fails', async () => {
    let statement = 0;
    const insertValues = vi.fn().mockRejectedValue(new Error('database write failed'));
    mocks.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback({
        execute: vi.fn(async () => {
          statement += 1;
          return { rows: statement <= 2 ? [{ id: 'webhook-1' }] : [] };
        }),
        insert: vi.fn(() => ({ values: insertValues })),
      })),
    });
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: { id: 'action-write-failure', type: 'updateCard', data: { card: { id: 'card-1' }, board: { id: 'board-1' } } },
      model: { id: 'board-1' },
    });
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
    expect(response.text).not.toContain('database write failed');
  });

  it('archives a Trello action only once when the same signed delivery is replayed', async () => {
    const archived: Array<Record<string, any>> = [];
    const insertValues = vi.fn(async (record: Record<string, any>) => {
      archived.push(record);
      return undefined;
    });
    mocks.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        let statement = 0;
        const tx = {
          execute: vi.fn(async () => {
            statement += 1;
            if (statement <= 2) return { rows: [{ id: 'webhook-1' }] };
            if (statement === 3) return { rows: archived.length ? [{ id: 1 }] : [] };
            return { rows: [] };
          }),
          insert: vi.fn(() => ({ values: insertValues })),
        };
        return callback(tx);
      }),
    });
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: {
        id: 'action-replayed-1',
        type: 'updateCard',
        date: '2026-09-25T10:00:00.000Z',
        data: { card: { id: 'card-1', name: 'Current title' }, board: { id: 'board-1' } },
      },
      model: { id: 'board-1' },
      webhook: { id: 'webhook-1' },
    });
    const signature = createHmac('sha1', process.env.TRELLO_WEBHOOK_SECRET!)
      .update(Buffer.concat([Buffer.from(body), Buffer.from(callbackUrl)]))
      .digest('base64');
    const app = express();
    app.use(express.json({ verify: (req, _res, buffer) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
    app.use('/api/trello-webhook', trelloWebhookRoutes);

    const deliver = () => request(app)
      .post('/api/trello-webhook')
      .set('x-trello-webhook', signature)
      .set('content-type', 'application/json')
      .send(body);

    const first = await deliver();
    const replay = await deliver();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ success: true, duplicate: true });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0][0].commandArgs).toContain('action-replayed-1');
    expect(JSON.parse(insertValues.mock.calls[0][0].commandArgs)._trelloWebhook.sourceDate)
      .toBe('2026-09-25T10:00:00.000Z');
  });

  it('retains Trello source dates when distinct actions arrive out of order', async () => {
    const archived: Array<Record<string, any>> = [];
    const insertValues = vi.fn(async (record: Record<string, any>) => {
      archived.push(record);
      return undefined;
    });
    mocks.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        let statement = 0;
        return callback({
          execute: vi.fn(async () => {
            statement += 1;
            return { rows: statement <= 2 ? [{ id: 'webhook-1' }] : [] };
          }),
          insert: vi.fn(() => ({ values: insertValues })),
        });
      }),
    });
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const app = express();
    app.use(express.json({ verify: (req, _res, buffer) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
    app.use('/api/trello-webhook', trelloWebhookRoutes);

    const deliver = async (id: string, sourceDate: string, cardName: string) => {
      const body = JSON.stringify({
        action: {
          id,
          type: 'updateCard',
          date: sourceDate,
          data: { card: { id: 'card-1', name: cardName }, board: { id: 'board-1' } },
        },
        model: { id: 'board-1' },
        webhook: { id: 'webhook-1' },
      });
      const signature = createHmac('sha1', process.env.TRELLO_WEBHOOK_SECRET!)
        .update(Buffer.concat([Buffer.from(body), Buffer.from(callbackUrl)]))
        .digest('base64');
      return request(app)
        .post('/api/trello-webhook')
        .set('x-trello-webhook', signature)
        .set('content-type', 'application/json')
        .send(body);
    };

    const newer = await deliver('action-newer', '2026-09-25T11:00:00.000Z', 'Newer title');
    const delayedOlder = await deliver('action-older', '2026-09-25T10:00:00.000Z', 'Older title');

    expect(newer.status).toBe(200);
    expect(delayedOlder.status).toBe(200);
    expect(archived).toHaveLength(2);
    expect(archived.map((record) => JSON.parse(record.commandArgs)._trelloWebhook.sourceDate)).toEqual([
      '2026-09-25T11:00:00.000Z',
      '2026-09-25T10:00:00.000Z',
    ]);
  });

  it('does not archive an event when its registered webhook lock cannot be found', async () => {
    const insertValues = vi.fn();
    mocks.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback({
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        insert: vi.fn(() => ({ values: insertValues })),
      })),
    });
    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const body = JSON.stringify({
      action: {
        id: 'action-without-registration',
        type: 'updateCard',
        data: { card: { id: 'card-1' }, board: { id: 'board-unregistered' } },
      },
      model: { id: 'board-unregistered' },
    });
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

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Trello webhook replay protection is unavailable' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent deliveries of one action through different model registrations', async () => {
    const archived: Array<Record<string, any>> = [];
    const registeredModels = new Set(['board-1', 'workspace-1']);
    const lockTails = new Map<string, Promise<void>>();
    const acquireLock = async (key: string) => {
      const previous = lockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => held);
      lockTails.set(key, tail);
      await previous;
      return () => {
        release();
        if (lockTails.get(key) === tail) lockTails.delete(key);
      };
    };

    mocks.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        const releases: Array<() => void> = [];
        const tx = {
          execute: vi.fn(async (query: any) => {
            const chunks = query.queryChunks as unknown[];
            const queryText = chunks.map((chunk: any) =>
              chunk && typeof chunk === 'object' && Array.isArray(chunk.value)
                ? chunk.value.join('')
                : '?'
            ).join('');
            const parameters = chunks.filter((chunk): chunk is string => typeof chunk === 'string');

            if (queryText.includes('FROM chatbot_webhooks')) {
              const isModelScoped = queryText.includes('WHERE "modelId" =');
              if (queryText.includes('FOR UPDATE')) {
                const lockKey = isModelScoped ? `model:${parameters[0]}` : 'all-registered-models';
                releases.push(await acquireLock(lockKey));
              }

              if (!isModelScoped) return { rows: [{ id: 1 }] };
              return { rows: registeredModels.has(parameters[0]) ? [{ id: parameters[0] }] : [] };
            }

            if (queryText.includes('FROM chatbot_conversations')) {
              const actionId = parameters[0];
              const alreadyArchived = archived.some((record) =>
                JSON.parse(record.commandArgs)._trelloWebhook.actionId === actionId
              );
              // Let concurrent transactions reach the replay check before either inserts.
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { rows: alreadyArchived ? [{ id: 1 }] : [] };
            }

            throw new Error(`Unexpected webhook SQL: ${queryText}`);
          }),
          insert: vi.fn(() => ({ values: vi.fn(async (record: Record<string, any>) => { archived.push(record); }) })),
        };

        try {
          return await callback(tx);
        } finally {
          releases.reverse().forEach((release) => release());
        }
      }),
    });

    const callbackUrl = 'https://dashboard.example/api/trello-webhook';
    const app = express();
    app.use(express.json({ verify: (req, _res, buffer) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
    app.use('/api/trello-webhook', trelloWebhookRoutes);

    const deliver = async (modelId: string) => {
      const body = JSON.stringify({
        action: {
          id: 'shared-action-1',
          type: 'updateCard',
          date: '2026-09-25T10:00:00.000Z',
          data: { card: { id: 'card-1', name: 'Updated title' }, board: { id: 'board-1' } },
        },
        model: { id: modelId },
        webhook: { id: `hook-${modelId}` },
      });
      const signature = createHmac('sha1', process.env.TRELLO_WEBHOOK_SECRET!)
        .update(Buffer.concat([Buffer.from(body), Buffer.from(callbackUrl)]))
        .digest('base64');
      return request(app)
        .post('/api/trello-webhook')
        .set('x-trello-webhook', signature)
        .set('content-type', 'application/json')
        .send(body);
    };

    const responses = await Promise.all([deliver('board-1'), deliver('workspace-1')]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.filter((response) => response.body.duplicate)).toHaveLength(1);
    expect(archived).toHaveLength(1);
  });
});
