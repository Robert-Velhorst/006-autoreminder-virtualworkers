function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
    throw new Error("Invalid generated-record verification identifier");
  return "`" + value + "`";
}

// Expressions come from the checked-in canonical schema, never external input.
export async function verifyGeneratedRecords(connection, table, columns, index) {
  const tableSql = identifier(table);
  const indexSql = identifier(index);
  if (!Array.isArray(columns) || !columns.length ||
    new Set(columns.map(column => column.name)).size !== columns.length)
    throw new Error("Generated columns must be nonempty and unique");
  for (const column of columns) {
    identifier(column.name);
    if (typeof column.expression !== "string" || !column.expression.trim())
      throw new Error("A canonical generated expression is required");
  }
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.beginTransaction();
  try {
    const [[inventory]] = await connection.query(`SELECT COUNT(*) AS total FROM ${tableSql}`);
    const expected = Number(inventory.total);
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw new Error("Invalid generated-record inventory");
    let checked = 0;
    let lastId = 0;
    const fields = columns.map(column => identifier(column.name)).join(", ");
    const comparisons = columns.map((column, i) =>
      `COALESCE(SUM(NOT (cached.${identifier(column.name)} <=> (${column.expression}))), 0) AS mismatch${i}`
    ).join(", ");
    for (;;) {
      // Materialize covering-index values before fetching the source row. This
      // avoids recomputing each virtual expression on both sides of comparison.
      const [[batch]] = await connection.query(
        `SELECT /*+ MAX_EXECUTION_TIME(25000) */ COUNT(*) AS checked, MAX(cached.id) AS lastId, ${comparisons} ` +
        `FROM (SELECT id, ${fields} FROM ${tableSql} FORCE INDEX (${indexSql}) ` +
        `WHERE id > ? ORDER BY id LIMIT 100) cached ` +
        `JOIN ${tableSql} ON ${tableSql}.id = cached.id`, [lastId]
      );
      const count = Number(batch.checked);
      if (!Number.isSafeInteger(count) || count < 0 || count > 100)
        throw new Error("Invalid generated-record batch size");
      for (const [i, column] of columns.entries()) {
        if (Number(batch["mismatch" + i]) !== 0)
          throw new Error(`Generated value mismatch: ${table}.${column.name}`);
      }
      if (!count) break;
      const next = Number(batch.lastId);
      if (!Number.isSafeInteger(next) || next <= lastId)
        throw new Error("Generated-record cursor did not advance");
      checked += count;
      if (checked > expected) throw new Error("Generated-record inventory changed");
      lastId = next;
    }
    if (checked !== expected) throw new Error("Generated-record coverage is incomplete");
    return { checked, columns: columns.length };
  } finally {
    await connection.rollback();
    await connection.query("SET SESSION TRANSACTION READ WRITE");
  }
}
