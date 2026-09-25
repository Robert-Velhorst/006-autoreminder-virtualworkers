import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyGoogleEmail,
  candidateGmailDeadline,
  decryptGoogleRefreshToken,
  defaultGoogleEvidenceSettings,
  developmentGoogleRefreshTokenFallback,
  evidenceRevisionChanged,
  encryptGoogleRefreshToken,
  extractExplicitDeadline,
  findExactCardMatch,
  googleDriveEvidenceRevision,
  googleDriveRevisionDisposition,
  googleGmailEvidenceRevision,
  gmailEvidenceOwnerMatches,
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
      lastGmailError: "  Gmail unavailable  ",
      lastDriveError: "ignored?",
    })).toEqual({
      ...defaultGoogleEvidenceSettings(),
      gmail: { enabled: true, intervalMinutes: 15, lookbackDays: 90 },
      drive: { enabled: true, intervalMinutes: 1_440, lookbackDays: 30, folderId: "folder-123" },
      lastGmailError: "Gmail unavailable",
      lastDriveError: "ignored?",
    });
  });

  it("reads older settings without provider-specific sync errors", () => {
    expect(normalizeGoogleEvidenceSettings({ lastError: "Legacy combined error" })).toMatchObject({
      lastGmailError: null,
      lastDriveError: null,
      lastError: "Legacy combined error",
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
  it("queues only meaningful retained-source revisions, not repeated Drive observations", () => {
    const file = {
      id: "drive-file-1",
      name: "Case correspondence",
      mimeType: "application/pdf",
      modifiedAt: new Date("2026-09-25T10:00:00.000Z"),
      sourceUrl: "https://drive.google.com/file/d/drive-file-1/view",
      description: "Current correspondence",
      parents: ["folder-b", "folder-a"],
      size: "1024",
    };
    const first = googleDriveEvidenceRevision(file);
    const repeatedPoll = googleDriveEvidenceRevision({ ...file, parents: ["folder-a", "folder-b"] });
    const updated = googleDriveEvidenceRevision({ ...file, description: "Updated correspondence" });

    expect(repeatedPoll).toBe(first);
    expect(evidenceRevisionChanged(null, first)).toBe(true);
    expect(evidenceRevisionChanged(first, repeatedPoll)).toBe(false);
    expect(evidenceRevisionChanged(first, first, false)).toBe(true);
    expect(evidenceRevisionChanged(first, updated)).toBe(true);
  });

  it("accepts only a strictly newer Drive version when retained content changes", () => {
    const older = new Date("2026-09-25T10:00:00.000Z");
    const newer = new Date("2026-09-25T10:01:00.000Z");
    const retained = { modifiedAt: newer, contentHash: "new-content" };
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: older, contentHash: "old-content" })).toBe("stale");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: newer, contentHash: "different-content" })).toBe("ambiguous");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: null, contentHash: "unversioned-content" })).toBe("ambiguous");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: newer, contentHash: "new-content" })).toBe("accept");
    expect(googleDriveRevisionDisposition(retained, { modifiedAt: new Date(newer.getTime() + 1), contentHash: "latest-content" })).toBe("accept");
    expect(googleDriveRevisionDisposition({ modifiedAt: newer, contentHash: null }, { modifiedAt: older, contentHash: "old-content" })).toBe("stale");
    expect(googleDriveRevisionDisposition({ modifiedAt: null, contentHash: "legacy-content" }, { modifiedAt: newer, contentHash: "versioned-content" })).toBe("accept");
  });

  it("gives Gmail evidence a stable revision key that changes with its retained content", () => {
    const message = {
      gmailMessageId: "message-1",
      gmailThreadId: "thread-1",
      subject: "Case update",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      snippet: "A request was received",
      receivedAt: new Date("2026-09-25T10:00:00.000Z"),
      category: "non_financial",
      deadlineAt: null,
      trelloCardId: "card-1",
      trelloCardName: "Review case",
      trelloCardUrl: "https://trello.com/c/card-1",
      suggestedNextAction: "Review the message",
      llmSummary: null,
    };
    expect(googleGmailEvidenceRevision(message)).toBe(googleGmailEvidenceRevision({ ...message }));
    expect(googleGmailEvidenceRevision({ ...message, snippet: "A changed request was received" }))
      .not.toBe(googleGmailEvidenceRevision(message));
  });

  it("does not let a globally unique Gmail message overwrite another worker's record", () => {
    expect(gmailEvidenceOwnerMatches(null, 12)).toBe(true);
    expect(gmailEvidenceOwnerMatches(12, 12)).toBe(true);
    expect(gmailEvidenceOwnerMatches(13, 12)).toBe(false);
  });

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
