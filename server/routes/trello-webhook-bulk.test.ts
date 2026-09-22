import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { trelloWebhookRegistrationError } from './trello-webhook-bulk';

describe('trelloWebhookRegistrationError', () => {
  it('keeps expected operator actions actionable', () => {
    expect(trelloWebhookRegistrationError(401, 'invalid token')).toBe('Authentication failed — check your Trello credentials');
    expect(trelloWebhookRegistrationError(404, 'model not found')).toBe('Board not found or you do not have permission');
  });

  it('does not return raw provider diagnostics', () => {
    const secret = 'mysql://operator:secret@example.test/dashboard';
    expect(trelloWebhookRegistrationError(500, secret)).toBe('Trello rejected the webhook registration (500)');
  });
});

describe('bulk webhook provider boundary', () => {
  it('bounds registration requests', () => {
    const source = readFileSync(new URL('./trello-webhook-bulk.ts', import.meta.url), 'utf8');
    expect(source).toContain("const TRELLO_REQUEST_TIMEOUT_MS = 15_000");
    expect(source).toContain('signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS)');
  });
});
