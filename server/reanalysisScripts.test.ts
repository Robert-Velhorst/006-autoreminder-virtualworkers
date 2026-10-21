import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("AI reanalysis maintenance scripts", () => {
  it("delegates both import-safe entrypoints to the shared preview/confirmation runner", () => {
    for (const script of ["reanalyze_all.ts", "reanalyze_active_placeholders.ts"]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), "server/scripts", script), "utf8");
      expect(source).toContain("from './atisAnalysisCli'");
      expect(source).toContain("return runAtisAnalysisCli(");
      expect(source).toContain("loadCore: loadAtisAnalysisCliCore");
      expect(source).toContain("if (isAtisCliMain(import.meta.url))");
      expect(source).not.toMatch(/processCardUnderstanding|invokeLLM|\.delete\s*\(|\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    }
  });
  it("keeps explicit owner/confirmation validation and canonical admission in the shared helper", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "server/scripts/atisAnalysisCli.ts"), "utf8");
    expect(source).toContain("--owner-user-id");
    expect(source).toContain("--confirm-ai-reanalysis");
    expect(source).toContain("--preview-id");
    expect(source).toContain("--request-key");
    expect(source).toContain("import('../atisAnalysisAdmission')");
    expect(source).toContain("core.createAtisAnalysisPreview(actor.id, selection)");
    expect(source).toContain("core.confirmAtisAnalysisPreview(actor.id, id, input)");
    expect(source).toContain("core.getAtisAnalysisJob(actor.id, id)");
    expect(source).not.toMatch(/processCardUnderstanding|invokeLLM|\.delete\s*\(|\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  });
});
