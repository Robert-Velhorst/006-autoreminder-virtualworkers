import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import healthRoutes from './routes/health';

describe('readiness alias', () => {
  it('mounts the health probe instead of falling through to a frontend handler', async () => {
    const app = express();
    app.use('/readyz', healthRoutes);
    app.use((_req, res) => res.type('html').send('<html>frontend</html>'));

    const response = await request(app).get('/readyz');

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.text).not.toContain('frontend');
    expect([200, 503]).toContain(response.status);
  });
});
