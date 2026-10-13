import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identifier(value) {
  if (typeof value !== "string" || !value.length || value.includes("\0"))
    throw new Error("Invalid record fingerprint identifier");
  return "`" + value.replaceAll("`", "``") + "`";
}

function selectedColumns(columns) {
  if (
    !Array.isArray(columns) ||
    !columns.length ||
    new Set(columns).size !== columns.length
  )
    throw new Error("Record fingerprint columns must be nonempty and unique");
  columns.forEach(identifier);
  return [...columns];
}

export async function fingerprintRecords(rows, selected) {
  const columns = selectedColumns(selected);
  return {
    columns,
    ...(await fingerprintSerializedRecords(rows, row => {
      if (
        !row ||
        typeof row !== "object" ||
        columns.some(column => !Object.hasOwn(row, column))
      )
        throw new Error("Record fingerprint row is missing a selected column");
      return JSON.stringify(columns.map(column => row[column]));
    })),
  };
}

async function fingerprintSerializedRecords(rows, serialize) {
  // Preserve the existing order-independent manifest exactly. Retain only one
  // digest per record, never the source payloads or a whole table of snapshots.
  const digests = [];
  for await (const row of rows) {
    digests.push(hash(serialize(row)));
  }
  digests.sort();
  const combined = createHash("sha256");
  for (let index = 0; index < digests.length; index++) {
    if (index) combined.update("\n");
    combined.update(digests[index]);
  }
  return { count: digests.length, hash: combined.digest("hex") };
}

// The native migration rehearsal historically hashes row objects, not arrays.
// Keep that distinct format intact while removing its whole-table buffer.
export function fingerprintWholeTable(connection, table) {
  return fingerprintSerializedRecords(
    connection
      .query(`SELECT * FROM ${identifier(table)}`)
      .stream({ highWaterMark: 1 }),
    row => JSON.stringify(row)
  );
}

export function fingerprintTable(connection, table, selected) {
  const columns = selectedColumns(selected);
  const query = `SELECT ${columns.map(identifier).join(",")} FROM ${identifier(table)}`;
  return fingerprintRecords(
    connection.query(query).stream({ highWaterMark: 1 }),
    columns
  );
}
