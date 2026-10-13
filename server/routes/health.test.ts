import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDb, isRedisAvailable } = vi.hoisted(() => ({
  getDb: vi.fn(),
  isRedisAvailable: vi.fn(),
}));

vi.mock('../db', () => ({ getDb }));
vi.mock('../services/redis', () => ({ isRedisAvailable }));

import healthRoutes from './health';

describe('health route', () => {
  const app = express().use('/api/health', healthRoutes);

  beforeEach(() => {
    getDb.mockResolvedValue({});
    isRedisAvailable.mockReturnValue(false);
    vi.stubEnv('REDIS_URL', '');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('allows health checks when Redis is not configured', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'healthy', database: 'connected', redis: 'not configured' });
  });

  it('fails health checks when configured Redis is unavailable', async () => {
    vi.stubEnv('REDIS_URL', 'redis://redis:6379');

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'unhealthy', database: 'connected', redis: 'disconnected' });
  });

  it('passes health checks when configured Redis is available', async () => {
    vi.stubEnv('REDIS_URL', 'redis://redis:6379');
    isRedisAvailable.mockReturnValue(true);

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'healthy', database: 'connected', redis: 'connected' });
  });

  it('does not expose database connection errors from the public health check', async () => {
    getDb.mockRejectedValue(new Error('connect ETIMEDOUT mysql.internal:3306 with credential details'));

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'unhealthy', error: 'Health check failed' });
    expect(JSON.stringify(response.body)).not.toContain('mysql.internal');
    expect(JSON.stringify(response.body)).not.toContain('credential details');
  });

  it('does not expose database connection errors from the readiness check', async () => {
    getDb.mockRejectedValue(new Error('connect ETIMEDOUT mysql.internal:3306 with credential details'));

    const response = await request(app).get('/api/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ready: false, reason: 'Database not available' });
    expect(JSON.stringify(response.body)).not.toContain('mysql.internal');
    expect(JSON.stringify(response.body)).not.toContain('credential details');
  });
});
