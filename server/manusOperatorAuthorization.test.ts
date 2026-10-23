import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy Manus operator authorization", () => {
  it("limits the legacy dashboard router to worker and admin accounts", () => {
    const trpc = readFileSync(resolve(process.cwd(), "server/_core/trpc.ts"), "utf8");
    const manus = readFileSync(resolve(process.cwd(), "server/routes/manus.ts"), "utf8").replace(/\r\n/g, "\n");

    expect(trpc).toContain('user.role !== "admin" && user.role !== "worker"');
    expect(manus).toContain("operatorAccountProcedure");
    const financialBase = [
      'const financialProcedure = protectedProcedure.use(async ({ next }) => {',
      '  assertFinancialFeaturesEnabled();',
      '  return next();',
      '});',
    ].join('\n');
    const availability = 'availability: protectedProcedure.query(() => ({ enabled: financialFeaturesEnabled() }))';
    expect(manus).toContain(financialBase);
    expect(manus).toContain(availability);
    expect(manus).toContain('const financialOperatorProcedure = financialProcedure.concat(operatorAccountProcedure)');
    expect(manus).toContain('const financialAdminProcedure = financialProcedure.concat(adminProcedure)');
    // Only the non-data capability and the role-composed financial base may
    // use generic authentication. Any other unscoped use remains a failure.
    const dataRoutes = manus
      .replace('operatorAccountProcedure, protectedProcedure, router', 'operatorAccountProcedure, router')
      .replace(financialBase, '')
      .replace(availability, '');
    expect(dataRoutes).not.toMatch(/protectedProcedure/);
  });
});
