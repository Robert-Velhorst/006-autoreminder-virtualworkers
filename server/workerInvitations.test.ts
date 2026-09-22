import { describe, expect, it } from "vitest";
import {
  hashWorkerInvitationToken,
  normalizeWorkerInvitationEmail,
  validateWorkerInvitationPassword,
  WORKER_INVITATION_PASSWORD_MIN_LENGTH,
  WorkerInvitationError,
} from "./workerInvitations";

describe("worker invitations", () => {
  it("normalizes worker emails before account creation", () => {
    expect(normalizeWorkerInvitationEmail(" New.Worker@Example.COM ")).toBe("new.worker@example.com");
  });

  it("rejects malformed or overlong login emails", () => {
    expect(() => normalizeWorkerInvitationEmail("not-an-email")).toThrow(WorkerInvitationError);
    expect(() => normalizeWorkerInvitationEmail(`${"a".repeat(55)}@example.com`)).toThrow(/64 characters/);
  });

  it("hashes invitation tokens deterministically without retaining the token", () => {
    const hash = hashWorkerInvitationToken("one-time-secret");
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashWorkerInvitationToken("one-time-secret"));
    expect(hash).not.toContain("one-time-secret");
  });

  it("enforces the invitation password minimum", () => {
    expect(() => validateWorkerInvitationPassword("short")).toThrow(
      `Password must be at least ${WORKER_INVITATION_PASSWORD_MIN_LENGTH} characters.`,
    );
    expect(() => validateWorkerInvitationPassword("long-enough-password")).not.toThrow();
  });
});
