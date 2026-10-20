const TRELLO_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/;

/** Validate and encode one Trello ID or card short link used in a URL path. */
export function encodeTrelloPathSegment(value: unknown): string | null {
  if (typeof value !== 'string' || !TRELLO_ID_PATTERN.test(value)) {
    return null;
  }

  return encodeURIComponent(value);
}
