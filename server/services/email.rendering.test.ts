import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { convert } from 'html-to-text';
import type { generateMorningBriefingHtml, generateEODReportHtml } from './email';

const providers = vi.hoisted(() => ({ send: vi.fn(), google: vi.fn(), smtp: vi.fn() }));
vi.mock('../db', () => ({ getDb: vi.fn() }));
vi.mock('../googleEvidence', () => ({
  getGoogleMailDeliveryStatus: vi.fn(),
  sendGoogleMail: providers.google,
  validateGoogleMailDeliveryConnection: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: providers.smtp } }));

type Briefing = Parameters<typeof generateMorningBriefingHtml>[0];
type Report = Parameters<typeof generateEODReportHtml>[0];
const attack = `<img src=x onerror="alert(1)"><a href='https://evil.invalid'>A&B</a>`;
const encoded = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;a href=&#39;https://evil.invalid&#39;&gt;A&amp;B&lt;/a&gt;';
const task = { title: 'Task', cardName: 'Card', startTime: '09:00', endTime: '10:00', durationHours: 1, priority: 'normal' };
const briefing = (): Briefing => ({ workerName: 'Worker', date: '2026-10-21', tasks: [{ ...task }], totalHours: 1, highPriorityCount: 0 });
const report = (): Report => ({ workerName: 'Worker', date: '2026-10-21', completedTasks: [{ ...task }], incompleteTasks: [{ ...task }], blockedTasks: [{ ...task }], totalHoursWorked: 3, completionRate: 60 });

// Parse elements and attributes, so escaped text cannot masquerade as safe markup.
function structure(html: string) {
  const elements: Array<{ tagName: string; attribs: Record<string, string> }> = [];
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: { '*': (tagName, attribs) => {
      elements.push({ tagName, attribs: { ...attribs } });
      return { tagName, attribs };
    } },
  });
  return elements;
}

describe('outbound email rendering safety', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
    vi.stubEnv('EMAIL_PROVIDER', 'sendgrid');
    vi.stubEnv('SENDGRID_API_KEY', 'SG.synthetic');
    vi.stubEnv('SENDGRID_FROM_EMAIL', 'sender@example.invalid');
    vi.stubEnv('APP_URL', 'https://dashboard.example.invalid');
    providers.send.mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', providers.send);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(['workerName', 'date', 'totalHours', 'highPriorityCount'] as const)(
    'escapes morning %s even when runtime numeric data is hostile', async field => {
      const { generateMorningBriefingHtml: render } = await import('./email');
      const safe = briefing();
      const html = render({ ...safe, [field]: attack } as Briefing);
      expect(html).toContain(encoded);
      expect(structure(html)).toEqual(structure(render(safe)));
    },
  );

  it.each(['title', 'cardName', 'startTime', 'endTime', 'durationHours', 'priority'] as const)(
    'escapes morning task %s', async field => {
      const { generateMorningBriefingHtml: render } = await import('./email');
      const safe = briefing();
      const html = render({ ...safe, tasks: [{ ...task, [field]: attack } as typeof task] });
      expect(html).toContain(field === 'priority'
        ? '&lt;IMG SRC=X ONERROR=&quot;ALERT(1)&quot;&gt;&lt;A HREF=&#39;HTTPS://EVIL.INVALID&#39;&gt;A&amp;B&lt;/A&gt;'
        : encoded);
      expect(structure(html)).toEqual(structure(render(safe)));
    },
  );

  it.each(['workerName', 'date', 'totalHoursWorked'] as const)('escapes EOD %s', async field => {
    const { generateEODReportHtml: render } = await import('./email');
    const safe = report();
    const html = render({ ...safe, [field]: attack } as Report);
    expect(html).toContain(encoded);
    expect(structure(html)).toEqual(structure(render(safe)));
  });

  it.each(['completedTasks', 'incompleteTasks', 'blockedTasks'] as const)(
    'escapes all rendered fields in EOD %s', async field => {
      const { generateEODReportHtml: render } = await import('./email');
      const safe = report();
      const html = render({ ...safe, [field]: [{ ...task, title: attack, durationHours: attack as unknown as number }] });
      expect(html.split(encoded)).toHaveLength(3);
      expect(structure(html)).toEqual(structure(render(safe)));
    },
  );

  it.each([
    [-10, 0], [150, 100], [NaN, 0], [Infinity, 0], [-Infinity, 0],
    [attack, 0], ['80', 0], [null, 0], [undefined, 0], [75.5, 75.5],
    ['0%;background:url(https://evil.invalid)', 0],
  ])('bounds runtime completion rate %s to %s', async (value, expected) => {
    const { generateEODReportHtml: render } = await import('./email');
    const html = render({ ...report(), completionRate: value as number });
    expect(html).toContain(`width: ${expected}%;`);
    expect(html).toContain(`>${expected}%</span>`);
    expect(html).not.toContain('evil.invalid');
    expect(structure(html)).toEqual(structure(render({ ...report(), completionRate: expected as number })));
  });

  it('preserves safe table markup, priority styles, times and the existing default link', async () => {
    vi.stubEnv('APP_URL', '');
    const { generateMorningBriefingHtml: render } = await import('./email');
    const html = render({ ...briefing(), tasks: [{ ...task, priority: 'critical' }] });
    expect(html).toContain('<strong>Task</strong>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('09:00 - 10:00');
    expect(html).toContain('background: #fee2e2;');
    expect(html).toContain('href="https://vadashboard.app/worker"');
  });

  it.each(['http', 'https'])('escapes dashboard %s URL attributes', async protocol => {
    const base = `${protocol}://dashboard.example.invalid/?a=1&b='quote'`;
    vi.stubEnv('APP_URL', base);
    const { generateMorningBriefingHtml: render } = await import('./email');
    const html = render(briefing());
    expect(html).toContain('&amp;b=');
    const links = structure(html).filter(element => element.tagName === 'a');
    expect(links).toHaveLength(1);
    expect(links[0].attribs.href).toBe(new URL(`${base}/worker`).href);
    expect(Object.keys(links[0].attribs).sort()).toEqual(['href', 'style']);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/relative', 'not a url', 'https://user:password@example.invalid'])(
    'rejects unsafe dashboard and invitation URL %s before sending', async url => {
      vi.stubEnv('APP_URL', url);
      const { sendMorningBriefing, sendWorkerInvitationEmail } = await import('./email');
      await expect(sendMorningBriefing('worker@example.invalid', briefing())).rejects.toThrow();
      await expect(sendWorkerInvitationEmail({ email: 'worker@example.invalid', workerName: 'Worker', inviteUrl: url, expiresAt: new Date('2026-10-22Z') })).rejects.toThrow();
      expect(providers.send).not.toHaveBeenCalled();
      expect(providers.google).not.toHaveBeenCalled();
      expect(providers.smtp).not.toHaveBeenCalled();
    },
  );

  it('escapes invitation names and URL attributes at the mocked provider boundary', async () => {
    const { sendWorkerInvitationEmail } = await import('./email');
    const inviteUrl = `https://dashboard.example.invalid/invite?token=one&next='><img src=x>`;
    await expect(sendWorkerInvitationEmail({ email: 'worker@example.invalid', workerName: attack, inviteUrl, expiresAt: new Date('2026-10-22Z') })).resolves.toBe(true);
    expect(providers.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(providers.send.mock.calls[0][1].body);
    const message = { html: payload.content[1].value, text: payload.content[0].value };
    expect(message.html).toContain(encoded);
    expect(message.html).toContain('&amp;next=');
    const links = structure(message.html).filter(element => element.tagName === 'a');
    expect(links).toHaveLength(1);
    expect(links[0].attribs.href).toBe(new URL(inviteUrl).href);
    expect(structure(message.html).some(element => element.tagName === 'img')).toBe(false);
    expect(message.text).toContain(attack);
  });

  it.each(['morning', 'EOD'] as const)('sends escaped %s HTML and literal plaintext only after final authorization', async kind => {
    const email = await import('./email');
    const hostileTask = { title: attack, cardName: attack, startTime: attack, endTime: attack,
      durationHours: attack as unknown as number, priority: attack };
    const send = (authorize: () => Promise<boolean>) => kind === 'morning'
      ? email.sendMorningBriefing('worker@example.invalid', { ...briefing(), workerName: attack, date: attack,
        totalHours: attack as unknown as number, highPriorityCount: attack as unknown as number,
        tasks: [hostileTask] }, undefined, authorize)
      : email.sendEODReport('worker@example.invalid', { ...report(), workerName: attack, date: attack,
        totalHoursWorked: attack as unknown as number, completionRate: attack as unknown as number,
        completedTasks: [hostileTask], incompleteTasks: [hostileTask], blockedTasks: [hostileTask] }, undefined, authorize);
    const denied = vi.fn(async () => false);
    await expect(send(denied)).resolves.toBe(false);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(providers.send).not.toHaveBeenCalled();
    const authorized = vi.fn(async () => true);
    await expect(send(authorized)).resolves.toBe(true);
    expect(authorized).toHaveBeenCalledTimes(1);
    expect(providers.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(providers.send.mock.calls[0][1].body);
    const message = { html: payload.content[1].value, text: payload.content[0].value };
    expect(message.html).toContain(`<strong>${encoded}</strong>`);
    expect(structure(message.html)).toEqual(structure(kind === 'morning'
      ? email.generateMorningBriefingHtml(briefing())
      : email.generateEODReportHtml({ ...report(), completionRate: 0 })));
    expect(structure(message.html).some(element => element.tagName === 'img')).toBe(false);
    expect(message.text).toContain(attack);
    expect(convert(message.html, { wordwrap: false })).toContain(attack);
    expect(providers.google).not.toHaveBeenCalled();
    expect(providers.smtp).not.toHaveBeenCalled();
  });
});
