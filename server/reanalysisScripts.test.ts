import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("AI reanalysis maintenance scripts", () => {
  it("require an explicit confirmation before spending model capacity", () => {
    for (const script of ["reanalyze_all.ts", "reanalyze_active_placeholders.ts"]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), "server/scripts", script), "utf8");
      expect(source).toContain("--confirm-ai-reanalysis");
    }
  });
});
