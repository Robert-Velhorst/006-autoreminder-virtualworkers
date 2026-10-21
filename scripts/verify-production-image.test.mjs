import { describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { verifyProductionImage } from "./verify-production-image.mjs";

const ok = { status: 0, stdout: "", stderr: "" };
const configured = {
  ...ok,
  stdout: JSON.stringify([{ Config: { Env: ["NODE_ENV=production"] } }]),
};
const rejected = {
  status: 1,
  stdout: "Invalid production configuration",
  stderr: "",
};
function driver(overrides = {}) {
  let runs = 0;
  return vi.fn(args => {
    if (args[0] === "image") return overrides.inspect ?? configured;
    if (args[0] === "rm") return overrides.cleanup ?? ok;
    runs++;
    if (overrides.failure) throw overrides.failure;
    return runs === 1
      ? (overrides.runtime ?? ok)
      : (overrides.startup ?? rejected);
  });
}

describe("production image verification isolation", () => {
  function executeRuntimeCheck({ installed = [], store = [], missingImport, missingTool = false, badToolHelp = false } = {}) {
    const run = driver();
    verifyProductionImage("fixture:release", run);
    const script = run.mock.calls.find(([args]) => args[0] === "run")[0].at(-1);
    const icon = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(icon);
    icon.writeUInt32BE(144, 16);
    icon.writeUInt32BE(144, 20);
    const modules = {
      "node:assert/strict": assert,
      "node:fs": {
        readdirSync: path => path === "/app" ? [] : store,
        existsSync: path => path.startsWith("dist/tools/") ? !missingTool : installed.includes(path),
        readFileSync: path => path === "dist/aptlss-build.json"
          ? JSON.stringify({ bundleHash: "fixture", collectorPackageHash: "fixture", toolBundleHashes: {
            "dist/tools/reanalyze_all.js": "fixture", "dist/tools/reanalyze_active_placeholders.js": "fixture",
          } })
          : path.endsWith(".png") ? icon : Buffer.from("fixture"),
      },
      "node:crypto": { createHash: () => ({ update: () => ({ digest: () => "fixture" }) }) },
      "@trpc/server": { initTRPC: { create() {} } },
      "@trpc/server/adapters/express": { createExpressMiddleware() {} },
      "@trpc/client": { createTRPCProxyClient() {} },
      "@trpc/react-query": { createTRPCReact() {} },
      "node:child_process": { spawnSync: (_node, args) => ({ status: args.includes("--help") ? (badToolHelp ? 1 : 0) : 2 }) },
    };
    const require = name => {
      if (!(name in modules) || name === missingImport) throw new Error("Missing module: " + name);
      return modules[name];
    };
    require.resolve = name => { throw new Error("Not installed: " + name); };
    runInNewContext(script, { require, process: { getuid: () => 1001 } });
  }

  it("executes the actual runtime script for an intact minimal fixture", () => {
    expect(() => executeRuntimeCheck()).not.toThrow();
  });
  it("rejects missing maintenance tools or an unusable help command", () => {
    expect(() => executeRuntimeCheck({ missingTool: true })).toThrow(/maintenance tool is missing/);
    expect(() => executeRuntimeCheck({ badToolHelp: true })).toThrow(/Maintenance help failed/);
  });

  it.each(["npm", "npx", "yarn", "yarnpkg"])("rejects a runtime containing %s", tool => {
    expect(() => executeRuntimeCheck({ installed: ["/usr/local/bin/" + tool] })).toThrow(/must not enter/);
  });

  it("rejects npm package payload even without its command shim", () => {
    expect(() => executeRuntimeCheck({ installed: ["/usr/local/lib/node_modules/npm"] })).toThrow(/npm must not enter/);
  });

  it.each(["typescript@7.0.2", "@typescript+typescript-linux-x64@7.0.2"])("rejects unused compiler payload %s", compiler => {
    expect(() => executeRuntimeCheck({ store: [compiler] })).toThrow(/Compiler packages/);
  });

  it.each(["@trpc/server", "@trpc/server/adapters/express", "@trpc/client", "@trpc/react-query"])("rejects removal of runtime dependency %s", missingImport => {
    expect(() => executeRuntimeCheck({ missingImport })).toThrow(/Missing module/);
  });

  it("accepts runtime checks with no provider network", () => {
    const run = driver();
    expect(verifyProductionImage("fixture:release", run)).toMatchObject({
      passed: true,
      checks: expect.any(Array),
    });
    const containers = run.mock.calls
      .filter(([args]) => args[0] === "run")
      .map(([args]) => args);
    expect(containers).toHaveLength(2);
    const runtimeScript = containers[0].at(-1);
    expect(runtimeScript).toContain('/usr/local/lib/node_modules/npm');
    expect(runtimeScript).toContain('["npm", "npx", "yarn", "yarnpkg"]');
    expect(runtimeScript).toContain('require.resolve("typescript")');
    expect(runtimeScript).toContain('name.startsWith("@typescript+typescript-")');
    expect(runtimeScript).toContain('require("@trpc/server/adapters/express")');
    expect(runtimeScript).toContain('require("@trpc/client")');
    const names = containers.map(args => args[args.indexOf("--name") + 1]);
    expect(new Set(names).size).toBe(2);
    for (const args of containers) {
      expect(args[args.indexOf("--network") + 1]).toBe("none");
      expect(args[args.indexOf("--memory") + 1]).toBe("256m");
      expect(args[args.indexOf("--cpus") + 1]).toBe("0.5");
    }
    expect(
      run.mock.calls.filter(([args]) => args[0] === "rm").map(([args]) => args)
    ).toEqual(names.map(name => ["rm", "--force", name]));
  });

  it("cleans up exactly the owned container on command timeout and retains the cause", () => {
    const failure = new Error("Fixture Docker deadline");
    const run = driver({ failure });
    expect(() => verifyProductionImage("fixture:release", run)).toThrow(
      failure
    );
    expect(run).toHaveBeenCalledTimes(3);
    const name =
      run.mock.calls[1][0][run.mock.calls[1][0].indexOf("--name") + 1];
    expect(run.mock.calls[2][0]).toEqual(["rm", "--force", name]);
  });

  it("accepts automatic removal but not other cleanup failures", () => {
    expect(
      verifyProductionImage(
        "fixture:release",
        driver({
          cleanup: { status: 1, stderr: "Error: No such container: fixture" },
        })
      ).passed
    ).toBe(true);
    expect(() =>
      verifyProductionImage(
        "fixture:release",
        driver({ cleanup: { status: 1, stderr: "Daemon unavailable" } })
      )
    ).toThrow(/cleanup not confirmed/);
  });

  it("does not run containers when the image is absent or not production-default", () => {
    const absent = driver({ inspect: { status: 1 } });
    expect(() => verifyProductionImage("fixture:release", absent)).toThrow(
      /unavailable/
    );
    expect(absent).toHaveBeenCalledTimes(1);
    const unsafe = driver({
      inspect: {
        ...ok,
        stdout: JSON.stringify([{ Config: { Env: ["NODE_ENV=development"] } }]),
      },
    });
    expect(() => verifyProductionImage("fixture:release", unsafe)).toThrow(
      /production/
    );
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it("rejects failed runtime checks without starting the application", () => {
    const run = driver({ runtime: { status: 1, stderr: "Assertion failed" } });
    expect(() => verifyProductionImage("fixture:release", run)).toThrow(
      /runtime failed/
    );
    expect(run.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(
      1
    );
  });

  it.each([
    { status: 0, stdout: "Invalid production configuration" },
    { status: 1, stdout: "Other error" },
  ])(
    "rejects startup that does not demonstrate fail-closed configuration: %j",
    startup => {
      expect(() =>
        verifyProductionImage("fixture:release", driver({ startup }))
      ).toThrow(/did not reject/);
    }
  );
});
