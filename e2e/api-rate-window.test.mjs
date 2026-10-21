import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiRateWindow } from "./api-rate-window.mjs";

test("waits for the previous account's real API window without changing quotas", () => {
  const window = new ApiRateWindow();
  assert.equal(window.waitMilliseconds(1000), 0);
  window.observe({ "x-ratelimit-limit": "60", "x-ratelimit-reset": "61000" }, 1000);
  assert.equal(window.waitMilliseconds(1000), 60100);
  assert.equal(window.waitMilliseconds(61099), 1);
  assert.equal(window.waitMilliseconds(61100), 0);
});

test("ignores unrelated limits, absent headers and invalid or unbounded resets", () => {
  for (const headers of [{},
    { "x-ratelimit-limit": "5", "x-ratelimit-reset": "61000" },
    { "x-ratelimit-limit": "120", "x-ratelimit-reset": "61000" },
    ...["NaN", "Infinity", "1000", "61001.5", "9999999999999999", "62000"].map(reset =>
      ({ "x-ratelimit-limit": "60", "x-ratelimit-reset": reset })),
  ]) {
    const window = new ApiRateWindow();
    window.observe(headers, 1000);
    assert.equal(window.waitMilliseconds(1000), 0);
  }
});

test("retains the latest observed API reset until elapsed", () => {
  const window = new ApiRateWindow();
  window.observe({ "x-ratelimit-limit": "60", "x-ratelimit-reset": "60000" }, 1000);
  window.observe({ "x-ratelimit-limit": "60", "x-ratelimit-reset": "50000" }, 1000);
  assert.equal(window.waitMilliseconds(1000), 59100);
});
