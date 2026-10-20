import { afterEach, describe, expect, it, vi } from "vitest";
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteLocalFile, confinedLocalPath } from "../shared/local-filesystem-policy.mjs";
import { codexInvocation } from "./aptlssManagerCodexRunner";
import { normalizeReminderWorkerInterval } from "./reminderOrchestration";

const fixtureDirectories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aptlss-filesystem-"));
  fixtureDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtureDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("local manager filesystem and process boundaries", () => {
  it("confines ordinary configuration to a child of the application workspace", () => {
    const old = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(confinedLocalPath(".local/pilot/proof/attestation.json")).toBe(resolve(".local/pilot/proof/attestation.json"));
      expect(() => confinedLocalPath("../outside/attestation.json")).toThrow(/workspace/);
      expect(() => confinedLocalPath(process.cwd())).toThrow(/workspace/);
      expect(() => confinedLocalPath(join(tmpdir(), "outside-proof.json"))).toThrow(/workspace/);
    } finally { process.env.NODE_ENV = old; }
  });
  it("permits disposable test fixtures without allowing arbitrary commands", () => {
    expect(confinedLocalPath(join(tmpdir(), "aptlss-test", "proof.json"))).toBe(join(tmpdir(), "aptlss-test", "proof.json"));
    expect(codexInvocation(process.execPath).command).toBe(process.execPath);
    expect(() => codexInvocation("arbitrary-command")).toThrow(/official Codex/);
    expect(() => codexInvocation(resolve("unexpected.exe"))).toThrow(/official Codex/);
  });

  it("executes the exact configured regular binary, without PATH fallback", async () => {
    const directory = await fixture();
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    const executable = join(directory, name);
    await writeFile(executable, "not executed: selection fixture only");
    const invocation = codexInvocation(executable);
    expect(invocation.command).toBe(await realpath(executable));
    expect(invocation.command).not.toBe(name);
    expect(() => codexInvocation(join(directory, "missing", name))).toThrow();
    await rm(executable);
    await mkdir(executable);
    expect(() => codexInvocation(executable)).toThrow(/regular/);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => codexInvocation(process.execPath)).toThrow(/official Codex/);
  });
  it("rejects derived queue paths through a junction", async () => {
    const directory = await fixture();
    const outside = await fixture();
    const installed = join(directory, "installed");
    await symlink(outside, installed, process.platform === "win32" ? "junction" : "dir");
    expect(() => confinedLocalPath(join(installed, "requests", "job.json"))).toThrow(/symbolic links/);
  });
  it("publishes complete files atomically and rejects a linked destination without modifying its target", async () => {
    const directory = await fixture();
    const outside = await fixture();
    const destination = join(directory, "reply.json");
    await atomicWriteLocalFile(destination, "first complete reply");
    await atomicWriteLocalFile(destination, "second complete reply");
    expect(await readFile(destination, "utf8")).toBe("second complete reply");
    expect(await readdir(directory)).toEqual(["reply.json"]);
    await rm(destination);
    await writeFile(join(outside, "preserve.txt"), "preserve");
    await symlink(outside, destination, process.platform === "win32" ? "junction" : "dir");
    await expect(atomicWriteLocalFile(destination, "must not write")).rejects.toThrow(/symbolic links/);
    expect(await readFile(join(outside, "preserve.txt"), "utf8")).toBe("preserve");
    expect(await readdir(outside)).toEqual(["preserve.txt"]);
  });

  it("replaces a hard-linked destination without truncating the original file and cleans failed temporary writes", async () => {
    const directory = await fixture();
    const outside = await fixture();
    const original = join(outside, "original.json");
    const destination = join(directory, "reply.json");
    await writeFile(original, "private original");
    await link(original, destination);
    await atomicWriteLocalFile(destination, "new complete reply");
    expect(await readFile(original, "utf8")).toBe("private original");
    expect(await readFile(destination, "utf8")).toBe("new complete reply");
    const blocked = join(directory, "blocked.json");
    await mkdir(blocked);
    await expect(atomicWriteLocalFile(blocked, "must not publish")).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(["blocked.json", "reply.json"]);
  });
  it.each([[Number.NaN,60000],[Infinity,60000],[-1,15000],[0,15000],[1,15000],[60000,60000],[Number.MAX_SAFE_INTEGER,3600000]])("bounds scheduler interval %s", (value, expected) => {
    expect(normalizeReminderWorkerInterval(value)).toBe(expected);
  });
});
