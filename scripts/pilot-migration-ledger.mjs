import fs from "node:fs";
import path from "node:path";

export function readRehearsalMigrationLedger(root, sourceManifest) {
  const directory = fs.realpathSync(path.join(root, ".local/pilot"));
  if (
    sourceManifest !== undefined &&
    (typeof sourceManifest !== "string" ||
      !/^backup-[0-9TZ-]+\.json$/.test(sourceManifest))
  )
    throw new Error("Rehearsal source must be a backup manifest basename");
  const file = fs.realpathSync(
    path.join(directory, sourceManifest || "applied-migrations.json")
  );
  if (path.dirname(file) !== directory)
    throw new Error("Migration ledger escapes the private pilot directory");
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error("Migration ledger exceeds its bounded file size");
    const buffer = Buffer.alloc(65537);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 65536)
      throw new Error("Migration ledger exceeds its bounded file size");
    let value;
    try {
      value = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    } catch {
      throw new Error("Invalid migration ledger JSON");
    }
    const ledger =
      sourceManifest === undefined ? value : value?.sourceMigrations;
    if (!Array.isArray(ledger) || ledger.length === 0 || ledger.length > 1000)
      throw new Error("Captured source migration ledger is missing");
    let previous = -1;
    return ledger.map(entry => {
      const created_at = Number(entry?.created_at);
      if (
        !entry ||
        typeof entry.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !["number", "string"].includes(typeof entry.created_at) ||
        (typeof entry.created_at === "string" &&
          !/^[0-9]+$/.test(entry.created_at)) ||
        !Number.isSafeInteger(created_at) ||
        created_at < 0 ||
        created_at <= previous
      )
        throw new Error("Invalid or non-monotonic captured migration identity");
      previous = created_at;
      return { hash: entry.hash, created_at };
    });
  } finally {
    fs.closeSync(fd);
  }
}
