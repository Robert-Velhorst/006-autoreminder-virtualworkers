import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));

vi.mock("axios", () => ({ default: axiosMock }));

import { moveCardToDoing } from "./trello-manus";

describe("moveCardToDoing", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.put.mockReset();
  });

  it("moves a card into the board's Doing list", async () => {
    axiosMock.get
      .mockResolvedValueOnce({ data: { idBoard: "board-move", idList: "todo" } })
      .mockResolvedValueOnce({ data: [{ id: "todo", name: "To Do" }, { id: "doing", name: "Doing" }] })
      .mockResolvedValueOnce({ data: { id: "board-move", name: "Operations" } });
    axiosMock.put.mockResolvedValueOnce({ data: { id: "card-1" } });

    await expect(moveCardToDoing("card-1", "key", "token")).resolves.toEqual({
      moved: true,
      listId: "doing",
      listName: "Doing",
    });
    expect(axiosMock.put).toHaveBeenCalledWith(
      expect.stringContaining("/cards/card-1"),
      undefined,
      expect.objectContaining({
        timeout: 15_000,
        params: expect.objectContaining({ idList: "doing" }),
      }),
    );
    for (const [, config] of axiosMock.get.mock.calls) {
      expect(config.timeout).toBe(15_000);
    }
  });

  it("does not claim success when the board has no Doing list", async () => {
    axiosMock.get
      .mockResolvedValueOnce({ data: { idBoard: "board-missing", idList: "todo" } })
      .mockResolvedValueOnce({ data: [{ id: "todo", name: "To Do" }] })
      .mockResolvedValueOnce({ data: { id: "board-missing", name: "Operations" } });

    await expect(moveCardToDoing("card-2", "key", "token"))
      .rejects.toThrow("no Doing or In Progress list");
    expect(axiosMock.put).not.toHaveBeenCalled();
  });
});
