import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  resolveWorker: vi.fn(async (token: string | null) => token === 'valid-token' ? 7 : null),
  resolveOpenId: vi.fn(async () => 'browser-worker-open-id'),
  ingest: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('./browserTabHygiene', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browserTabHygiene')>();
  return {
    ...actual,
    ingestBrowserTabInventory: mocks.ingest,
    resolveBrowserTabCollectorUserOpenId: mocks.resolveOpenId,
    resolveBrowserTabCollectorWorker: mocks.resolveWorker,
  };
});
vi.mock('./services/websocket', () => ({ websocketService: { emitToUser: mocks.emit } }));
import { BrowserTabCollectorConflictError } from './browserTabHygiene';
import { registerBrowserTabRoutes } from './browserTabRoutes';

function createApp() {
  const app = express();
  app.use(express.json());
  registerBrowserTabRoutes(app);
  return app;
}

const validInventory = {
  protocolVersion: 2,
  collectorId: 'collector-1',
  captureSequence: 1,
  sourceCapturedAt: '2026-09-25T10:00:00.000Z',
  tabs: [],
};

describe('browser tab collector error boundary', () => {
  beforeEach(() => {
    mocks.resolveWorker.mockClear();
    mocks.resolveOpenId.mockClear();
    mocks.ingest.mockReset();
    mocks.emit.mockReset();
  });

  it('returns validation feedback without exposing unexpected internal errors', () => {
    const source = readFileSync(new URL('./browserTabRoutes.ts', import.meta.url), 'utf8');

    expect(source).toContain('"Browser inventory could not be recorded. Retry shortly."');
    expect(source).not.toContain('error instanceof Error ? error.message : "Browser inventory failed"');
  });

  it('requires the sequenced collector protocol before accepting inventory', async () => {
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, protocolVersion: undefined });

    expect(response.status).toBe(426);
    expect(response.body.error).toContain('update required');
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns a worker-safe conflict response when a collector identity is out of scope', async () => {
    mocks.ingest.mockRejectedValue(new BrowserTabCollectorConflictError());
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token').send(validInventory);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Re-pair');
  });

  it('does not emit duplicate realtime updates for an ignored stale report', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 0, allowedTabs: 0, shouldWarn: false,
      changed: false, staleIgnored: true, storedCaptureSequence: 7,
    });
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token').send(validInventory);

    expect(response.status).toBe(200);
    expect(response.body.staleIgnored).toBe(true);
    expect(response.body.storedCaptureSequence).toBe(7);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('keeps malformed sequenced inventory on the validation path', async () => {
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, captureSequence: 0 });

    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
