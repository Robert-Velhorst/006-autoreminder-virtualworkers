import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveSettings } from "./operator-data-transfer-utils.mjs";

describe("redactSensitiveSettings", () => {
  it("redacts secret-bearing values but keeps non-secret settings", () => {
    const rows = [
      { key: "ai_groq_key", value: "provider-secret" },
      { key: "refresh_token", value: "refresh-secret" },
      { key: "browserTabCollectorToken", value: "collector-secret" },
      { key: "openaiKey", value: "openai-secret" },
      { key: "oauth-client-secret", value: "oauth-secret" },
      { key: "dbPassword", value: "database-secret" },
      { key: "working_hours", value: "09:00-17:00" },
      { key: "keyboard_shortcuts", value: "Ctrl+K" },
    ];

    assert.deepEqual(redactSensitiveSettings(rows), [
      { key: "ai_groq_key", value: null },
      { key: "refresh_token", value: null },
      { key: "browserTabCollectorToken", value: null },
      { key: "openaiKey", value: null },
      { key: "oauth-client-secret", value: null },
      { key: "dbPassword", value: null },
      { key: "working_hours", value: "09:00-17:00" },
      { key: "keyboard_shortcuts", value: "Ctrl+K" },
    ]);
    assert.equal(rows[0].value, "provider-secret");
  });
});
