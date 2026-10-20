import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
const { axiosPost } = vi.hoisted(() => ({ axiosPost: vi.fn() }));

vi.mock("../googleEvidence", () => ({
  getGoogleMailDeliveryStatus: vi.fn(async () => ({ connected: false })),
  sendGoogleMail: vi.fn(async () => { throw new Error("Unexpected Gmail delivery in SendGrid policy test"); }),
  validateGoogleMailDeliveryConnection: vi.fn(),
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send,
  },
}));

vi.mock("axios", () => ({
  default: { post: axiosPost },
}));

describe("outbound notification gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    vi.stubEnv("SENDGRID_API_KEY", "test-sendgrid-key");
    vi.stubEnv("SENDGRID_FROM_EMAIL", "verified-synthetic@example.test");
    vi.stubEnv("EMAIL_PROVIDER", "sendgrid");
    send.mockReset().mockResolvedValue([{}]);
    axiosPost.mockReset().mockResolvedValue({ data: { id: "action-id", date: "2026-10-13T12:00:00.000Z" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([undefined, "false"])(
    "blocks email and Trello comments in production when NOTIFICATIONS_ENABLED is %s",
    async (enabled) => {
      if (enabled === undefined) delete process.env.NOTIFICATIONS_ENABLED;
      else vi.stubEnv("NOTIFICATIONS_ENABLED", enabled);

      const { sendEmail } = await import("./email");
      const { postTrelloComment } = await import("./trello-chatbot");
      const { postCardComment } = await import("./trello-manus");

      await expect(sendEmail({ to: "worker@example.test", subject: "Test", html: "Test" })).resolves.toBe(false);
      await expect(postTrelloComment("0123456789abcdef01234567", "Test comment")).resolves.toBe(false);
      await expect(postCardComment("card-id", "Test comment", "test-key", "test-token")).rejects.toThrow(
        "Outbound Trello comments are disabled",
      );
      expect(send).not.toHaveBeenCalled();
      expect(axiosPost).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("allows outbound notifications only after explicit opt-in", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    const { sendEmail } = await import("./email");
    const { postTrelloComment } = await import("./trello-chatbot");
    const { postCardComment } = await import("./trello-manus");

    await expect(sendEmail({ to: "worker@example.test", subject: "Test", html: "Test" })).resolves.toBe(true);
    await expect(postTrelloComment("0123456789abcdef01234567", "Test comment")).resolves.toBe(true);
    await expect(postCardComment("card-id", "Test comment", "test-key", "test-token")).resolves.toEqual({
      id: "action-id",
      date: "2026-10-13T12:00:00.000Z",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(axiosPost).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
