import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/generate-migration.js");

describe("migration generation script", () => {
  it("uses the locked package manager and requires an explicit apply flag", () => {
    const source = fs.readFileSync(scriptPath, "utf8");

    expect(source).toContain("pnpm");
    expect(source).toContain("--apply");
    expect(source).not.toContain("spawn('npx'");
  });
});
