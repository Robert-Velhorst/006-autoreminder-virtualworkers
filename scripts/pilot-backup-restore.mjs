import fs from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const CHUNK_SIZE = 64 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
const COMPLETION = /-- Dump completed on [^\r\n]+\r?\n?$/;

function contained(root, file) {
  const relative = path.relative(root, file);
  return (
    relative &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function sameFile(before, after) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    key => before[key] === after[key]
  );
}

function validateTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 3600000
  ) {
    throw new Error("Restore timeout must be between 1 millisecond and 1 hour");
  }
}

export function backupVerifier(manifest, { checkResources = () => {} } = {}) {
  if (typeof checkResources !== "function")
    throw new Error("Invalid restore resource guard");
  const digest = createHash("sha256");
  let bytes = 0;
  let tail = Buffer.alloc(0);
  let nextResourceCheck = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (bytes >= nextResourceCheck) {
        try {
          checkResources();
        } catch (error) {
          return callback(error);
        }
        nextResourceCheck = bytes + 64 * 1024 * 1024;
      }
      bytes += chunk.length;
      if (bytes > manifest.bytes)
        return callback(new Error("Backup byte count mismatch"));
      digest.update(chunk);
      tail = Buffer.concat([
        tail,
        chunk.subarray(Math.max(0, chunk.length - 8192)),
      ]).subarray(-8192);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== manifest.bytes)
        return callback(new Error("Backup byte count mismatch"));
      if (digest.digest("hex") !== manifest.sha256)
        return callback(new Error("Backup hash mismatch"));
      if (!COMPLETION.test(tail.toString("utf8")))
        return callback(new Error("Backup completion marker missing"));
      callback();
    },
  });
}

export async function openVerifiedBackup(
  rootPath,
  manifestPath,
  { timeoutMs = 600000 } = {}
) {
  validateTimeout(timeoutMs);
  const root = await realpath(rootPath);
  const requested = path.resolve(manifestPath);
  if (!contained(path.resolve(rootPath), requested))
    throw new Error("Backup manifest must be under .local/pilot");
  const resolvedManifest = await realpath(requested);
  if (!contained(root, resolvedManifest))
    throw new Error("Backup manifest escapes the pilot directory");
  const manifestFile = await open(resolvedManifest, "r");
  let manifest;
  try {
    const info = await manifestFile.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.size > BigInt(MANIFEST_LIMIT) ||
      (await realpath(requested)) !== resolvedManifest ||
      !sameFile(info, await stat(resolvedManifest, { bigint: true }))
    )
      throw new Error("Invalid backup manifest file");
    const buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
    const { bytesRead } = await manifestFile.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MANIFEST_LIMIT)
      throw new Error("Backup manifest exceeds size limit");
    try {
      manifest = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("Invalid backup manifest JSON");
    }
    if (!sameFile(info, await manifestFile.stat({ bigint: true })))
      throw new Error("Backup manifest changed while reading");
  } finally {
    await manifestFile.close();
  }
  if (
    !manifest ||
    typeof manifest.sqlFile !== "string" ||
    path.basename(manifest.sqlFile) !== manifest.sqlFile ||
    /[\\/\0:]/.test(manifest.sqlFile) ||
    !manifest.sqlFile.endsWith(".sql") ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("Invalid backup manifest fields");
  }
  manifest = Object.freeze({
    sqlFile: manifest.sqlFile,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
  });
  const backupPath = path.join(root, manifest.sqlFile);
  const resolvedBackup = await realpath(backupPath);
  if (path.dirname(resolvedBackup) !== root)
    throw new Error("Backup file escapes the pilot directory");
  const file = await open(resolvedBackup, "r");
  try {
    const initial = await file.stat({ bigint: true });
    if (
      !initial.isFile() ||
      initial.size !== BigInt(manifest.bytes) ||
      (await realpath(backupPath)) !== resolvedBackup ||
      !sameFile(initial, await stat(resolvedBackup, { bigint: true }))
    ) {
      throw new Error("Backup file identity or size changed");
    }
    // Keep the same open descriptor for both passes; replacing its path cannot
    // redirect the import. A second digest also detects in-place modifications.
    const stream = () =>
      fs.createReadStream(resolvedBackup, {
        fd: file.fd,
        autoClose: false,
        start: 0,
        highWaterMark: CHUNK_SIZE,
      });
    const checkUnchanged = async () => {
      if (!sameFile(initial, await file.stat({ bigint: true })))
        throw new Error("Backup changed during restore");
    };
    const verifier = backupVerifier(manifest);
    verifier.resume();
    await pipeline(stream(), verifier, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await checkUnchanged();
    return { manifest, stream, checkUnchanged, close: () => file.close() };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function assertEventDisabledServer(db, expectedPort) {
  const [rows] = await db.query({
    sql: "SELECT @@port AS port, @@GLOBAL.event_scheduler AS scheduler",
    timeout: 10000,
  });
  if (
    Number(rows[0]?.port) !== expectedPort ||
    rows[0]?.scheduler !== "DISABLED"
  ) {
    throw new Error(
      "Restore requires the isolated native server with event_scheduler=DISABLED at startup"
    );
  }
  const [grants] = await db.query({
    sql: "SHOW GRANTS FOR CURRENT_USER",
    timeout: 10000,
  });
  if (
    !grants.some(row =>
      Object.values(row).some(value => {
        const global = /^GRANT (.+) ON \*\.\* TO /i.exec(String(value));
        return global?.[1]
          .split(",")
          .some(privilege =>
            ["ALL PRIVILEGES", "EVENT"].includes(privilege.trim().toUpperCase())
          );
      })
    )
  ) {
    throw new Error(
      "Restore inspection requires the isolated administrator's complete event visibility"
    );
  }
  const [events] = await db.query({
    sql: "SELECT COUNT(*) AS count FROM information_schema.EVENTS",
    timeout: 10000,
  });
  if (Number(events[0]?.count) !== 0) {
    throw new Error(
      "Database events require separate review; restore is not accepted and the isolated database is retained"
    );
  }
}

export function restoreClientArguments(user, database, port) {
  return [
    "--no-defaults",
    "--no-login-paths",
    "--binary-mode",
    "--batch",
    "--skip-reconnect",
    "--local-infile=0",
    "--default-character-set=utf8mb4",
    "--connect-timeout=10",
    "--max-allowed-packet=1G",
    "--protocol=TCP",
    "--host=127.0.0.1",
    `--port=${port}`,
    `--user=${user}`,
    `--database=${database}`,
  ];
}

export function restoreClientEnvironment(password, source = process.env) {
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, MYSQL_PWD: password };
}

export async function importVerifiedBackup(
  backup,
  executable,
  args,
  env,
  { timeoutMs = 1800000, checkResources = () => {} } = {}
) {
  validateTimeout(timeoutMs);
  if (typeof checkResources !== "function")
    throw new Error("Invalid restore resource guard");
  checkResources();
  await backup.checkUnchanged();
  const child = spawn(executable, args, {
    env,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderrBytes = 0;
  let timedOut = false;
  child.stderr.on("data", bytes => {
    stderrBytes += bytes.length;
  });
  const closed = new Promise(resolve => {
    child.once("error", () => resolve({ spawnFailed: true }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const abort = new AbortController();
  let resourceFailed = false;
  // Backpressure can stall the SQL stream while the server is still writing.
  const resourceTimer = setInterval(() => {
    try {
      checkResources();
    } catch {
      resourceFailed = true;
      abort.abort();
      child.kill("SIGKILL");
    }
  }, 1000);
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const input = await pipeline(
      backup.stream(),
      backupVerifier(backup.manifest, { checkResources }),
      child.stdin,
      { signal: abort.signal }
    ).then(
      () => ({ passed: true }),
      () => {
        child.kill("SIGKILL");
        return { passed: false };
      }
    );
    const exit = await closed;
    if (resourceFailed)
      throw new Error(
        "Restore resource guard failed; the isolated database is retained for inspection"
      );
    if (timedOut)
      throw new Error(
        "Restore timed out; the isolated database is retained for inspection"
      );
    if (exit.spawnFailed) throw new Error("Restore client could not start");
    if (!input.passed || exit.code !== 0)
      throw new Error(
        `Restore failed; diagnostic bytes: ${stderrBytes}; the isolated database is retained`
      );
    await backup.checkUnchanged();
    checkResources();
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(resourceTimer);
  }
}
