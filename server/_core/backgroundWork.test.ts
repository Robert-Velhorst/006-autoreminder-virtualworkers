import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";
import { describe, expect, it } from "vitest";
import { getBackgroundWorkConfiguration } from "./backgroundWork";

const normal = { localAuthBypassEnabled: false };
const testEnvironment = {
  NODE_ENV: "development",
  APTLSS_TEST_DISABLE_BACKGROUND_JOBS: "true",
  APTLSS_TEST_DATABASE_URL: "postgresql://fixture:private@127.0.0.1:33319/aptlss_test",
};

describe("automatic startup work configuration", () => {
  it.each([undefined, "true"])("preserves normal startup with %s", value => {
    expect(getBackgroundWorkConfiguration({ NODE_ENV: "production", BACKGROUND_JOBS_ENABLED: value }, normal))
      .toEqual({ enabled: true, reason: null });
  });
  it.each(["production", "development", "test"])("allows explicit job isolation in %s without auth bypass", NODE_ENV => {
    expect(getBackgroundWorkConfiguration({ NODE_ENV, BACKGROUND_JOBS_ENABLED: "false" }, normal))
      .toEqual({ enabled: false, reason: "BACKGROUND_JOBS_ENABLED=false" });
  });
  it.each(["", "False", "TRUE", "0", "1", " false", "false ", "disabled"])("rejects ambiguous setting %j", value => {
    expect(() => getBackgroundWorkConfiguration({ BACKGROUND_JOBS_ENABLED: value }, normal))
      .toThrow("BACKGROUND_JOBS_ENABLED must be exactly true or false");
  });
  it("retains local preview isolation even when startup jobs are requested", () => {
    expect(getBackgroundWorkConfiguration({ BACKGROUND_JOBS_ENABLED: "true" }, { localAuthBypassEnabled: true }))
      .toEqual({ enabled: false, reason: "Local auth bypass enabled" });
  });
  it.each(["127.0.0.1", "localhost", "[::1]"])("retains isolated test mode at %s", host => {
    expect(getBackgroundWorkConfiguration({ ...testEnvironment, APTLSS_TEST_DATABASE_URL: `postgresql://fixture:private@${host}/recovery_test` }, normal))
      .toEqual({ enabled: false, reason: "Isolated APTLSS browser-test mode" });
  });
  it.each([
    { NODE_ENV: "production" },
    { APTLSS_TEST_DATABASE_URL: "postgresql://fixture:private@database/aptlss_test" },
    { APTLSS_TEST_DATABASE_URL: "postgresql://fixture:private@127.0.0.1/production" },
    { APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@127.0.0.1/aptlss_test" },
    { APTLSS_TEST_DATABASE_URL: "postgresql://fixture:private@127.0.0.1/aptlss_test?unsafe=1" },
    { APTLSS_TEST_DATABASE_URL: "postgresql://fixture:private@127.0.0.1/aptlss_test#unsafe" },
  ])("does not let the global switch excuse unsafe browser-test configuration: %j", override => {
    expect(() => getBackgroundWorkConfiguration({ ...testEnvironment, ...override, BACKGROUND_JOBS_ENABLED: "false" }, normal))
      .toThrow("restricted to non-production loopback test databases");
  });
  it("does not expose credentials in malformed test configuration errors", () => {
    expect(() => getBackgroundWorkConfiguration({ ...testEnvironment, APTLSS_TEST_DATABASE_URL: "private credential" }, normal))
      .toThrow("requires its explicit loopback test database URL");
  });

  it("validates before initializing the server, while keeping auth assertions unconditional", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.slice(source.indexOf("async function startServer()"));
    const order = ["assertProductionConfiguration();", "assertLocalAuthBypassConfiguration();",
      "getBackgroundWorkConfiguration(process.env", "const app = express();", "await initializeRedis();"];
    expect(order.map(text => start.indexOf(text))).toEqual([...order.map(text => start.indexOf(text))].sort((a, b) => a - b));
    for (const text of order) expect(start).toContain(text);
    expect(source).toContain('app.use(\'/api\', attachRequestAuthentication)');
    expect(source).toContain('app.use(\'/api\', requireTrustedSessionOrigin)');
  });

  it("guards all six starter calls and retains callback configuration without automatic registration", () => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const source = parse(text, { sourceType: "module", plugins: ["typescript"] });
    const starters = new Set(["startBriefingScheduler", "startManusScheduler", "startReminderWorker",
      "startMaintenanceCenter", "startManagerScheduler", "startFounderDecisionAlertWorker"]);
    const found: string[] = [];
    let callbackConfigured = false;
    function visit(node: Node, ancestors: Node[] = []) {
      if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        const name = node.callee.name;
        if (starters.has(name)) {
          found.push(name);
          let guarded = false;
          for (let index = ancestors.length - 1; index >= 0; index--) {
            const ancestor = ancestors[index];
            if (ancestor.type === "IfStatement" && text.slice(ancestor.test.start!, ancestor.test.end!) === "backgroundWork.enabled") {
              const branch = ancestors[index + 1] ?? node;
              guarded = branch === ancestor.consequent;
              break;
            }
          }
          expect(guarded, `${name} must be in the enabled branch`).toBe(true);
        }
        if (name === "initializeWebhookAutoRegister") {
          expect(node.arguments.length).toBe(2);
          expect(node.arguments[1]).toMatchObject({ type: "BooleanLiteral", value: false });
          callbackConfigured = true;
        }
      }
      for (const key of VISITOR_KEYS[node.type] ?? []) {
        const value = (node as unknown as Record<string, unknown>)[key];
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === "object" && "type" in child) {
            visit(child as Node, [...ancestors, node]);
          }
        }
      }
    }
    visit(source);
    expect(found.sort()).toEqual([...starters].sort());
    expect(callbackConfigured).toBe(true);
  });
});
