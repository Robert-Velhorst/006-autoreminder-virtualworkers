import { test as base } from "@playwright/test";
import { isolatedBrowserClientAddress } from "./isolated-browser-client";

let clientSequence = 0;

// Each independent browser scenario represents its own client behind the test proxy.
// Production rate limits stay enabled and apply normally within that scenario.
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, info) => {
    await use({
      ...extraHTTPHeaders,
      "X-Forwarded-For": isolatedBrowserClientAddress(info.workerIndex, ++clientSequence),
    });
  },
});
