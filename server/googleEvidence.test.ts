import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyGoogleEmail,
  candidateGmailDeadline,
  decryptGoogleRefreshToken,
  defaultGoogleEvidenceSettings,
  developmentGoogleRefreshTokenFallback,
  encryptGoogleRefreshToken,
  extractExplicitDeadline,
  findExactCardMatch,
  googleEvidenceSetupMessage,
  normalizeGoogleEvidenceSettings,
} from "./googleEvidence";
import { gmailContentScope } from "../shared/gmailContentScope";

const previousJwtSecret = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.JWT_SECRET = "test-google-evidence-secret-that-is-long-enough";
});

afterEach(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

describe("Google evidence settings", () => {
  it("uses bounded safe defaults when a saved setting is malformed", () => {
    expect(normalizeGoogleEvidenceSettings({
      gmail: { intervalMinutes: 1, lookbackDays: 999 },
      drive: { intervalMinutes: 10_000, folderId: "  folder-123  " },
    })).toEqual({
      ...defaultGoogleEvidenceSettings(),
      gmail: { enabled: true, intervalMinutes: 15, lookbackDays: 90 },
      drive: { enabled: true, intervalMinutes: 1_440, lookbackDays: 30, folderId: "folder-123" },
    });
  });

  it("distinguishes missing server credentials from a missing worker connection", () => {
    expect(googleEvidenceSetupMessage({})).toContain("GOOGLE_CLIENT_ID");
    expect(googleEvidenceSetupMessage({ clientId: "client", clientSecret: "secret" }))
      .toBe("Connect Google for this worker to authorize read-only Gmail and Drive evidence.");
    expect(googleEvidenceSetupMessage({ clientId: "client", clientSecret: "secret", refreshToken: "token" }))
      .toBeNull();
  });

  it("does not let a global refresh token cross worker boundaries in production", () => {
    expect(developmentGoogleRefreshTokenFallback({ NODE_ENV: "production", GOOGLE_REFRESH_TOKEN: "shared-token" })).toBeNull();
    expect(developmentGoogleRefreshTokenFallback({ NODE_ENV: "development", GOOGLE_REFRESH_TOKEN: "shared-token" })).toBe("shared-token");
  });
});

describe("Google evidence classification", () => {
  it("encrypts worker refresh tokens with authenticated encryption", () => {
    const encrypted = encryptGoogleRefreshToken("refresh-token-value");
    expect(encrypted).not.toContain("refresh-token-value");
    expect(decryptGoogleRefreshToken(encrypted)).toBe("refresh-token-value");
    expect(() => decryptGoogleRefreshToken(`${encrypted}x`)).toThrow();
  });

  it("classifies financial records without an LLM call", () => {
    expect(classifyGoogleEmail("Invoice INV-42", "Your payment receipt is attached")).toMatchObject({
      category: "financial",
    });
  });

  it("selects the exact related card rather than a loose keyword match", () => {
    const cards = [
      { cardId: "abc123", cardName: "Prepare client proposal", cardUrl: "", boardName: "", listName: "" },
      { cardId: "def456", cardName: "Send weekly report", cardUrl: "", boardName: "", listName: "" },
    ];
    expect(findExactCardMatch("Please review abc123 today", cards)).toMatchObject({
      score: 100,
      card: { cardId: "abc123" },
    });
    expect(findExactCardMatch("The proposal is ready", cards)).toBeNull();
    expect(findExactCardMatch("Prepare client proposal is ready", cards)).toMatchObject({
      score: 85,
      card: { cardId: "abc123" },
    });
  });

  it("extracts only explicit, unambiguous deadlines in the worker timezone", () => {
    expect(extractExplicitDeadline("Please respond by 2026-08-15 at 14:30", "Europe/Amsterdam")?.dueAt.toISOString())
      .toBe("2026-08-15T12:30:00.000Z");
    expect(extractExplicitDeadline("Uiterlijk 15/08/2026 aanleveren", "Europe/Amsterdam")).toMatchObject({
      dateOnly: true,
    });
    expect(extractExplicitDeadline("We should finish sometime next month", "Europe/Amsterdam")).toBeNull();
    expect(extractExplicitDeadline("Due 08/09/2026", "Europe/Amsterdam")).toBeNull();
  });

  it("treats a portal notification as a pointer to unread correspondence, not its deadline", () => {
    const subject = "Er staat een bericht voor u klaar in klacht 202600250";
    const snippet = "Er staat een bericht voor u klaar in uw persoonlijke mijn-omgeving. U vindt het onder correspondentie. Inloggen Uiterlijk 15/08/2026.";
    expect(gmailContentScope(subject, snippet)).toBe("portal_notice");
    expect(classifyGoogleEmail(subject, snippet)).toMatchObject({
      scope: "portal_notice",
      suggestedNextAction: expect.stringContaining("linked portal correspondence"),
    });
    expect(candidateGmailDeadline(subject, snippet, "Europe/Amsterdam")).toBeNull();
    expect(candidateGmailDeadline("Please respond by 2026-08-15 at 14:30", "Direct email body preview", "Europe/Amsterdam")?.dueAt.toISOString())
      .toBe("2026-08-15T12:30:00.000Z");
  });
});
