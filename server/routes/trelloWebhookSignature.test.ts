import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getConfiguredTrelloWebhookCallbackUrl,
  isValidTrelloWebhookSignature,
} from "./trelloWebhookSignature";

const callbackUrl = "https://va.example.com/api/trello-webhook";
const secret = "trello-app-secret";
const body = { action: { id: "event-1" }, type: "updateCard" };

function signatureFor(value: unknown, url = callbackUrl) {
  return createHmac("sha1", secret)
    .update(JSON.stringify(value) + url, "utf8")
    .digest("base64");
}

describe("Trello webhook signature validation", () => {
  it("accepts only the exact configured HTTPS callback URL", () => {
    expect(getConfiguredTrelloWebhookCallbackUrl(callbackUrl)).toBe(callbackUrl);
    expect(getConfiguredTrelloWebhookCallbackUrl("http://va.example.com/api/trello-webhook")).toBeNull();
    expect(getConfiguredTrelloWebhookCallbackUrl(`${callbackUrl}/`)).toBeNull();
    expect(getConfiguredTrelloWebhookCallbackUrl(`${callbackUrl}?x=1`)).toBeNull();
  });

  it("accepts a valid signature for the exact callback path", () => {
    expect(isValidTrelloWebhookSignature({
      body,
      callbackUrl,
      requestPath: "/api/trello-webhook",
      secret,
      signature: signatureFor(body),
    })).toBe(true);
  });

  it.each([
    { body: { ...body, extra: true }, requestPath: "/api/trello-webhook", secret, signature: signatureFor(body) },
    { body, requestPath: "/api/chatbot", secret, signature: signatureFor(body) },
    { body, requestPath: "/api/trello-webhook", secret: "wrong-secret", signature: signatureFor(body) },
    { body, requestPath: "/api/trello-webhook", secret, signature: "invalid" },
  ])("rejects tampered or misrouted webhook requests", input => {
    expect(isValidTrelloWebhookSignature({ callbackUrl, ...input })).toBe(false);
  });

  it("fails closed when callback configuration or signature is missing", () => {
    expect(isValidTrelloWebhookSignature({
      body,
      callbackUrl: null,
      requestPath: "/api/trello-webhook",
      secret,
      signature: signatureFor(body),
    })).toBe(false);
    expect(isValidTrelloWebhookSignature({
      body,
      callbackUrl: "not a url",
      requestPath: "/api/trello-webhook",
      secret,
      signature: signatureFor(body),
    })).toBe(false);
    expect(isValidTrelloWebhookSignature({
      body,
      callbackUrl,
      requestPath: "/api/trello-webhook",
      secret: undefined,
      signature: signatureFor(body),
    })).toBe(false);
  });
});
