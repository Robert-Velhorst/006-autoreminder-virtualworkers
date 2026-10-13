import { describe, expect, it } from "vitest";
import { managerReviewNotice } from "../shared/aptlssManagerReviewNotice";
import type { ManagerSnapshot } from "../shared/aptlssManager";

type Review = NonNullable<ManagerSnapshot["semanticReview"]>;
const failed = (outcome?: NonNullable<Review["attempts"]>[number]["outcome"]): Review => ({
  success: false, provider: "codex-subscription", sourceHash: "hash", failures: 1,
  attemptedAt: "2026-09-13T20:56:23Z", retryAfter: "2026-09-13T20:58:55Z",
  attempts: outcome ? [{ effort: "low", outcome, durationMs: 1 }] : undefined,
});

describe("manager review failure diagnosis", () => {
  it("does not blame the account or connection for a rejected response", () => {
    const notice = managerReviewNotice(failed("rejected"))!;
    expect(notice.title).toBe("AI answer not accepted");
    expect(notice.message).toContain("safety or output checks");
    expect(notice.message).not.toMatch(/check.*(?:connection|allowance)|sign in|billing/i);
  });
  it.each([
    ["limited", "AI allowance reached"],
    ["unauthenticated", "AI sign-in required"],
    ["unavailable", "AI connection unavailable"],
    ["invalid_output", "AI answer not accepted"],
    ["context_review", "AI context unresolved"],
  ] as const)("distinguishes %s", (outcome, title) => {
    expect(managerReviewNotice(failed(outcome))?.title).toBe(title);
  });
  it("keeps an unknown failure unknown, including server-side rejection of accepted output", () => {
    expect(managerReviewNotice(failed())?.title).toBe("AI review incomplete");
    expect(managerReviewNotice(failed("accepted"))?.title).toBe("AI review incomplete");
  });
  it("hides stale attempt failures after success", () => {
    expect(managerReviewNotice({ ...failed("rejected"), success: true })).toBeNull();
    expect(managerReviewNotice(undefined)).toBeNull();
  });
  it("uses only the terminal attempt", () => {
    const review = failed("invalid_output");
    review.attempts!.push({ effort: "medium", outcome: "limited", durationMs: 1 });
    expect(managerReviewNotice(review)?.title).toBe("AI allowance reached");
  });
  it("retains the separate API quota diagnosis", () => {
    expect(managerReviewNotice({ ...failed(), provider: "openai-api", failureKind: "quota" })?.title).toBe("AI API credit exhausted");
  });
});
