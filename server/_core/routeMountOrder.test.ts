import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverEntryPath = fileURLToPath(new URL("./index.ts", import.meta.url));

describe("API route mount order", () => {
  it("mounts worker-authorized Trello routes before the legacy admin router", () => {
    const source = readFileSync(serverEntryPath, "utf8");
    const trelloConfigMount = source.indexOf('app.use("/api/trello", trelloConfigRoutes);');
    const legacyAptlssMount = source.indexOf('app.use("/api", aptlssGenerationRateLimiter, aptlssRoutes);');

    expect(trelloConfigMount).toBeGreaterThanOrEqual(0);
    expect(legacyAptlssMount).toBeGreaterThanOrEqual(0);
    expect(trelloConfigMount).toBeLessThan(legacyAptlssMount);
  });
});
