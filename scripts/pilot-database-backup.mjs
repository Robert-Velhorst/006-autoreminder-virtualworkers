import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const COMPLETION = /-- Dump completed on [^\r\n]+\r?\n?$/;
const SPACE_CHECK_INTERVAL = 64 * 1024 * 1024;

export function nativeBackupArguments(config) {
  const port = Number(config.MYSQL_PORT || 3307);
  if (
    port !== 3307 ||
    config.MYSQL_DATABASE !== "joyce_work_schedule_consolidated"
  )
    throw new Error(
      "Backup requires the established loopback operational database"
    );
  if (
    typeof config.MYSQL_ROOT_PASSWORD !== "string" ||
    !config.MYSQL_ROOT_PASSWORD
  )
    throw new Error("Operational backup credentials are missing");
  return [
    "--no-defaults",
    "--no-login-paths",
    "--protocol=TCP",
    "--host=127.0.0.1",
    `--port=${port}`,
    "--user=root",
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--default-character-set=utf8mb4",
    "--tz-utc",
    "--max-allowed-packet=1G",
    config.MYSQL_DATABASE,
  ];
}

export function freeDiskBytes(directory) {
  const stat = fs.statfsSync(directory, { bigint: true });
  return stat.bavail * stat.bsize;
}

export async function createSqlBackup(
  executable,
  args,
  env,
  file,
  {
    timeoutMs = 3600000,
    reserveBytes = 12n * 1024n ** 3n,
    readFreeBytes = freeDiskBytes,
    onProgress = () => {},
  } = {}
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
    throw new Error("Backup timeout must be between 1 millisecond and 1 hour");
  if (typeof reserveBytes !== "bigint" || reserveBytes < 0n)
    throw new Error("Backup disk reserve must be a nonnegative bigint");
  const directory = path.dirname(file);
  const checkSpace = () => {
    if (readFreeBytes(directory) <= reserveBytes)
      throw new Error("Backup disk reserve reached; incomplete file retained");
  };
  checkSpace();
  // Exclusive creation occurs before the process starts; never overwrite a backup.
  const fd = fs.openSync(file, "wx");
  const started = Date.now();
  let child;
  let closed;
  let timer;
  let timedOut = false;
  let stderrBytes = 0;
  let spawnFailed = false;
  let output;
  try {
    child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", data => {
      stderrBytes += data.length;
    });
    child.once("error", () => {
      spawnFailed = true;
    });
    closed = new Promise(resolve => child.once("close", code => resolve(code)));
    const abort = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      child.kill("SIGKILL");
    }, timeoutMs);
    const digest = createHash("sha256");
    let bytes = 0;
    let lastCheck = 0;
    let tail = Buffer.alloc(0);
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          bytes += chunk.length;
          digest.update(chunk);
          tail = Buffer.concat([
            tail,
            chunk.subarray(Math.max(0, chunk.length - 8192)),
          ]).subarray(-8192);
          if (bytes - lastCheck >= SPACE_CHECK_INTERVAL) {
            checkSpace();
            lastCheck = bytes;
            onProgress({ bytes, elapsedMs: Date.now() - started });
          }
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    let streamFailed = false;
    try {
      output = fs.createWriteStream(file, { fd, autoClose: false });
      await pipeline(child.stdout, verifier, output, { signal: abort.signal });
    } catch {
      streamFailed = true;
      child.kill("SIGKILL");
    }
    const code = await closed;
    if (timedOut) throw new Error("Backup timed out; incomplete file retained");
    if (spawnFailed) throw new Error("Backup client could not start");
    if (streamFailed || code !== 0)
      throw new Error(
        `Backup failed; diagnostic bytes: ${stderrBytes}; incomplete file retained`
      );
    if (bytes < 1000 || !COMPLETION.test(tail.toString("utf8")))
      throw new Error("Incomplete SQL backup; completion marker missing");
    checkSpace();
    fs.fsyncSync(fd);
    return {
      bytes,
      sha256: digest.digest("hex"),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    if (child) {
      child.kill("SIGKILL");
      await closed;
    }
    // pipeline destroys the writer on failure, which closes its descriptor even
    // with autoClose disabled. Do not close a reused descriptor a second time.
    if (!output || output.fd === fd) fs.closeSync(fd);
  }
}
