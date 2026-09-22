import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("worker task query efficiency", () => {
  it("loads board names with the assigned-card query instead of one query per card", () => {
    const source = readFileSync(new URL("./routes/va-management.ts", import.meta.url), "utf8");
    const taskRoute = source.slice(
      source.indexOf("router.get('/worker/tasks'"),
      source.indexOf("router.post('/worker/tasks/:taskId/complete'"),
    );

    expect(taskRoute).toContain('board: atisBoards');
    expect(taskRoute).toContain('.leftJoin(atisBoards, eq(atisCards.boardId, atisBoards.id))');
    expect(taskRoute).not.toContain('await Promise.all(cardRows.map');
  });
});
