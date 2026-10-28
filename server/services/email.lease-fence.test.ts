import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from "../scheduledJobRuntime";

const controls = vi.hoisted(() => ({
  status: vi.fn(), googleSend: vi.fn(), sendgridSend: vi.fn(),
  createTransport: vi.fn(), smtpSend: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../scheduledJobRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("../scheduledJobRuntime")>();
  return { ScheduledJobLeaseLostError: actual.ScheduledJobLeaseLostError };
});
vi.mock("../googleEvidence", () => ({
  getGoogleMailDeliveryStatus: controls.status,
  sendGoogleMail: controls.googleSend,
  validateGoogleMailDeliveryConnection: vi.fn(),
}));
vi.mock("nodemailer", () => ({ default: { createTransport: controls.createTransport } }));

const options = { to: "worker@example.invalid", subject: "Briefing", html: "<p>Work</p>" };

function lease() {
  const controller = new AbortController();
  const error = new ScheduledJobLeaseLostError();
  let owned = true;
  const context: ScheduledJobContext = {
    signal: controller.signal,
    assertOwnership: vi.fn(async () => { if (!owned) throw error; }),
  };
  return { context, error, controller, lose: () => { owned = false; } };
}

describe("email scheduled-job lease fencing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_PROVIDER", "gmail_api");
    vi.stubEnv("GMAIL_SMTP_USER", "sender@example.invalid");
    vi.stubEnv("GMAIL_SMTP_APP_PASSWORD", "synthetic-password");
    vi.stubEnv("GMAIL_SMTP_PORT", "465");
    vi.stubEnv("SENDGRID_API_KEY", "SG.synthetic");
    vi.stubEnv("SENDGRID_FROM_EMAIL", "sender@example.invalid");
    controls.status.mockResolvedValue({ connected: true });
    controls.googleSend.mockResolvedValue(undefined);
    controls.sendgridSend.mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', controls.sendgridSend);
    controls.smtpSend.mockResolvedValue(undefined);
    controls.createTransport.mockReturnValue({ sendMail: controls.smtpSend });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function expectNoSend() {
    expect(controls.googleSend).not.toHaveBeenCalled();
    expect(controls.sendgridSend).not.toHaveBeenCalled();
    expect(controls.smtpSend).not.toHaveBeenCalled();
  }

  it("stops before readiness when ownership has already expired", async () => {
    const { sendEmail } = await import("./email");
    const state = lease();
    state.lose();
    await expect(sendEmail(options, state.context)).rejects.toBe(state.error);
    expect(controls.status).not.toHaveBeenCalled();
    expectNoSend();
  });

  it.each(["expired", "aborted"])("stops if ownership is %s while async readiness is pending", async loss => {
    const { sendEmailWithOutcome } = await import("./email");
    const state = lease();
    let ready!: (value: { connected: boolean }) => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    controls.status.mockImplementation(() => {
      entered();
      return new Promise(resolve => { ready = resolve; });
    });
    const sending = sendEmailWithOutcome(options, state.context);
    await pending;
    if (loss === "aborted") state.controller.abort();
    else state.lose();
    ready({ connected: true });
    await expect(sending).rejects.toMatchObject({ name: "ScheduledJobLeaseLostError" });
    expectNoSend();
  });

  it("stops at the final SMTP boundary after transport preparation loses ownership", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "gmail_smtp");
    const { sendEmail } = await import("./email");
    const state = lease();
    controls.createTransport.mockImplementation(() => {
      state.lose();
      return { sendMail: controls.smtpSend };
    });
    await expect(sendEmail(options, state.context)).rejects.toBe(state.error);
    expect(controls.createTransport).toHaveBeenCalledTimes(1);
    expectNoSend();
  });

  it.each(["gmail_api", "gmail_smtp", "sendgrid"])("stops %s after message preparation loses ownership", async provider => {
    vi.stubEnv("EMAIL_PROVIDER", provider);
    const { sendEmail } = await import("./email");
    const state = lease();
    const preparedOptions = { ...options, get text() { state.lose(); return "Work"; } };
    await expect(sendEmail(preparedOptions, state.context)).rejects.toBe(state.error);
    expectNoSend();
  });

  it("checks abort again after an asynchronous ownership assertion", async () => {
    const { sendEmail } = await import("./email");
    const state = lease();
    vi.mocked(state.context.assertOwnership).mockImplementation(async () => { state.controller.abort(); });
    await expect(sendEmail(options, state.context)).rejects.toMatchObject({ name: "ScheduledJobLeaseLostError" });
    expectNoSend();
  });

  it.each(["readiness", "provider"])("propagates lease errors from %s without converting to a delivery outcome", async stage => {
    const { sendEmailWithOutcome } = await import("./email");
    const state = lease();
    (stage === "readiness" ? controls.status : controls.googleSend).mockRejectedValue(state.error);
    await expect(sendEmailWithOutcome(options, state.context)).rejects.toBe(state.error);
  });

  it.each(["morning", "eod"])("passes the %s briefing context through to Gmail", async kind => {
    const { sendMorningBriefing, sendEODReport } = await import("./email");
    const state = lease();
    const data = { workerName: "Synthetic worker", date: "2026-10-01" };
    const delivered = kind === "morning"
      ? await sendMorningBriefing(options.to, { ...data, tasks: [], totalHours: 0, highPriorityCount: 0 }, state.context)
      : await sendEODReport(options.to, { ...data, completedTasks: [], incompleteTasks: [], blockedTasks: [], totalHoursWorked: 0, completionRate: 0 }, state.context);
    expect(delivered).toBe(true);
    expect(controls.googleSend).toHaveBeenCalledWith(expect.objectContaining({ to: options.to }), state.context);
  });

  it.each(["morning", "eod"])("does not hide ownership loss in the %s briefing helper", async kind => {
    const { sendMorningBriefing, sendEODReport } = await import("./email");
    const state = lease();
    controls.status.mockImplementation(async () => { state.lose(); return { connected: true }; });
    const data = { workerName: "Synthetic worker", date: "2026-10-01" };
    const sending = kind === "morning"
      ? sendMorningBriefing(options.to, { ...data, tasks: [], totalHours: 0, highPriorityCount: 0 }, state.context)
      : sendEODReport(options.to, { ...data, completedTasks: [], incompleteTasks: [], blockedTasks: [], totalHoursWorked: 0, completionRate: 0 }, state.context);
    await expect(sending).rejects.toBe(state.error);
    expectNoSend();
  });

  it.each(["gmail_smtp", "sendgrid"])("asserts ownership immediately before the final %s call", async provider => {
    vi.stubEnv("EMAIL_PROVIDER", provider);
    const { sendEmail } = await import("./email");
    const state = lease();
    const order: string[] = [];
    vi.mocked(state.context.assertOwnership).mockImplementation(async () => { order.push("ownership"); });
    const send = provider === "gmail_smtp" ? controls.smtpSend : controls.sendgridSend;
    send.mockImplementation(async () => { order.push("send"); return new Response(null, { status: 202 }); });
    expect(await sendEmail(options, state.context)).toBe(true);
    expect(order.slice(-2)).toEqual(["ownership", "send"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["gmail_api", "gmail_smtp", "sendgrid"])("keeps manual %s sends working without a context", async provider => {
    vi.stubEnv("EMAIL_PROVIDER", provider);
    const { sendEmail } = await import("./email");
    expect(await sendEmail(options)).toBe(true);
    const send = provider === "gmail_api" ? controls.googleSend : provider === "gmail_smtp" ? controls.smtpSend : controls.sendgridSend;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toHaveLength(provider === 'sendgrid' ? 2 : 1);
  });

  it("keeps disabled delivery disabled with a live context", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    const { sendEmail } = await import("./email");
    expect(await sendEmail(options, lease().context)).toBe(false);
    expect(controls.status).not.toHaveBeenCalled();
    expectNoSend();
  });

  it("keeps an unready provider from sending", async () => {
    controls.status.mockResolvedValue({ connected: false });
    const { sendEmail } = await import("./email");
    expect(await sendEmail(options, lease().context)).toBe(false);
    expectNoSend();
  });
  it.each(['sendgrid', 'gmail_smtp'])("refuses %s after eligibility is revoked during paused provider readiness", async provider => {
    vi.stubEnv('EMAIL_PROVIDER', '');
    if (provider === 'gmail_smtp') { vi.stubEnv('SENDGRID_API_KEY', ''); vi.stubEnv('SENDGRID_FROM_EMAIL', ''); }
    let release!: (value: { connected: boolean }) => void;
    controls.status.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { sendEmailWithOutcome } = await import('./email');
    let eligible = true;
    const guard = vi.fn(async () => eligible);
    const pending = sendEmailWithOutcome(options, undefined, guard);
    await vi.waitFor(() => expect(controls.status).toHaveBeenCalledOnce());
    expect(guard).not.toHaveBeenCalled(); eligible = false; release({ connected: false });
    expect(await pending).toMatchObject({ status: 'not_sent' });
    expect(guard).toHaveBeenCalledOnce(); expectNoSend();
  });
  it.each(['sendgrid', 'gmail_smtp'])("maps %s final guard storage failure to definitely not_sent", async provider => {
    vi.stubEnv('EMAIL_PROVIDER', provider);
    const { sendEmailWithOutcome } = await import('./email');
    const guard = vi.fn(async (): Promise<boolean> => { throw new Error('Guard read failed'); });
    expect(await sendEmailWithOutcome(options, undefined, guard)).toMatchObject({ status: 'not_sent' });
    expectNoSend();
  });
  it.each(['sendgrid', 'gmail_smtp'])("keeps %s post-dispatch failures uncertain and never rereads the guard", async provider => {
    vi.stubEnv('EMAIL_PROVIDER', provider);
    const { sendEmailWithOutcome } = await import('./email');
    const { EmailDispatchNotStartedError } = await import('./email-dispatch-guard');
    const guard = vi.fn(async () => true);
    const send = provider === 'sendgrid' ? controls.sendgridSend : controls.smtpSend;
    send.mockImplementation(async () => { guard.mockResolvedValue(false); throw new EmailDispatchNotStartedError(); });
    expect(await sendEmailWithOutcome(options, undefined, guard)).toMatchObject({ status: 'uncertain' });
    expect(send).toHaveBeenCalledOnce(); expect(guard).toHaveBeenCalledOnce();
  });
  it('honors a dynamic global opt-out at the final SMTP boundary', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'gmail_smtp');
    const { sendEmailWithOutcome } = await import('./email');
    controls.createTransport.mockImplementation(() => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'false'); return { sendMail: controls.smtpSend };
    });
    expect(await sendEmailWithOutcome(options)).toMatchObject({ status: 'not_sent' }); expectNoSend();
  });
  it('propagates lease loss from the final callback without contacting the provider', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'sendgrid');
    const { sendEmailWithOutcome } = await import('./email');
    const state = lease();
    await expect(sendEmailWithOutcome(options, state.context, async () => { throw state.error; })).rejects.toBe(state.error);
    expectNoSend();
  });
  it.each(['morning', 'eod'])("propagates the %s briefing final callback through the boolean wrappers", async kind => {
    vi.stubEnv('EMAIL_PROVIDER', 'sendgrid');
    const { sendMorningBriefing, sendEODReport } = await import('./email');
    const state = lease(); const guard = vi.fn(async () => false);
    const common = { workerName: 'Synthetic', date: '2026-10-21' };
    const outcome = kind === 'morning'
      ? await sendMorningBriefing(options.to, { ...common, tasks: [], totalHours: 0, highPriorityCount: 0 }, state.context, guard)
      : await sendEODReport(options.to, { ...common, completedTasks: [], incompleteTasks: [], blockedTasks: [], totalHoursWorked: 0, completionRate: 0 }, state.context, guard);
    expect(outcome).toBe(false); expect(guard).toHaveBeenCalledOnce(); expectNoSend();
  });
  it('forwards the optional Gmail guard without changing legacy call arity', async () => {
    const { sendEmailWithOutcome } = await import('./email');
    const state = lease(); const guard = vi.fn(async () => true);
    await sendEmailWithOutcome(options, state.context, guard);
    expect(controls.googleSend).toHaveBeenCalledWith(expect.objectContaining({ to: options.to }), state.context, guard);
    controls.googleSend.mockClear();
    await sendEmailWithOutcome(options);
    expect(controls.googleSend.mock.calls[0]).toHaveLength(1);
  });
});
