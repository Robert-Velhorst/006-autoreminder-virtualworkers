import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqlBackup,
  freeDiskBytes,
  nativeBackupArguments,
} from "./pilot-database-backup.mjs";
import { restoreClientEnvironment } from "./pilot-backup-restore.mjs";

const directories = [];
const output = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pilot-backup-test-")
  );
  directories.push(directory);
  return path.join(directory, "operational.sql");
};
const payload =
  "-- " + "x".repeat(2048) + "\n-- Dump completed on 2026-10-01 00:00:00\n";
const env = restoreClientEnvironment("fixture-password");
const run = (program, file, options = {}) =>
  createSqlBackup(
    process.execPath,
    ["--input-type=module", "-e", program],
    env,
    file,
    { reserveBytes: 0n, ...options }
  );
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("operational native backup boundaries", () => {
  const config = {
    MYSQL_PORT: "3307",
    MYSQL_DATABASE: "joyce_work_schedule_consolidated",
    MYSQL_ROOT_PASSWORD: "fixture-password",
  };
  it("pins the loopback database, streaming consistency, charset and UTC", () => {
    const args = nativeBackupArguments(config);
    expect(args[0]).toBe("--no-defaults");
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-login-paths",
        "--single-transaction",
        "--quick",
        "--tz-utc",
        "--default-character-set=utf8mb4",
        "--host=127.0.0.1",
        "--port=3307",
      ])
    );
    expect(args.at(-1)).toBe(config.MYSQL_DATABASE);
    expect(args.join(" ")).not.toContain(config.MYSQL_ROOT_PASSWORD);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--lock-all-tables");
  });
  it.each(["3306", "33317", "3307 --force", "invalid"])(
    "rejects a different or invalid source port %s",
    port => {
      expect(() =>
        nativeBackupArguments({ ...config, MYSQL_PORT: port })
      ).toThrow("established loopback");
    }
  );
  it.each(["recovery_test", "--all-databases", ""])(
    "rejects a different database %s",
    database => {
      expect(() =>
        nativeBackupArguments({ ...config, MYSQL_DATABASE: database })
      ).toThrow("established loopback");
    }
  );
  it.each([undefined, "", 123])("rejects missing credentials %s", password => {
    expect(() =>
      nativeBackupArguments({ ...config, MYSQL_ROOT_PASSWORD: password })
    ).toThrow("credentials");
  });
  it("uses the system disk counter as a bigint", () =>
    expect(freeDiskBytes(os.tmpdir())).toBeGreaterThan(0n));
  it("does not inherit provider credentials", () => {
    const clean = restoreClientEnvironment("fixture-password", {
      OPENAI_API_KEY: "private",
      TRELLO_TOKEN: "private",
      MYSQL_TEST_LOGIN_FILE: "private",
      Path: "fixture-path",
    });
    expect(clean).toEqual({
      MYSQL_PWD: "fixture-password",
      Path: "fixture-path",
    });
  });
});

describe("backup producer lifecycle", () => {
  it("persists the complete byte stream with a matching digest", async () => {
    const file = output();
    const result = await run(
      `process.stdout.write(${JSON.stringify(payload)});`,
      file
    );
    expect(fs.readFileSync(file, "utf8")).toBe(payload);
    expect(result.bytes).toBe(Buffer.byteLength(payload));
    expect(result.sha256).toBe(
      createHash("sha256").update(payload).digest("hex")
    );
  });
  it("never overwrites an existing backup", async () => {
    const file = output();
    fs.writeFileSync(file, "original");
    await expect(run("process.exit(0);", file)).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
  it("refuses to start below the configured disk reserve", async () => {
    const file = output();
    await expect(
      run("process.exit(0);", file, {
        reserveBytes: 10n,
        readFreeBytes: () => 10n,
      })
    ).rejects.toThrow("reserve");
    expect(fs.existsSync(file)).toBe(false);
  });
  it.each([0, -1, NaN, 3600001])(
    "rejects invalid timeout %s before creating the file",
    async timeoutMs => {
      const file = output();
      await expect(
        run("process.exit(0);", file, { timeoutMs })
      ).rejects.toThrow("timeout");
      expect(fs.existsSync(file)).toBe(false);
    }
  );
  it("rejects an invalid disk reserve", async () => {
    const file = output();
    await expect(
      run("process.exit(0);", file, { reserveBytes: -1n })
    ).rejects.toThrow("reserve");
    expect(fs.existsSync(file)).toBe(false);
  });
  it("redacts process diagnostics and retains the incomplete file", async () => {
    const file = output();
    await expect(
      run(
        'process.stderr.write("PRIVATE_CREDENTIALS"); process.stdout.write("partial"); process.exitCode=1;',
        file
      )
    ).rejects.toThrow("diagnostic bytes: 19");
    expect(fs.readFileSync(file, "utf8")).toBe("partial");
  });
  it("rejects a completion marker followed by more SQL", async () => {
    const file = output();
    await expect(
      run(
        `process.stdout.write(${JSON.stringify(payload + "SELECT 1;\n")});`,
        file
      )
    ).rejects.toThrow("completion marker");
  });
  it("rejects a zero-exit partial backup", async () => {
    await expect(
      run('process.stdout.write("partial");', output())
    ).rejects.toThrow("Incomplete");
  });
  it("settles a missing executable without an unhandled process error", async () => {
    const file = output();
    await expect(
      createSqlBackup(path.join(path.dirname(file), "missing"), [], env, file, {
        reserveBytes: 0n,
      })
    ).rejects.toThrow("could not start");
  });
  it("terminates the direct producer on timeout, even after stdout closes", async () => {
    await expect(
      run(
        `process.stdout.end(${JSON.stringify(payload)}); setInterval(()=>{},1000);`,
        output(),
        { timeoutMs: 500 }
      )
    ).rejects.toThrow("timed out");
  });
  it("rechecks disk space before accepting a completed backup", async () => {
    let checks = 0;
    await expect(
      run(`process.stdout.write(${JSON.stringify(payload)});`, output(), {
        readFreeBytes: () => (++checks === 1 ? 100n : 0n),
      })
    ).rejects.toThrow("reserve");
    expect(checks).toBe(2);
  });
  it("streams large output and stops a producer when the disk reserve is reached", async () => {
    let checks = 0;
    const file = output();
    const program =
      'import {once} from "node:events"; const chunk=Buffer.alloc(65536,120); for(let n=0;n<2048;n++){ if(!process.stdout.write(chunk)) await once(process.stdout,"drain"); } setInterval(()=>{},1000);';
    await expect(
      run(program, file, { readFreeBytes: () => (++checks === 1 ? 100n : 0n) })
    ).rejects.toThrow("Backup failed");
    expect(checks).toBe(2);
    expect(fs.statSync(file).size).toBeLessThan(128 * 1024 * 1024);
  }, 15000);
});
