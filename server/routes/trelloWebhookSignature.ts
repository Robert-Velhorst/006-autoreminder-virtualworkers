import { createHmac, timingSafeEqual } from "node:crypto";

export function getConfiguredTrelloWebhookCallbackUrl(
  value = process.env.TRELLO_WEBHOOK_CALLBACK_URL
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/trello-webhook"
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function isValidTrelloWebhookSignature(args: {
  body: unknown;
  callbackUrl: string | null;
  requestPath: string;
  secret: string | undefined;
  signature: string | undefined;
}): boolean {
  const { body, callbackUrl, requestPath, secret, signature } = args;
  if (!callbackUrl || !secret?.trim() || !signature) {
    return false;
  }
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    return false;
  }
  if (
    callback.protocol !== "https:" ||
    callback.pathname !== "/api/trello-webhook" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password ||
    requestPath !== callback.pathname
  ) return false;

  const serializedBody = JSON.stringify(body);
  if (serializedBody === undefined) return false;

  const expected = createHmac("sha1", secret)
    .update(serializedBody + callbackUrl, "utf8")
    .digest();
  const supplied = Buffer.from(signature, "base64");
  return supplied.toString("base64") === signature &&
    supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
