import { TRPCError } from "@trpc/server";

type CommentActor = {
  name?: string | null;
  role: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertWorkerReviewedComment(
  actor: CommentActor | null | undefined,
  text: unknown
) {
  if (!actor || (actor.role !== "admin" && actor.role !== "worker")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your account is not authorized to post this comment.",
    });
  }

  if (typeof text !== "string" || !text.trim()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A non-empty comment is required before sending.",
    });
  }
  if (actor.role === "admin") return;

  const workerName = actor.name?.trim();
  if (!workerName) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Your worker account has no display name. Keep this as a draft until an administrator updates your account.",
    });
  }
  const firstName = workerName.split(/\s+/)[0];
  const signature = new RegExp(
    `~\\s*(?:${escapeRegExp(firstName)}|${escapeRegExp(workerName)})\\s*$`,
    "i"
  );

  if (!signature.test(text.trim())) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Review the comment and sign it with "~ ${firstName}" or "~ ${workerName}" before sending.`,
    });
  }
}
