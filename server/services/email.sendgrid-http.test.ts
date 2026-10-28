import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ getDb: vi.fn() }));
vi.mock('../googleEvidence', () => ({ getGoogleMailDeliveryStatus: vi.fn(), sendGoogleMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

const request = vi.fn();
const message = { to: 'Worker <worker@example.invalid>', subject: 'Review', html: '<p>Hello</p>', text: 'Hello' };

describe('guarded SendGrid HTTP delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    request.mockReset().mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', request);
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
    vi.stubEnv('EMAIL_PROVIDER', 'sendgrid');
    vi.stubEnv('SENDGRID_API_KEY', 'SG.synthetic-only');
    vi.stubEnv('SENDGRID_FROM_EMAIL', 'Dashboard <sender@example.invalid>');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('posts only the supported fields once to the fixed HTTPS endpoint, preserving address names', async () => {
    const { sendEmailWithOutcome } = await import('./email');
    const extra = { ...message, headers: { Authorization: 'hostile' }, personalizations: [], url: 'https://evil.invalid' };
    expect(await sendEmailWithOutcome(extra)).toEqual({ status: 'sent' });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer SG.synthetic-only', 'Content-Type': 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      personalizations: [{ to: [{ name: 'Worker', email: 'worker@example.invalid' }] }],
      from: { name: 'Dashboard', email: 'sender@example.invalid' }, subject: 'Review',
      content: [{ type: 'text/plain', value: 'Hello' }, { type: 'text/html', value: '<p>Hello</p>' }],
    });
  });

  it.each([200, 204, 301, 400, 401, 403, 413, 429, 500])('keeps HTTP %s uncertain without reading a body or retrying', async status => {
    const cancel = vi.fn(async () => { throw new Error('private provider body'); });
    const json = vi.fn();
    request.mockResolvedValue({ status, body: { cancel }, json });
    const { sendEmailWithOutcome } = await import('./email');
    expect(await sendEmailWithOutcome(message)).toMatchObject({ status: 'uncertain' });
    expect(request).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private provider body');
  });

  it.each(['Worker <worker@example.invalid', 'Worker <worker@example.invalid> extra', 'Worker <<worker@example.invalid>>', 'Worker <worker@example.invalid>>'])(
    'rejects ambiguous address syntax before dispatch: %s', async to => {
      const { sendEmailWithOutcome } = await import('./email');
      expect(await sendEmailWithOutcome({ ...message, to })).not.toEqual({ status: 'sent' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(['TimeoutError', 'AbortError', 'TypeError'])('keeps %s uncertain and hides transport details', async name => {
    request.mockRejectedValue(Object.assign(new Error('private key SG.synthetic-only'), { name }));
    const { sendEmailWithOutcome } = await import('./email');
    expect(await sendEmailWithOutcome(message)).toMatchObject({ status: 'uncertain' });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private key');
  });

  it('does not issue an HTTP request after the final eligibility check denies delivery', async () => {
    const { sendEmailWithOutcome } = await import('./email');
    expect(await sendEmailWithOutcome(message, undefined, async () => false)).toMatchObject({ status: 'not_sent' });
    expect(request).not.toHaveBeenCalled();
  });

  it('sets a bounded timeout before dispatch', async () => {
    const deadline = AbortSignal.abort();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline);
    request.mockRejectedValue(new DOMException('expired', 'TimeoutError'));
    const { sendEmailWithOutcome } = await import('./email');
    expect(await sendEmailWithOutcome(message)).toMatchObject({ status: 'uncertain' });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(request.mock.calls[0][1].signal).toBe(deadline);
  });
});
