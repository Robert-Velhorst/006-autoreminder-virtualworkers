const MODEL_ID = /^[a-zA-Z0-9]{8,32}$/;

export function parseTrelloModelId(input: string): string | null {
  const value = input.trim();
  if (MODEL_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['trello.com', 'www.trello.com'].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    return /^\/b\/([a-zA-Z0-9]{8,32})(?:\/[^/]*)?\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function trelloCardUrl(cardId: string): string | null {
  return MODEL_ID.test(cardId) ? `https://trello.com/c/${encodeURIComponent(cardId)}` : null;
}
