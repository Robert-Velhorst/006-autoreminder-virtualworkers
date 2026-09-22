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
    expect(payment).toContain("eq(paymentCycles.founderId, founderId)");
    expect(payment).toContain('throw new TRPCError({ code: "NOT_FOUND", message: "Payment cycle not found" })');
  });
});
