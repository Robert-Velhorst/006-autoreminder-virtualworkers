import { describe, expect, it } from "vitest";
import { assessReplyEvidence } from "./trello-reply-evidence";
import type { TrelloAction, TrelloMemberIdentity } from "./trello-manus";

const worker: TrelloMemberIdentity = { id: "worker-1", username: "worker", fullName: "Assigned Worker" };

function comment(input: {
  id: string;
  authorId: string;
  username: string;
  date: string;
  text: string;
}): TrelloAction {
  return {
    id: input.id,
    type: "commentCard",
    date: input.date,
    data: { card: { id: "card-1", name: "Card" }, text: input.text },
    memberCreator: { id: input.authorId, username: input.username, fullName: input.username },
  };
}

describe("Trello reply evidence assessment", () => {
  it("marks an external comment answered only when the worker replied afterward", () => {
    const result = assessReplyEvidence([
      comment({ id: "external", authorId: "owner", username: "owner", date: "2026-08-09T08:00:00.000Z", text: "Please confirm" }),
      comment({ id: "worker", authorId: "worker-1", username: "worker", date: "2026-08-09T09:00:00.000Z", text: "Confirmed" }),
    ], worker, Date.parse("2026-08-09T10:00:00.000Z"));

    expect(result.status).toBe("replied");
    expect(result.latestExternal?.id).toBe("external");
    expect(result.latestWorker?.id).toBe("worker");
  });

  it("marks an unanswered comment overdue after twelve hours", () => {
    const result = assessReplyEvidence([
      comment({ id: "external", authorId: "owner", username: "owner", date: "2026-08-08T20:00:00.000Z", text: "Status?" }),
    ], worker, Date.parse("2026-08-09T09:00:00.000Z"));

    expect(result.status).toBe("overdue");
  });

  it("does not invent a conversation when only the worker commented", () => {
    const result = assessReplyEvidence([
      comment({ id: "worker", authorId: "worker-1", username: "worker", date: "2026-08-09T09:00:00.000Z", text: "Update" }),
    ], worker);

    expect(result.status).toBeNull();
    expect(result.latestExternal).toBeNull();
  });

  it("ignores comments whose author cannot be verified", () => {
    const malformed = comment({ id: "unknown", authorId: "owner", username: "owner", date: "2026-08-09T09:00:00.000Z", text: "Status?" });
    (malformed as Partial<TrelloAction>).memberCreator = undefined;

    const result = assessReplyEvidence([malformed], worker);

    expect(result.status).toBeNull();
  });
});
