import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("axios", () => ({ default: axiosMock }));

import { fetchCardContext } from "./trelloCardContext";

describe("fetchCardContext", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.get
      .mockResolvedValueOnce({
        data: {
          id: "card/one",
          name: "Card",
          desc: "",
          idBoard: "board-1",
          idList: "list-1",
          dateLastActivity: "2026-08-20T10:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { name: "Board" } })
      .mockResolvedValueOnce({ data: { name: "List" } });
  });

  it("encodes provider path IDs and bounds every Trello request", async () => {
    await fetchCardContext("card/one", "key", "token");

    expect(axiosMock.get).toHaveBeenCalledTimes(5);
    for (const [url, config] of axiosMock.get.mock.calls) {
      expect(url).not.toContain("/card/one/");
      expect(config.timeout).toBe(15_000);
    }
    expect(axiosMock.get.mock.calls[0][0]).toContain("/cards/card%2Fone");
  });
});
