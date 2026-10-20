import { afterEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  getGoogleMailDeliveryStatus: vi.fn(),
  sendGoogleMail: vi.fn(),
  sendgridSend: vi.fn(),
}));

vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: vi.fn(), send: controls.sendgridSend },
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn() },
}));
vi.mock("../googleEvidence", () => ({
  getGoogleMailDeliveryStatus: controls.getGoogleMailDeliveryStatus,
  sendGoogleMail: controls.sendGoogleMail,
  validateGoogleMailDeliveryConnection: vi.fn(),
}));

describe("email delivery outcome", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("reports a rejected provider-status lookup as not sent without calling a provider", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("SENDGRID_API_KEY", "");
    vi.stubEnv("SENDGRID_FROM_EMAIL", "");
    vi.stubEnv("GMAIL_SMTP_USER", "");
    vi.stubEnv("GMAIL_SMTP_APP_PASSWORD", "");
    controls.getGoogleMailDeliveryStatus.mockRejectedValue(new Error("mock status failure"));

    const { sendEmailWithOutcome } = await import("./email");
    const outcome = await sendEmailWithOutcome({
      to: "worker@example.test",
      subject: "Reminder",
      text: "Review the appointment.",
      html: "<p>Review the appointment.</p>",
    });

    expect(outcome).toMatchObject({ status: "not_sent" });
    expect(outcome.status === "not_sent" && outcome.reason).toContain("no email was sent");
    expect(controls.sendGoogleMail).not.toHaveBeenCalled();
    expect(controls.sendgridSend).not.toHaveBeenCalled();
  });

  it("keeps provider-call failures uncertain after readiness succeeds", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_PROVIDER", "gmail_api");
    controls.getGoogleMailDeliveryStatus.mockResolvedValue({ connected: true });
    controls.sendGoogleMail.mockRejectedValue(new Error("mock provider failure"));

    const { sendEmailWithOutcome } = await import("./email");
    const outcome = await sendEmailWithOutcome({
      to: "worker@example.test",
      subject: "Reminder",
      text: "Review the appointment.",
      html: "<p>Review the appointment.</p>",
    });

    expect(outcome).toMatchObject({ status: "uncertain" });
  });

  it("creates plain text using parsed HTML without script/style content or broken quoted attributes", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_PROVIDER", "gmail_api");
    controls.getGoogleMailDeliveryStatus.mockResolvedValue({ connected: true });
    controls.sendGoogleMail.mockResolvedValue(undefined);

    const { sendEmailWithOutcome } = await import("./email");
    const outcome = await sendEmailWithOutcome({
      to: "worker@example.test",
      subject: "Reminder",
      html: '<p title="1 > 0">Alice &amp; Bob</p><script>privateScript()</script><style>.secret{display:none}</style><p><a href="https://example.test">Review</a><br>Next line</p>',
    });

    expect(outcome).toEqual({ status: "sent" });
    expect(controls.sendGoogleMail).toHaveBeenCalledOnce();
    const message = controls.sendGoogleMail.mock.calls[0][0];
    expect(message.text).toContain("Alice & Bob");
    expect(message.text).toContain("Review\nNext line");
    expect(message.text).not.toMatch(/privateScript|\.secret|1 > 0|https:\/\/example/);
  });
});
