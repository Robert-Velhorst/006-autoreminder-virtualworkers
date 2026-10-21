import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("financial mutation authorization", () => {
  it("requires an admin for pay settlement and weekly pay changes", () => {
    const source = readFileSync(resolve(process.cwd(), "server/routes/manus.ts"), "utf8");
    const payment = source.slice(source.indexOf("export const paymentRouter"), source.indexOf("export const payLogRouter"));
    const payLog = source.slice(source.indexOf("export const payLogRouter"), source.indexOf("export const triageRouter"));

    expect(payment).toMatch(/markPaid:\s*adminProcedure/);
    expect(payLog).toMatch(/upsert:\s*adminProcedure/);
    expect(payment).toContain('return readPaymentCycles(db, ctx.user)');
    expect(payment).toContain('await settlePaymentCycle(db, ctx.user, input)');
    expect(payLog).toContain('await saveWeeklyPayLog(db, ctx.user, input)');
    expect(payLog).toContain('await getWeeklyPayLogs(db, ctx.user, input)');
    expect(payLog).toContain('await getWeeklyPayLog(db, ctx.user, input)');
    expect(payLog).not.toContain('input.vaId || founderId');
  });
});
