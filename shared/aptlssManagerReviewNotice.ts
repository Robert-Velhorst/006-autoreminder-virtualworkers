import type { ManagerSnapshot } from "./aptlssManager";

type ManagerReview = NonNullable<ManagerSnapshot["semanticReview"]>;
type Attempt = NonNullable<ManagerReview["attempts"]>[number];

export type ManagerReviewNotice = {
  title: string;
  message: string;
};

/**
 * Turn the persisted terminal review state into an honest operator message.
 * This is deliberately presentation-only: it never changes whether a review
 * is accepted and never treats a provider message as an instruction.
 */
export function managerReviewNotice(review: ManagerReview | undefined): ManagerReviewNotice | null {
  if (!review || review.success) return null;

  const subscriptionNote = review.provider === "codex-subscription"
    ? " No paid API fallback is enabled."
    : "";

  if (review.failureKind === "quota" && review.provider !== "codex-subscription") {
    return {
      title: "AI API credit exhausted",
      message: "OpenAI API credit is exhausted. The deterministic assessment remains active while the next retry is scheduled.",
    };
  }

  const terminal = review.attempts?.at(-1)?.outcome;
  switch (terminal as Attempt["outcome"] | undefined) {
    case "limited":
      return {
      title: "AI allowance reached",
      message: `The connected AI subscription did not have enough allowance for this review. The deterministic assessment remains active.${subscriptionNote}`,
      };
    case "unauthenticated":
      return {
      title: "AI sign-in required",
      message: `The local AI subscription could not be authenticated. The deterministic assessment remains active.${subscriptionNote}`,
      };
    case "unavailable":
      return {
      title: "AI connection unavailable",
      message: `The local AI review connection was unavailable. The deterministic assessment remains active.${subscriptionNote}`,
      };
    case "context_review":
      return {
      title: "AI context unresolved",
      message: `The AI review reached its reasoning limit without resolving the required context. The deterministic assessment remains active.${subscriptionNote}`,
      };
    case "missing_evidence":
      return {
      title: "AI evidence still missing",
      message: `The AI review could not establish a necessary fact from the supplied sources. The deterministic assessment remains active.${subscriptionNote}`,
      };
    case "invalid_output":
    case "rejected":
      return {
      title: "AI answer not accepted",
      message: `The AI answer was rejected by the safety or output checks. No model proposal was applied, and the deterministic assessment remains active.${subscriptionNote}`,
      };
    default:
      return {
      title: "AI review incomplete",
      message: `The latest AI review did not produce an accepted result. The deterministic assessment remains active.${subscriptionNote}`,
      };
  }
}
