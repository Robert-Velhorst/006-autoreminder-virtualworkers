import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getBackgroundWorkConfiguration } from "./backgroundWork";

const normal = { localAuthBypassEnabled: false };
const testEnvironment = {
  NODE_ENV: "development",
  APTLSS_TEST_DISABLE_BACKGROUND_JOBS: "true",
  APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@127.0.0.1:33319/aptlss_test",
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
    expect(getBackgroundWorkConfiguration({ ...testEnvironment, APTLSS_TEST_DATABASE_URL: `mysql://fixture:private@${host}/recovery_test` }, normal))
      .toEqual({ enabled: false, reason: "Isolated APTLSS browser-test mode" });
  });
  it.each([
    { NODE_ENV: "production" },
    { APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@database/aptlss_test" },
    { APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@127.0.0.1/production" },
    { APTLSS_TEST_DATABASE_URL: "postgres://fixture:private@127.0.0.1/aptlss_test" },
    { APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@127.0.0.1/aptlss_test?unsafe=1" },
    { APTLSS_TEST_DATABASE_URL: "mysql://fixture:private@127.0.0.1/aptlss_test#unsafe" },
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
    const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const starters = new Set(["startBriefingScheduler", "startManusScheduler", "startReminderWorker",
      "startMaintenanceCenter", "startManagerScheduler", "startFounderDecisionAlertWorker"]);
    const found: string[] = [];
    let callbackConfigured = false;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (starters.has(name)) {
          found.push(name);
          let guarded = false;
          for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
            if (ts.isIfStatement(ancestor) && ancestor.expression.getText(source) === "backgroundWork.enabled") {
              let branch: ts.Node = node;
              while (branch.parent !== ancestor) branch = branch.parent;
              guarded = branch === ancestor.thenStatement;
              break;
            }
          }
          expect(guarded, `${name} must be in the enabled branch`).toBe(true);
        }
        if (name === "initializeWebhookAutoRegister") {
          expect(node.arguments.length).toBe(2);
          expect(node.arguments[1].kind).toBe(ts.SyntaxKind.FalseKeyword);
          callbackConfigured = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(found.sort()).toEqual([...starters].sort());
    expect(callbackConfigured).toBe(true);
  });
});
