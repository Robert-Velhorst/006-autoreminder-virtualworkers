/** Encode untrusted text as a reversible, single-line JSON string for logs. */
export function logString(value: string): string {
  // JSON escapes quotes, backslashes and C0 controls. Escape the remaining
  // control/line-separator characters that some terminals and readers accept.
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
