import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), feed: vi.fn() }));
vi.mock('./haiConnector', () => ({ resolveHaiConnectorOwner: mocks.owner, getHaiWorkerControlFeed: mocks.feed }));
import { registerHaiConnectorRoutes } from './haiConnectorRoutes';

beforeEach(() => vi.resetAllMocks());
function app() {
  const server = express();
  server.use(rateLimit({ windowMs: 60_000, limit: 100, legacyHeaders: false }));
  registerHaiConnectorRoutes(server);
  return server;
}

describe('HAI bearer route boundary', () => {
  it('accepts a case-insensitive scheme with a bounded token', async () => {
    mocks.owner.mockResolvedValue(7);
    mocks.feed.mockResolvedValue({ items: [] });
    await request(app()).get('/api/integrations/hai/feed').set('Authorization', 'bEaReR worker-token').expect(200);
    expect(mocks.owner).toHaveBeenCalledWith('worker-token');
    expect(mocks.feed).toHaveBeenCalledWith(7, undefined, 50);
  });

  it.each(['Basic worker-token', 'Bearer' + ' '.repeat(4096) + 'x', 'Bearer ' + 'x'.repeat(4096)])(
    'refuses a malformed or oversized authorization header', async authorization => {
      mocks.owner.mockResolvedValue(null);
      await request(app()).get('/api/integrations/hai/feed').set('Authorization', authorization).expect(401);
      expect(mocks.owner).toHaveBeenCalledWith(undefined);
      expect(mocks.feed).not.toHaveBeenCalled();
    },
  );
});
