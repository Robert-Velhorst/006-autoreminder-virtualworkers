import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  rm,
  appendFile,
  rename,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openVerifiedBackup,
  backupVerifier,
  assertEventDisabledServer,
  restoreClientArguments,
  restoreClientEnvironment,
  importVerifiedBackup,
} from "./pilot-backup-restore.mjs";

const folders = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
const hash = value => createHash("sha256").update(value).digest("hex");
const content = Buffer.from(
  "CREATE TABLE example (id int);\n-- Dump completed on 2026-10-01 00:00:00\n"
);
const manifestFor = data => ({
  sqlFile: "backup.sql",
  bytes: data.length,
  sha256: hash(data),
});
async function fixture(data = content, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "va-pilot-backup-"));
  folders.push(root);
  const manifest = { ...manifestFor(data), ...changes };
  const file = path.join(root, "backup.sql");
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(file, data);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, file, manifestPath, manifest };
}
const discard = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

describe("bounded SQL backup validation", () => {
  it("verifies and rereads the same open file in bounded chunks", async () => {
    const f = await fixture();
    const backup = await openVerifiedBackup(f.root, f.manifestPath);
    try {
      expect(backup.manifest).toEqual(f.manifest);
      expect(Object.isFrozen(backup.manifest)).toBe(true);
      for (let pass = 0; pass < 2; pass++) {
        const chunks = [];
        for await (const chunk of backup.stream()) chunks.push(chunk);
        expect(Buffer.concat(chunks)).toEqual(content);
      }
      await backup.checkUnchanged();
    } finally {
      await backup.close();
    }
  });

  it.each([
    { bytes: content.length + 1 },
    { bytes: -1 },
    { bytes: 0 },
    { bytes: 1.5 },
    { bytes: "100" },
    { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: "x".repeat(64) },
    { sha256: "A".repeat(64) },
    { sha256: null },
    { sqlFile: "../backup.sql" },
    { sqlFile: "..\\backup.sql" },
    { sqlFile: "/backup.sql" },
    { sqlFile: "C:backup.sql" },
    { sqlFile: "backup.sql:secret" },
    { sqlFile: "file.txt" },
    { sqlFile: null },
  ])("rejects invalid manifest fields or recorded sizes: %j", async changes => {
    const f = await fixture(content, changes);
    await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow();
  });

  it("rejects a different hash without exposing backup contents", async () => {
    const f = await fixture(content, { sha256: "0".repeat(64) });
    await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow(
      "Backup hash mismatch"
    );
  });

  it("rejects missing completion markers even with a matching digest", async () => {
    const f = await fixture(Buffer.from("private SQL payload"));
    await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow(
      "completion marker missing"
    );
  });

  it("rejects oversized manifests before parsing", async () => {
    const f = await fixture();
    await writeFile(f.manifestPath, " ".repeat(65537));
    await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow(
      "Invalid backup manifest file"
    );
  });

  it("rejects malformed JSON with a redacted error", async () => {
    const f = await fixture();
    await writeFile(f.manifestPath, '{"credential":"PRIVATE');
    await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow(
      /^Invalid backup manifest JSON$/
    );
  });

  it("rejects a manifest outside the pilot directory", async () => {
    const f = await fixture();
    await expect(
      openVerifiedBackup(path.join(f.root, "other"), f.manifestPath)
    ).rejects.toThrow();
    await mkdir(path.join(f.root, "nested"));
    await expect(
      openVerifiedBackup(path.join(f.root, "nested"), f.manifestPath)
    ).rejects.toThrow("under .local/pilot");
  });

  it("rejects manifest and SQL paths escaping through a directory link", async () => {
    const f = await fixture();
    const outside = await fixture();
    const link = path.join(f.root, "outside");
    await symlink(
      outside.root,
      link,
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(
      openVerifiedBackup(f.root, path.join(link, "manifest.json"))
    ).rejects.toThrow("escapes");
    if (process.platform !== "win32") {
      await rename(f.file, path.join(f.root, "original.sql"));
      await symlink(outside.file, f.file);
      await expect(openVerifiedBackup(f.root, f.manifestPath)).rejects.toThrow(
        "escapes"
      );
    }
  });

  it("detects in-place changes before importing", async () => {
    const f = await fixture();
    const backup = await openVerifiedBackup(f.root, f.manifestPath);
    try {
      await appendFile(f.file, "\nextra");
      await expect(backup.checkUnchanged()).rejects.toThrow(
        "changed during restore"
      );
    } finally {
      await backup.close();
    }
  });

  it("does not follow a replacement path during the second read", async () => {
    const f = await fixture();
    const backup = await openVerifiedBackup(f.root, f.manifestPath);
    try {
      await rename(f.file, path.join(f.root, "retained.sql"));
      await writeFile(f.file, "different SQL");
      const chunks = [];
      for await (const chunk of backup.stream()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(content);
    } finally {
      await backup.close();
    }
  });

  it("checks completion markers split across every byte boundary", async () => {
    await pipeline(
      Readable.from([...content].map(byte => Buffer.from([byte]))),
      backupVerifier(manifestFor(content)),
      discard()
    );
  });

  it("streams 64 MiB without building a combined payload", async () => {
    const chunk = Buffer.alloc(64 * 1024, 120);
    const tail = Buffer.from("\n-- Dump completed on 2026-10-01\n");
    const digest = createHash("sha256");
    for (let index = 0; index < 1024; index++) digest.update(chunk);
    digest.update(tail);
    async function* chunks() {
      for (let index = 0; index < 1024; index++) yield chunk;
      yield tail;
    }
    await pipeline(
      Readable.from(chunks()),
      backupVerifier({
        bytes: 1024 * chunk.length + tail.length,
        sha256: digest.digest("hex"),
      }),
      discard()
    );
  });

  it("propagates failed streams rather than issuing a successful hash", async () => {
    async function* chunks() {
      yield content.subarray(0, 10);
      throw new Error("Read failed");
    }
    await expect(
      pipeline(
        Readable.from(chunks()),
        backupVerifier(manifestFor(content)),
        discard()
      )
    ).rejects.toThrow("Read failed");
  });
});

describe("event-disabled restore boundary", () => {
  const grant = [
    [{ grant: "GRANT ALL PRIVILEGES ON *.* TO 'fixture'@'localhost'" }],
  ];
  const db = (scheduler, port = 33317, count = 0) => ({
    query: vi
      .fn()
      .mockResolvedValueOnce([[{ scheduler, port }]])
      .mockResolvedValueOnce(grant)
      .mockResolvedValueOnce([[{ count }]]),
  });
  it.each(["ON", "OFF", null, undefined])(
    "rejects scheduler %s before inspecting events",
    async scheduler => {
      const connection = db(scheduler);
      await expect(
        assertEventDisabledServer(connection, 33317)
      ).rejects.toThrow("DISABLED at startup");
      expect(connection.query).toHaveBeenCalledTimes(1);
    }
  );
  it("rejects a server on a different actual port", async () => {
    await expect(
      assertEventDisabledServer(db("DISABLED", 3306), 33317)
    ).rejects.toThrow("isolated native server");
  });
  it("accepts only DISABLED with zero defined events", async () => {
    await assertEventDisabledServer(db("DISABLED"), 33317);
  });
  it("rejects any retained event without deleting it", async () => {
    const connection = db("DISABLED", 33317, 1);
    await expect(assertEventDisabledServer(connection, 33317)).rejects.toThrow(
      "separate review"
    );
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query.mock.calls[2][0].sql).toBe(
      "SELECT COUNT(*) AS count FROM information_schema.EVENTS"
    );
  });
  it("does not treat a failed event inventory as empty", async () => {
    const connection = db("DISABLED");
    connection.query
      .mockReset()
      .mockResolvedValueOnce([[{ scheduler: "DISABLED", port: 33317 }]])
      .mockResolvedValueOnce(grant)
      .mockRejectedValueOnce(new Error("Permission denied"));
    await expect(assertEventDisabledServer(connection, 33317)).rejects.toThrow(
      "Permission denied"
    );
  });
  it("rejects incomplete event visibility instead of mistaking hidden events for zero", async () => {
    const connection = {
      query: vi
        .fn()
        .mockResolvedValueOnce([[{ scheduler: "DISABLED", port: 33317 }]])
        .mockResolvedValueOnce([
          [
            {
              grant:
                "GRANT SELECT ON `recovery_test`.* TO 'fixture'@'localhost'",
            },
          ],
        ]),
    };
    await expect(assertEventDisabledServer(connection, 33317)).rejects.toThrow(
      "complete event visibility"
    );
    expect(connection.query).toHaveBeenCalledTimes(2);
  });
  it("accepts MySQL 8.4's expanded global EVENT grant", async () => {
    const connection = {
      query: vi
        .fn()
        .mockResolvedValueOnce([[{ scheduler: "DISABLED", port: 33317 }]])
        .mockResolvedValueOnce([
          [
            {
              grant:
                "GRANT SELECT, CREATE, EVENT, TRIGGER ON *.* TO 'fixture'@'localhost'",
            },
          ],
        ])
        .mockResolvedValueOnce([[{ count: 0 }]]),
    };
    await assertEventDisabledServer(connection, 33317);
  });
  it("disables native client commands, login files, reconnection and local file loading", () => {
    const args = restoreClientArguments(
      "rehearsal",
      "aptlss_pilot_rehearsal",
      33317
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-defaults",
        "--no-login-paths",
        "--binary-mode",
        "--batch",
        "--skip-reconnect",
        "--local-infile=0",
        "--connect-timeout=10",
      ])
    );
    expect(args.some(arg => arg.startsWith("--password"))).toBe(false);
    expect(args).not.toContain("--force");
    expect(
      restoreClientEnvironment("fixture-password", {
        PATH: "safe",
        OPENAI_API_KEY: "excluded",
        MYSQL_TEST_LOGIN_FILE: "excluded",
      })
    ).toEqual({ PATH: "safe", MYSQL_PWD: "fixture-password" });
  });
});

describe("bounded restore child lifecycle", () => {
  async function run(
    script,
    { data = content, manifest, timeoutMs = 5000, checkResources } = {}
  ) {
    const backup = {
      checkUnchanged: vi.fn().mockResolvedValue(undefined),
      stream: () => Readable.from([data]),
      manifest: manifest || manifestFor(data),
    };
    await importVerifiedBackup(
      backup,
      process.execPath,
      ["-e", script],
      restoreClientEnvironment("fixture"),
      { timeoutMs, checkResources }
    );
    return backup;
  }
  it("accepts a fully consumed, verified import and checks file identity twice", async () => {
    const backup = await run(
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'
    );
    expect(backup.checkUnchanged).toHaveBeenCalledTimes(2);
  });
  it("checks resources before, during and after a successful import", async () => {
    const checkResources = vi.fn();
    await run(
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
      { checkResources }
    );
    expect(checkResources.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("rejects a resource shortage before checking the file or spawning a client", async () => {
    const checkUnchanged = vi.fn();
    await expect(
      importVerifiedBackup(
        { checkUnchanged },
        "missing",
        [],
        {},
        {
          checkResources: () => {
            throw new Error("Reserve reached");
          },
        }
      )
    ).rejects.toThrow("Reserve reached");
    expect(checkUnchanged).not.toHaveBeenCalled();
  });
  it.each([null, false, "guard"])(
    "rejects an invalid resource guard %s",
    async checkResources => {
      await expect(
        importVerifiedBackup({}, "missing", [], {}, { checkResources })
      ).rejects.toThrow("Invalid restore resource guard");
    }
  );
  it("terminates the client when resources fail during streaming", async () => {
    let calls = 0;
    await expect(
      run("process.stdin.resume(); setInterval(() => {}, 1000);", {
        checkResources: () => {
          if (++calls > 1) throw new Error("PRIVATE resource diagnostic");
        },
      })
    ).rejects.toThrow(
      /^Restore failed; diagnostic bytes: \d+; the isolated database is retained$/
    );
    expect(calls).toBe(2);
  });
  it("monitors resources even after SQL input has ended", async () => {
    let calls = 0;
    await expect(
      run("process.stdin.resume(); setInterval(() => {}, 1000);", {
        checkResources: () => {
          if (++calls > 2) throw new Error("PRIVATE resource diagnostic");
        },
      })
    ).rejects.toThrow(
      /^Restore resource guard failed; the isolated database is retained for inspection$/
    );
    expect(calls).toBe(3);
  });
  it("rejects and terminates a client after a byte mismatch", async () => {
    await expect(
      run("process.stdin.resume(); setInterval(() => {}, 1000);", {
        manifest: { ...manifestFor(content), bytes: content.length - 1 },
      })
    ).rejects.toThrow("Restore failed");
  });
  it("redacts private client diagnostics on a failing exit", async () => {
    await expect(
      run(
        'process.stderr.write("PRIVATE SQL"); process.stdin.resume(); process.stdin.on("end", () => process.exit(2));'
      )
    ).rejects.toThrow(/^Restore failed; diagnostic bytes: 11;/);
  });
  it("kills a client that stays alive after consuming input", async () => {
    await expect(
      run("process.stdin.resume(); setInterval(() => {}, 1000);", {
        timeoutMs: 200,
      })
    ).rejects.toThrow("Restore timed out");
  });
  it("handles a missing executable without exposing environment values", async () => {
    const backup = {
      checkUnchanged: async () => {},
      stream: () => Readable.from([content]),
      manifest: manifestFor(content),
    };
    await expect(
      importVerifiedBackup(
        backup,
        path.join(os.tmpdir(), "nonexistent-va-mysql-client"),
        [],
        {},
        { timeoutMs: 1000 }
      )
    ).rejects.toThrow("could not start");
  });
  it("kills a spawned client if creating the input stream fails", async () => {
    const backup = {
      checkUnchanged: async () => {},
      stream: () => {
        throw new Error("Input failed");
      },
      manifest: manifestFor(content),
    };
    await expect(
      importVerifiedBackup(
        backup,
        process.execPath,
        ["-e", "setInterval(() => {}, 1000);"],
        {},
        { timeoutMs: 1000 }
      )
    ).rejects.toThrow("Input failed");
  });
  it.each([0, -1, Infinity, 3600001])(
    "rejects invalid timeout %s before opening a child",
    async timeoutMs => {
      await expect(
        importVerifiedBackup({}, "missing", [], {}, { timeoutMs })
      ).rejects.toThrow("Restore timeout");
    }
  );
});
