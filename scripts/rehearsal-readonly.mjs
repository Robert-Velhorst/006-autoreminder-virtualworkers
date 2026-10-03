const failure = () => new Error('Rehearsal account is not restricted to owned-schema read access');

// Deliberately accept only a narrow SHOW GRANTS grammar; roles and unfamiliar
// grant forms require operator review rather than an optimistic interpretation.
export function validateReadOnlyGrants(grants) {
  if (!Array.isArray(grants) || !grants.length) throw failure();
  let schemaRead = false;
  for (const grant of grants) {
    if (typeof grant !== 'string') throw failure();
    const match = /^GRANT (USAGE|SELECT|SHOW VIEW|SELECT, SHOW VIEW|SHOW VIEW, SELECT) ON (\*\.\*|`aptlss_pilot_rehearsal`\.\*) TO (?:'[^']+'@'[^']+'|`[^`]+`@`[^`]+`)$/.exec(grant);
    if (!match) throw failure();
    if (match[1] === 'USAGE') {
      if (match[2] !== '*.*') throw failure();
    } else {
      if (match[2] !== '`aptlss_pilot_rehearsal`.*') throw failure();
      if (match[1].includes('SELECT')) schemaRead = true;
    }
  }
  if (!schemaRead) throw failure();
  return { readOnly: true, schema: 'aptlss_pilot_rehearsal', grantCount: grants.length };
}

export async function assertReadOnlyRehearsalSession(connection) {
  const [identity] = await connection.query('SELECT DATABASE() AS db, @@port AS port');
  if (identity.length !== 1 || identity[0].db !== 'aptlss_pilot_rehearsal' || Number(identity[0].port) !== 33317) throw failure();
  const [rows] = await connection.query('SHOW GRANTS FOR CURRENT_USER');
  return validateReadOnlyGrants(rows.map(row => {
    const values = Object.values(row);
    if (values.length !== 1) throw failure();
    return values[0];
  }));
}
