import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dependency = vi.hoisted(() => ({ database: vi.fn(), redis: vi.fn() }));
vi.mock('../db', () => ({ isDatabaseReachable: dependency.database }));
vi.mock('../services/redis', () => ({ isRedisAvailable: dependency.redis }));
import { configureRequestAdmission, createRequestAdmissionLimiter } from './requestAdmission';

const config = { MAX_CONCURRENT_REQUESTS: '1', MAX_PENDING_REQUESTS: '2', REQUEST_QUEUE_TIMEOUT_MS: '100' };
function connection() {
  const req = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(),
  }) as unknown as Response;
  const next = vi.fn();
  return { req, res, next };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('request admission lifecycle', () => {
  it.each(['aborted', 'close', 'finish'] as const)('removes waiting %s clients without invoking downstream work', event => {
    const limiter = createRequestAdmissionLimiter(config);
    const active = connection(), cancelled = connection(), remaining = connection();
    limiter(active.req, active.res, active.next);
    limiter(cancelled.req, cancelled.res, cancelled.next);
    if (event === 'aborted') cancelled.req.emit(event); else cancelled.res.emit(event);
    limiter(remaining.req, remaining.res, remaining.next);
    active.res.emit('finish');
    expect(cancelled.next).not.toHaveBeenCalled();
    expect(remaining.next).toHaveBeenCalledOnce();
    expect(cancelled.req.listenerCount('aborted')).toBe(0);
    expect(cancelled.res.listenerCount('close')).toBe(0);
    remaining.res.emit('finish');
  });

  it('checks disconnection at acquisition even if no abort event was observed', () => {
    const limiter = createRequestAdmissionLimiter(config);
    const active = connection(), cancelled = connection(), remaining = connection();
    limiter(active.req, active.res, active.next);
    limiter(cancelled.req, cancelled.res, cancelled.next);
    Object.defineProperty(cancelled.req, 'aborted', { value: true });
    limiter(remaining.req, remaining.res, remaining.next);
    active.res.emit('finish');
    expect(cancelled.next).not.toHaveBeenCalled();
    expect(remaining.next).toHaveBeenCalledOnce();
    remaining.res.emit('finish');
  });

  it('releases active slots once across finish, abort and close events', () => {
    const limiter = createRequestAdmissionLimiter(config);
    const a = connection(), b = connection(), c = connection();
    for (const item of [a, b, c]) limiter(item.req, item.res, item.next);
    a.res.emit('finish'); a.req.emit('aborted'); a.res.emit('close');
    expect(b.next).toHaveBeenCalledOnce();
    expect(c.next).not.toHaveBeenCalled();
    b.res.emit('close'); b.res.emit('finish');
    expect(c.next).toHaveBeenCalledOnce();
    c.res.emit('finish');
  });

  it('times out without acquiring or leaking a pending slot and rejects excess queue entries', () => {
    vi.useFakeTimers();
    const limiter = createRequestAdmissionLimiter({ ...config, MAX_PENDING_REQUESTS: '1' });
    const a = connection(), b = connection(), overflow = connection(), c = connection();
    limiter(a.req, a.res, a.next);
    limiter(b.req, b.res, b.next);
    limiter(overflow.req, overflow.res, overflow.next);
    expect(overflow.res.status).toHaveBeenCalledWith(503);
    expect(overflow.res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    vi.advanceTimersByTime(100);
    expect(b.res.status).toHaveBeenCalledWith(503);
    expect(b.next).not.toHaveBeenCalled();
    limiter(c.req, c.res, c.next);
    a.res.emit('finish');
    expect(c.next).toHaveBeenCalledOnce();
    c.res.emit('finish');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never writes a timeout response to a disconnected client', () => {
    vi.useFakeTimers();
    const limiter = createRequestAdmissionLimiter(config);
    const a = connection(), b = connection();
    limiter(a.req, a.res, a.next); limiter(b.req, b.res, b.next);
    Object.defineProperty(b.res, 'destroyed', { value: true });
    vi.advanceTimersByTime(100);
    expect(b.res.status).not.toHaveBeenCalled();
    expect(b.next).not.toHaveBeenCalled();
    a.res.emit('finish');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses slots after sustained cancellation without retaining event handlers', () => {
    vi.useFakeTimers();
    const limiter = createRequestAdmissionLimiter(config);
    for (let round = 0; round < 500; round++) {
      const a = connection(), b = connection(), c = connection();
      limiter(a.req, a.res, a.next); limiter(b.req, b.res, b.next);
      b.res.emit('close');
      limiter(c.req, c.res, c.next);
      a.res.emit('close');
      expect(c.next).toHaveBeenCalledOnce();
      c.res.emit('finish');
      for (const item of [a, b, c]) {
        expect(item.req.listenerCount('aborted')).toBe(0);
        expect(item.res.listenerCount('close')).toBe(0);
        expect(item.res.listenerCount('finish')).toBe(0);
      }
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves FIFO after cancelling the head, middle and tail and ignores normal request-body close', () => {
    const limiter = createRequestAdmissionLimiter({ ...config, MAX_PENDING_REQUESTS: '8' });
    const active = connection();
    limiter(active.req, active.res, active.next);
    const queue = Array.from({ length: 5 }, connection);
    const order: number[] = [];
    queue.forEach((item, index) => {
      item.next.mockImplementation(() => order.push(index));
      limiter(item.req, item.res, item.next);
    });
    for (const index of [0, 2, 4]) queue[index].res.emit('close');
    queue[1].req.emit('close');
    active.res.emit('finish');
    expect(order).toEqual([1]);
    queue[1].res.emit('finish');
    expect(order).toEqual([1, 3]);
    queue[3].res.emit('finish');
  });

  it.each(['timeout-first', 'handoff-first'])('settles timeout/handoff races once: %s', ordering => {
    vi.useFakeTimers();
    const limiter = createRequestAdmissionLimiter(config);
    const a = connection(), b = connection(), c = connection();
    limiter(a.req, a.res, a.next); limiter(b.req, b.res, b.next);
    if (ordering === 'timeout-first') {
      vi.advanceTimersByTime(100); a.res.emit('finish');
      expect(b.next).not.toHaveBeenCalled();
      expect(b.res.json).toHaveBeenCalledOnce();
    } else {
      a.res.emit('finish'); vi.advanceTimersByTime(100);
      expect(b.next).toHaveBeenCalledOnce();
      expect(b.res.json).not.toHaveBeenCalled();
      b.res.emit('finish');
    }
    b.res.emit('close');
    limiter(c.req, c.res, c.next);
    expect(c.next).toHaveBeenCalledOnce();
    c.res.emit('finish');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already disconnected direct request without reserving capacity', () => {
    const limiter = createRequestAdmissionLimiter(config);
    const closed = connection(), live = connection();
    Object.defineProperty(closed.res, 'destroyed', { value: true });
    limiter(closed.req, closed.res, closed.next);
    limiter(live.req, live.res, live.next);
    expect(closed.next).not.toHaveBeenCalled();
    expect(live.next).toHaveBeenCalledOnce();
    live.res.emit('finish');
  });
});

describe('composed public probe admission', () => {
  it('keeps probes responsive before body parsing under saturation and reports dependency failure honestly', async () => {
    vi.stubEnv('REDIS_URL', '');
    dependency.database.mockResolvedValue(true);
    const app = express();
    configureRequestAdmission(app, { ...config, MAX_PENDING_REQUESTS: '1' });
    app.use(express.json());
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    app.get('/slow', (_req, res) => { release = () => { if (!res.writableEnded) res.send('done'); }; entered(); });
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const held = request(url).get('/slow').then(response => response);
    try {
      await started;
      for (const path of ['/api/health/live', '/api/health/ready', '/readyz']) {
        await request(url).get(path).set('Content-Type', 'application/json').send('{invalid')
          .timeout({ deadline: 1000 }).expect(200);
      }
      await request(url).get('/other').expect(503);
      await request(url).get('/api/health/not-a-probe').expect(503);
      dependency.database.mockResolvedValue(false);
      await request(url).get('/api/health/ready').expect(503);
      await request(url).get('/api/health/live').expect(200);
    } finally {
      release?.(); await held;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('does not dispatch a real disconnected queued HTTP client after the active response finishes', async () => {
    const app = express();
    let waitingClosed!: () => void, queued!: () => void, entered!: () => void;
    const closed = new Promise<void>(resolve => { waitingClosed = resolve; });
    const queuedStarted = new Promise<void>(resolve => { queued = resolve; });
    const activeStarted = new Promise<void>(resolve => { entered = resolve; });
    app.use((req, res, next) => {
      if (req.path === '/cancelled') { res.once('close', waitingClosed); queued(); }
      next();
    });
    configureRequestAdmission(app, { ...config, REQUEST_QUEUE_TIMEOUT_MS: '5000' });
    let release!: () => void;
    const sideEffect = vi.fn();
    app.get('/slow', (_req, res) => { release = () => { if (!res.writableEnded) res.send('done'); }; entered(); });
    app.get('/cancelled', (_req, res) => { sideEffect(); res.send('unexpected'); });
    app.get('/next', (_req, res) => res.send('next'));
    const server = createServer(app);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const held = request(url).get('/slow').then(response => response);
    const client = httpRequest(`${url}/cancelled`);
    client.on('error', () => undefined);
    try {
      await activeStarted; client.end(); await queuedStarted;
      client.destroy(); await closed;
      release(); await held;
      await request(url).get('/next').timeout({ deadline: 1000 }).expect(200, 'next');
      expect(sideEffect).not.toHaveBeenCalled();
    } finally {
      client.destroy(); release?.(); await held;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
