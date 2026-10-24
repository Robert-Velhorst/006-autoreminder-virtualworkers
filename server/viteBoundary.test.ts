import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { setupVite } from './_core/vite';

const fixture = vi.hoisted(() => ({
  create: vi.fn(), transform: vi.fn(async (_url: string, template: string) => template),
}));
vi.mock('vite', () => ({ createServer: fixture.create }));
vi.mock('../vite.config', () => ({ default: {} }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fixture.create.mockReset(); fixture.transform.mockClear(); });

describe('development Vite boundary', () => {
  it('does not spend the template budget on the Vite module graph', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fixture.create.mockResolvedValue({
      middlewares: (req: express.Request, res: express.Response, next: () => void) => {
        if (req.path.startsWith('/src/')) res.type('application/javascript').send('export default 1');
        else next();
      },
      transformIndexHtml: fixture.transform, ssrFixStacktrace: vi.fn(),
    });
    const read = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('<html>Login</html>');
    const app = express();
    await setupVite(app, createServer(app));
    for (let index = 0; index < 650; index++) await request(app).get(`/src/module-${index}.ts`).expect(200);
    await request(app).get('/worker').expect(200).expect(/Login/);
    expect(read).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('rejects production before loading the development server or template', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const read = vi.spyOn(fs.promises, 'readFile');
    const app = express();
    await expect(setupVite(app, createServer(app))).rejects.toThrow('forbidden in production');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('throttles before template file access and keeps normal development requests working', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fixture.create.mockResolvedValue({
      middlewares: (_req: unknown, _res: unknown, next: () => void) => next(),
      transformIndexHtml: fixture.transform, ssrFixStacktrace: vi.fn(),
    });
    const read = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('<html><script src="/src/main.tsx"></script></html>');
    const app = express();
    await setupVite(app, createServer(app));
    await request(app).get('/worker').expect(200).expect(/main\.tsx\?v=/);
    for (let index = 1; index < 600; index++) await request(app).get('/worker').expect(200);
    await request(app).get('/worker').expect(429);
    expect(read).toHaveBeenCalledTimes(600);
    expect(fixture.transform).toHaveBeenCalledTimes(600);
  }, 30_000);
});
