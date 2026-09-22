import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type ResolvedAddress = { address: string; family: number };
type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeAttachmentDownloadTarget {
  url: URL;
  addresses: ResolvedAddress[];
}

export type PinnedAttachmentLookup = (
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

function isPublicIpv4(value: string) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}

export function isPublicIpAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) return isPublicIpv4(normalized);
  if (isIP(normalized) !== 6) return false;

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:169.254.") ||
    normalized.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(?:1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

export function isSafeAttachmentDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
    return isIP(hostname) === 0 || isPublicIpAddress(hostname);
  } catch {
    return false;
  }
}

const defaultHostLookup: HostLookup = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family }));
};

/**
 * Reject hostnames that resolve into private or reserved network ranges before
 * the server opens a connection. This keeps card attachments from becoming a
 * path to local metadata or other internal services.
 */
export async function resolveSafeAttachmentDownloadTarget(
  value: string,
  hostLookup: HostLookup = defaultHostLookup,
): Promise<SafeAttachmentDownloadTarget> {
  if (!isSafeAttachmentDownloadUrl(value)) {
    throw new Error("Attachment URL is not permitted");
  }

  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    return {
      url,
      addresses: [{ address: hostname, family: isIP(hostname) }],
    };
  }

  const addresses = await hostLookup(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("Attachment URL resolves to a private or reserved address");
  }

  return { url, addresses };
}

/**
 * Force the eventual socket connection to use the DNS answers that were
 * validated above. This prevents a hostname from changing to an internal
 * address between validation and the download request.
 */
export function createPinnedAttachmentLookup(addresses: ResolvedAddress[]): PinnedAttachmentLookup {
  if (addresses.length === 0) {
    throw new Error("Cannot pin an attachment download without a resolved address");
  }

  let nextAddress = 0;
  return (_hostname, _options, callback) => {
    const address = addresses[nextAddress % addresses.length];
    nextAddress += 1;
    callback(null, address.address, address.family);
  };
}

export async function resolveSafeAttachmentDownloadUrl(
  value: string,
  hostLookup: HostLookup = defaultHostLookup,
) {
  return (await resolveSafeAttachmentDownloadTarget(value, hostLookup)).url;
}

export function isTrelloAttachmentUrl(value: URL) {
  const hostname = value.hostname.toLowerCase();
  return hostname === "trello.com"
    || hostname.endsWith(".trello.com")
    || hostname === "trello-attachments.s3.amazonaws.com";
}
