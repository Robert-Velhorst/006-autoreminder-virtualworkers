import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error)
    throw new Error(
      "Production image verification could not complete a bounded Docker command."
    );
  return result;
}

function isolatedRun(run, args) {
  const name = `va-dashboard-image-check-${randomUUID()}`;
  let result;
  let failure;
  try {
    result = run([
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      ...args,
    ]);
  } catch (error) {
    failure = error;
  }
  // A timed-out client can leave its request running in Docker. Clean up only
  // this invocation's uniquely named container; never enumerate other services.
  try {
    const cleanup = run(["rm", "--force", name]);
    if (
      cleanup.status !== 0 &&
      !String(cleanup.stderr).includes("No such container")
    )
      throw new Error(
        `Could not clean up isolated image-check container ${name}.`
      );
  } catch (error) {
    throw new Error(
      `Image acceptance incomplete; cleanup not confirmed for ${name}.`,
      { cause: failure ?? error }
    );
  }
  if (failure) throw failure;
  return result;
}

export function verifyProductionImage(image, run = docker) {
  const inspect = run(["image", "inspect", image]);
  if (inspect.status !== 0)
    throw new Error("Production candidate image is unavailable.");
  const config = JSON.parse(inspect.stdout)[0].Config;
  if (!config.Env?.includes("NODE_ENV=production"))
    throw new Error("Production image must default to NODE_ENV=production.");

  const runtimeCheck = isolatedRun(run, [
    "--entrypoint",
    "node",
    image,
    "-e",
    `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const hash = file => require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert(process.getuid() >= 1000, "Runtime must not run as root");
    assert(!fs.readdirSync("/app").some(name => name === ".env" || name.startsWith(".env.")), "Environment files must not enter the image");
    const seal = JSON.parse(fs.readFileSync("dist/aptlss-build.json", "utf8"));
    assert.equal(hash("dist/index.js"), seal.bundleHash);
    assert.equal(hash("dist/public/downloads/worker-browser-collector.zip"), seal.collectorPackageHash);
    for (const tool of ["dist/tools/reanalyze_all.js", "dist/tools/reanalyze_active_placeholders.js"]) {
      assert(fs.existsSync(tool), "A maintenance tool is missing");
      assert.equal(hash(tool), seal.toolBundleHashes?.[tool], "Maintenance tool integrity mismatch");
      const child = require("node:child_process");
      const help = child.spawnSync(process.execPath, [tool, "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
      assert.equal(help.error, undefined, "Maintenance help must finish without network or database access");
      assert.equal(help.status, 0, "Maintenance help failed");
      const missingOwner = child.spawnSync(process.execPath, [tool], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
      assert.equal(missingOwner.error, undefined, "Missing-owner validation must not start database or provider work");
      assert.equal(missingOwner.status, 2, "A maintenance tool must require explicit owner input");
    }
    for (const tool of ["run-codex-bridge", "run-manager-codex", "run-codex-llm", "manager-codex-supervisor"]) {
      const path = "dist/bridge/" + tool + ".js";
      assert(fs.existsSync(path), "A private bridge bundle is missing");
      assert.equal(hash(path), seal.toolBundleHashes?.[path], "Private bridge integrity mismatch");
    }
    const bridgeHelp = require("node:child_process").spawnSync(process.execPath, ["dist/bridge/run-codex-bridge.js", "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    assert.equal(bridgeHelp.error, undefined, "Bridge help must not require authentication or a network");
    assert.equal(bridgeHelp.status, 0, "Source-free bridge help failed");
    const icon = fs.readFileSync("dist/public/icons/va-dashboard.png");
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(icon.readUInt32BE(16), 144);
    assert.equal(icon.readUInt32BE(20), 144);
    assert.throws(() => require.resolve("vitest"));
    assert.throws(() => require.resolve("typescript"));
    assert(!fs.readdirSync("node_modules/.pnpm").some(name => name.startsWith("typescript@") || name.startsWith("@typescript+typescript-")), "Compiler packages must not enter the runtime image");
    assert.equal(typeof require("@trpc/server").initTRPC.create, "function");
    assert.equal(typeof require("@trpc/server/adapters/express").createExpressMiddleware, "function");
    assert.equal(typeof require("@trpc/client").createTRPCProxyClient, "function");
    assert.equal(typeof require("@trpc/react-query").createTRPCReact, "function");
    assert(!fs.existsSync("/usr/local/lib/node_modules/npm"), "npm must not enter the runtime image");
    for (const tool of ["npm", "npx", "yarn", "yarnpkg"]) {
      assert(!fs.existsSync("/usr/local/bin/" + tool), tool + " must not enter the runtime image");
    }
  `,
  ]);
  if (runtimeCheck.status !== 0)
    throw new Error(
      "Production runtime failed its non-root, asset, build-integrity, or environment-isolation check."
    );

  // No provider credentials and no network: this must fail before starting jobs.
  const startup = isolatedRun(run, [image]);
  if (
    startup.status !== 1 ||
    !`${startup.stdout}${startup.stderr}`.includes(
      "Invalid production configuration"
    )
  )
    throw new Error(
      "Production startup did not reject missing required configuration."
    );
  return {
    passed: true,
    checks: [
      "production-default",
      "non-root",
      "no-env-files",
      "sealed-bundle",
      "collector-integrity",
      "sealed-maintenance-tools",
      "maintenance-help-no-network",
      "sealed-private-bridge",
      "icon",
      "no-vitest",
      "no-typescript-compiler",
      "trpc-runtime-imports",
      "no-package-manager",
      "fail-closed-startup",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(
    JSON.stringify(verifyProductionImage(process.argv[2] || "va-dashboard:ci"))
  );
