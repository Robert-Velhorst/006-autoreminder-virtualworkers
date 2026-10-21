/** Apostrophe-prefixed text is a serialization convention, not spreadsheet-client acceptance proof. */
export function serializeCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Spreadsheet importers can ignore leading whitespace/control characters.
  const finiteNumber = typeof value === 'number' && Number.isFinite(value);
  if (!finiteNumber && /^[\s\p{Cc}\p{Cf}]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map(row => row.map(serializeCsvCell).join(',')).join('\r\n');
}
