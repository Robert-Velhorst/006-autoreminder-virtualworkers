import { request as httpsRequest } from "node:https";
import { retryAsync } from "../utils/retry";
import { createPinnedAttachmentLookup, type ResolvedAddress } from "./attachment-url-policy";

export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const RETRYABLE_DOWNLOAD_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Read an attachment without retaining more than the configured byte limit. */
export async function readResponseBufferWithinLimit(
  response: Response,
  maxBytes: number = MAX_ATTACHMENT_DOWNLOAD_BYTES,
): Promise<Buffer | null> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength <= maxBytes ? buffer : null;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Download an already validated HTTPS attachment using the exact DNS answers
 * that passed the URL policy. Global fetch performs its own hostname lookup,
 * which would leave a DNS-rebinding gap after validation.
 */
export async function downloadPinnedHttpsAttachment(
  url: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string>,
  maxBytes: number = MAX_ATTACHMENT_DOWNLOAD_BYTES,
): Promise<Buffer | null> {
  return retryAsync(() => requestPinnedAttachment(url, addresses, headers, maxBytes));
}

function requestPinnedAttachment(
  url: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string>,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = httpsRequest(url, {
      headers,
      lookup: createPinnedAttachmentLookup(addresses),
      method: "GET",
      timeout: 15_000,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        if (RETRYABLE_DOWNLOAD_STATUSES.has(status)) {
          fail(new Error(`Attachment download returned HTTP ${status}`));
        } else {
          finish(null);
        }
        return;
      }

      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.resume();
        finish(null);
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          finish(null);
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(Buffer.concat(chunks, totalBytes)));
      response.on("error", (error) => fail(error));
    });

    request.on("timeout", () => request.destroy(new Error("Attachment download timed out")));
    request.on("error", (error) => fail(error));
    request.end();
  });
}
