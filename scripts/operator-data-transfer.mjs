import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  TRANSFER_EXPORT_FORMAT, redactSensitiveSettings, sourceIdentity, transferIdentity, transferOperatorRecords,
} from "./operator-data-transfer-utils.mjs";

export const TABLES = [
  { name: "app_settings", keys: ["key"] },
  { name: "aptlss_plans", keys: ["vaId", "cardId"] },
  { name: "aptlss_steps", keys: ["id"] },
  { name: "card_states", keys: ["vaId", "cardId"] },
  { name: "priority_scores", keys: ["vaId", "cardId"] },
  { name: "daily_plans", keys: ["vaId", "dateKey"] },
  { name: "aptlss_audit_log", keys: ["id"] },
  { name: "daily_compliance_snapshots", keys: ["vaId", "snapshotDate"] },
  { name: "time_entries", keys: ["id"] },
  { name: "aptlss_assessments", keys: ["id"] },
  { name: "aptlss_assessment_feedback", keys: ["assessmentId"] },
  { name: "aptlss_waiting_reasons", keys: ["id"] },
  { name: "decision_outcomes", keys: ["stepId"] },
  { name: "workspace_evidence_items", keys: ["vaId", "source", "sourceId"] },
  { name: "workspace_evidence_links", keys: ["evidenceId", "cardId"] },
  { name: "communication_evidence", keys: ["vaId", "channel", "externalId"] },
  { name: "compliance_card_evidence", keys: ["vaId", "snapshotDate", "cardId"] },
  { name: "compliance_communication_evidence", keys: ["vaId", "snapshotDate", "evidenceKey"] },
  { name: "compliance_clarification_requests", keys: ["vaId", "snapshotDate", "evidenceKey"] },
  { name: "time_day_reviews", keys: ["dateKey"] },
  { name: "time_entry_events", keys: ["id"] },
  { name: "time_reconciliation_items", keys: ["fingerprint"] },
  { name: "scheduled_job_runs", keys: ["id"] },
  { name: "scheduled_job_leases", keys: ["jobKey"] },
  { name: "browser_tab_states", keys: ["collectorId"] },
  { name: "browser_tab_daily_evidence", keys: ["vaId", "snapshotDate"] },
];

export function parseTransferArguments(argv, env = {}) {
  const command = argv[0];
  if (!["export", "import", "reconcile"].includes(command)) {
    throw new Error("Usage: operator-data-transfer.mjs <export|import|reconcile> [options]");
  }
  const options = { command, execute: false, dryRun: false, acknowledgeCredentialOmissions: false };
  const names = command === "export" ? ["--source", "--out"] : ["--target", "--in", "--worker-user-id", "--founder-user-id", "--worker-profile-id"];
  const seen = new Set();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error("Duplicate transfer option");
    seen.add(flag);
    if (command !== "export" && flag === "--acknowledge-credential-omissions") {
      options.acknowledgeCredentialOmissions = true;
    } else if (command === "import" && ["--execute", "--dry-run"].includes(flag)) {
      options[flag === "--execute" ? "execute" : "dryRun"] = true;
    } else {
      if (!names.includes(flag) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("Invalid transfer option or missing value");
      }
      options[flag.slice(2)] = argv[++index];
    }
  }
  if (options.execute && options.dryRun) throw new Error("--execute and --dry-run are mutually exclusive");
  options.source ??= env.LEGACY_MYSQL_DATABASE_URL;
  options.target ??= env.TARGET_DATABASE_URL;
  if (command !== "export") {
    options.identity = transferIdentity(
      options["worker-user-id"], options["founder-user-id"], options["worker-profile-id"],
    );
  }
  return options;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function verifyExport(payload) {
  if (payload.format !== TRANSFER_EXPORT_FORMAT) throw new Error("Unsupported export format; re-export with explicit user/profile identities");
  const { digest: supplied, ...contents } = payload;
  if (typeof supplied !== "string" || supplied !== digest(contents)) throw new Error("Export digest verification failed");
  return payload;
}

async function connectTarget(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL target connection URL is required");
  if (process.env.NODE_ENV === "production" && (url.searchParams.getAll("sslmode").length !== 1
    || url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.has("ssl"))) {
    throw new Error("Production PostgreSQL targets require sslmode=verify-full with no ssl override");
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: value, connectionTimeoutMillis: 10000,
    // Keep date and timestamp-without-time-zone comparisons independent of host timezone.
    types: { getTypeParser: (oid, format) => [1082, 1114].includes(oid) && format !== "binary"
      ? value => value : pg.types.getTypeParser(oid, format) },
  });
  await client.connect();
  return client;
}

export async function exportOperatorData(connection, output, files = { mkdir, writeFile }) {
  await connection.query("SET SESSION time_zone = '+00:00'");
  await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  try {
    const datasets = {};
    const skipped = [];
    const counts = {};
    let credentialOmissions = [];
    for (const table of TABLES) {
      const [exists] = await connection.query(
        "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table.name]);
      if (Number(exists[0]?.count ?? 0) !== 1) {
        skipped.push(table.name);
        continue;
      }
      const [rows] = await connection.query("SELECT * FROM \x60" + table.name + "\x60");
      counts[table.name] = rows.length;
      if (table.name === "app_settings") {
        const redacted = redactSensitiveSettings(rows);
        datasets[table.name] = redacted.rows;
        credentialOmissions = redacted.credentialOmissions;
      } else datasets[table.name] = rows;
    }
    const [profiles] = await connection.query(
      "SELECT p.id AS workerProfileId, p.userId AS workerUserId, p.founderId AS founderUserId, p.trelloMemberId AS trelloMemberId, "
      + "u.openId AS workerOpenId, f.openId AS founderOpenId "
      + "FROM va_profiles p LEFT JOIN users u ON u.id = p.userId LEFT JOIN users f ON f.id = p.founderId");
    const payload = {
      format: TRANSFER_EXPORT_FORMAT, createdAt: new Date().toISOString(), tables: datasets, skipped,
      identities: profiles.map(sourceIdentity), counts, credentialOmissions,
    };
    payload.digest = digest(payload);
    await connection.query("COMMIT");
    await files.mkdir(path.dirname(output), { recursive: true });
    // Never replace a retained source export or backup.
    await files.writeFile(output, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { success: skipped.length === 0 && credentialOmissions.length === 0, exportWritten: true,
      completion: credentialOmissions.length ? "private-credential-restoration-required" : skipped.length ? "incomplete" : "complete",
      output, counts: payload.counts, skipped, credentialOmissions };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}

async function run(options) {
  if (options.command === "export") {
    if (!options.source?.startsWith("mysql://")) throw new Error("A MySQL source connection URL is required");
    const { default: mysql } = await import("mysql2/promise");
    const connection = await mysql.createConnection({
      uri: options.source, dateStrings: true, multipleStatements: false,
      supportBigNumbers: true, bigNumberStrings: true,
    });
    try {
      const report = await exportOperatorData(connection, path.resolve(options.out ?? ".local/operator-export.json"));
      console.log(JSON.stringify(report, null, 2));
      if (!report.success) process.exitCode = 2;
    } finally {
      await connection.end();
    }
    return;
  }
  const input = path.resolve(options.in ?? ".local/operator-export.json");
  const payload = verifyExport(JSON.parse(await readFile(input, "utf8")));
  const connection = await connectTarget(options.target);
  try {
    const report = await transferOperatorRecords(connection, payload, TABLES, {
      identity: options.identity, execute: options.execute, reconcile: options.command === "reconcile",
      acknowledgeCredentialOmissions: options.acknowledgeCredentialOmissions,
    });
    console.log(JSON.stringify({ input, ...report }, null, 2));
    if (!report.success) process.exitCode = 2;
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await import("dotenv/config");
    await run(parseTransferArguments(process.argv.slice(2), process.env));
  } catch {
    // Driver errors and arguments may include credentials or private row content.
    console.error("Operator transfer failed: verify the source identity, worker/founder IDs, schema and keyed content. No successful transfer or reconciliation is claimed.");
    process.exitCode = 1;
  }
}
