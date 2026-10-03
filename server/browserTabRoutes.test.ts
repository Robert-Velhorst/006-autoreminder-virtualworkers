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
import { MAX_BROWSER_TAB_CAPTURE_SEQUENCE } from '../shared/browserTabProtocol';

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

  it('does not emit realtime invalidations when an identical sequence is replayed', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 0, allowedTabs: 0, shouldWarn: false,
      changed: false, staleIgnored: false, storedCaptureSequence: 7,
    });
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token').send({ ...validInventory, captureSequence: 7 });

    expect(response.status).toBe(200);
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

  it('rejects capture timestamps outside the MySQL TIMESTAMP range before storage', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 0, allowedTabs: 0, shouldWarn: false,
      changed: true, staleIgnored: false, storedCaptureSequence: 1,
    });
    for (const sourceCapturedAt of [
      '1969-12-31T23:59:59.000Z',
      '2038-01-19T03:14:08.000Z',
    ]) {
      const response = await request(createApp()).post('/api/browser-tabs/ingest')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validInventory, sourceCapturedAt });

      expect(response.status).toBe(400);
    }
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('accepts the unsigned database maximum and rejects values above it', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 0, allowedTabs: 0, shouldWarn: false,
      changed: true, staleIgnored: false, storedCaptureSequence: MAX_BROWSER_TAB_CAPTURE_SEQUENCE,
    });
    const maximum = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, captureSequence: MAX_BROWSER_TAB_CAPTURE_SEQUENCE });

    expect(maximum.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(7, expect.objectContaining({ captureSequence: MAX_BROWSER_TAB_CAPTURE_SEQUENCE }));

    mocks.ingest.mockClear();
    const overflow = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, captureSequence: MAX_BROWSER_TAB_CAPTURE_SEQUENCE + 1 });

    expect(overflow.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('strips page details and untrusted titles before handing inventory to storage', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 1, allowedTabs: 5, shouldWarn: false,
      changed: true, staleIgnored: false, storedCaptureSequence: 1,
    });
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...validInventory,
        tabs: [{
          id: '41',
          title: 'Private client case and account details',
          url: 'https://user:password@EXAMPLE.test:443/private/case?token=secret#notes',
          pinned: false,
          active: true,
          windowId: 3,
        }],
      });

    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(7, expect.objectContaining({
      tabs: [{
        id: '41',
        title: 'example.test',
        url: 'https://example.test/',
        pinned: false,
        active: true,
        windowId: 3,
      }],
    }));
    const forwarded = JSON.stringify(mocks.ingest.mock.calls);
    expect(forwarded).not.toContain('Private client case');
    expect(forwarded).not.toContain('password');
    expect(forwarded).not.toContain('token=secret');
    expect(forwarded).not.toContain('/private/case');
    expect(forwarded).not.toContain('#notes');
  });

  it('rejects unbounded titles and extension-supplied page content before storage', async () => {
    const oversizedTitle = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...validInventory,
        tabs: [{
          id: 1, title: 'x'.repeat(513), url: 'https://example.test/',
          pinned: false, active: true, windowId: 1,
        }],
      });
    expect(oversizedTitle.status).toBe(400);

    const suppliedText = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...validInventory,
        tabs: [{
          id: 1, title: 'example.test', url: 'https://example.test/',
          pinned: false, active: true, windowId: 1,
          text: 'Private page body must not be collected',
        }],
      });
    expect(suppliedText.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects duplicate tab IDs before storage so reported tab counts cannot be inflated', async () => {
    mocks.ingest.mockResolvedValue({
      status: 'compliant', actionableTabs: 2, allowedTabs: 5, shouldWarn: false,
      changed: true, staleIgnored: false, storedCaptureSequence: 1,
    });
    const duplicateTab = {
      id: '41', title: 'example.test', url: 'https://example.test/',
      pinned: false, active: false, windowId: 3,
    };
    const response = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, tabs: [duplicateTab, duplicateTab] });

    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects unsupported schemes and unknown inventory fields', async () => {
    const unsupportedUrl = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...validInventory,
        tabs: [{
          id: 1, title: 'Extensions', url: 'chrome://extensions/',
          pinned: false, active: true, windowId: 1,
        }],
      });
    expect(unsupportedUrl.status).toBe(400);

    const unexpectedField = await request(createApp()).post('/api/browser-tabs/ingest')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...validInventory, pageText: 'Private content' });
    expect(unexpectedField.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
