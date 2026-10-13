import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/wipe-workers.js");

describe("worker wipe maintenance script", () => {
  it("requires an explicit destructive-operation confirmation and never logs the database URL", () => {
    const source = fs.readFileSync(scriptPath, "utf8");

    expect(source).toContain("--confirm-worker-data-wipe");
    expect(source).not.toContain('console.log("Connecting to:", url)');
    expect(source).toContain("finally");
  });
});
