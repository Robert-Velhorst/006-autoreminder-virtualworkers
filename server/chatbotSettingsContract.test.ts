import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Chatbot settings contract", () => {
  it("does not render the unwired automated check-in settings panel", () => {
    const source = readFileSync(
      new URL("../client/src/components/ChatbotSettings.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("CheckinScheduleSettings");
    expect(source).not.toContain("/api/trello-webhook/checkin-settings");
  });
});
