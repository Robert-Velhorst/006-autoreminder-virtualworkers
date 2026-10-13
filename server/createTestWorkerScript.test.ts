import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/create-test-worker.ts");

describe("test worker setup script", () => {
  it("cannot create known-password accounts in production or without an explicit confirmation", () => {
    const source = fs.readFileSync(scriptPath, "utf8");

    expect(source).toContain("NODE_ENV === 'production'");
    expect(source).toContain("--confirm-create-test-worker");
  });
});
