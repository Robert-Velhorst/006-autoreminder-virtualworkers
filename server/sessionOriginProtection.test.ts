import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireTrustedSessionOrigin } from './middleware/sessionOriginProtection';

function appWithSessionUser() {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, openId: 'owner', role: 'admin' };
    next();
  });
  app.use(requireTrustedSessionOrigin);
  app.post('/api/mutate', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('requireTrustedSessionOrigin', () => {
  it('allows a session mutation from the current dashboard origin', async () => {
    await request(appWithSessionUser())
      .post('/api/mutate')
      .set('Host', 'dashboard.example.test')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://dashboard.example.test')
      .set('Cookie', 'app_session_id=session')
      .expect(200, { ok: true });
  });

  it('rejects a cross-site mutation carrying a dashboard session cookie', async () => {
    const response = await request(appWithSessionUser())
      .post('/api/mutate')
      .set('Host', 'dashboard.example.test')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://attacker.example')
      .set('Cookie', 'app_session_id=session')
      .expect(403);

    expect(response.body).toEqual({ error: 'Cross-site browser mutation rejected' });
  });

  it('does not block bearer-token integrations without a session cookie', async () => {
    await request(appWithSessionUser())
      .post('/api/mutate')
      .set('Origin', 'chrome-extension://collector')
      .set('Authorization', 'Bearer collector-token')
      .expect(200, { ok: true });
  });
});
