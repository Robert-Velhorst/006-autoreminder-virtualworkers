import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { managerTimingPredictions } from "../aptlssManagerTiming";

// Both plaintext and stored envelopes are capped at 32 MiB of UTF-8, before parsing.
// This also bounds legacy reads/writes; oversized legacy text requires operator handling.
export const MANAGER_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const MANAGER_SNAPSHOT_STORAGE_KEY = "$managerSnapshotStorage";

type JsonObject = Record<string, unknown>;
const own = (value: JsonObject, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(): never { throw new Error("Invalid manager snapshot storage"); }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function bounded(text: string) {
  if (typeof text !== "string" || text.length > MANAGER_SNAPSHOT_MAX_BYTES ||
      Buffer.byteLength(text, "utf8") > MANAGER_SNAPSHOT_MAX_BYTES) fail();
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch {
    // Invalid legacy text stays opaque, except reserved JSON member names. Recognize
    // escaped member names too, so a truncated envelope cannot fall back to plaintext.
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)) {
      try {
        if (JSON.parse(match[0].slice(0, match[0].lastIndexOf(":")).trim()) === MANAGER_SNAPSHOT_STORAGE_KEY) fail();
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return undefined;
  }
}

function projection(snapshot: JsonObject) {
  return {
    ...(own(snapshot, "implementationDigest") ? { implementationDigest: snapshot.implementationDigest } : {}),
    interventions: Array.isArray(snapshot.interventions) && snapshot.interventions.some(
      item => object(item) && item.severity === "urgent",
    ) ? [{ severity: "urgent" }] : [],
    actions: managerTimingPredictions(snapshot.actions),
  };
}

function compressible(snapshot: JsonObject) {
  // Leave unusual legacy review shapes untouched rather than change SQL semantics
  // (notably jsonb containment with array-valued severity or non-array interventions).
  return (!own(snapshot, "implementationDigest") || snapshot.implementationDigest === null ||
      typeof snapshot.implementationDigest === "string") &&
    (!own(snapshot, "interventions") || snapshot.interventions === null ||
      (Array.isArray(snapshot.interventions) && snapshot.interventions.every(item =>
        object(item) && typeof item.severity === "string")));
}

/** Encode only JSON objects when the complete envelope is strictly smaller. */
export function encodeManagerSnapshotStorage(snapshotText: string): string {
  bounded(snapshotText);
  const snapshot = parse(snapshotText);
  if (!object(snapshot)) return snapshotText;
  if (own(snapshot, MANAGER_SNAPSHOT_STORAGE_KEY)) fail();
  if (!compressible(snapshot)) return snapshotText;
  const bytes = Buffer.from(snapshotText, "utf8");
  // JS lone surrogates have no lossless UTF-8 representation. Keep legacy strings intact.
  if (bytes.toString("utf8") !== snapshotText) return snapshotText;
  let compressed: Buffer;
  try {
    compressed = brotliCompressSync(bytes, {
      maxOutputLength: MANAGER_SNAPSHOT_MAX_BYTES,
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return snapshotText;
    throw error;
  }
  const encoded = JSON.stringify({
    [MANAGER_SNAPSHOT_STORAGE_KEY]: {
      version: 1, codec: "brotli", byteLength: bytes.length,
      sha256: sha256(bytes), base64: compressed.toString("base64"),
    },
    ...projection(snapshot),
  });
  return Buffer.byteLength(encoded, "utf8") < bytes.length ? encoded : snapshotText;
}

/** Decode one envelope only; return the original text, never reserialized JSON. */
export function decodeManagerSnapshotStorage(storedText: string): string {
  bounded(storedText);
  const envelope = parse(storedText);
  if (!object(envelope) || !own(envelope, MANAGER_SNAPSHOT_STORAGE_KEY)) return storedText;
  const metadata = envelope[MANAGER_SNAPSHOT_STORAGE_KEY];
  if (!object(metadata) ||
      !isDeepStrictEqual(Object.keys(metadata).sort(), ["base64", "byteLength", "codec", "sha256", "version"]) ||
      metadata.version !== 1 || metadata.codec !== "brotli" ||
      !Number.isSafeInteger(metadata.byteLength) || Number(metadata.byteLength) < 1 ||
      Number(metadata.byteLength) > MANAGER_SNAPSHOT_MAX_BYTES ||
      typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      typeof metadata.base64 !== "string" || metadata.base64.length === 0 ||
      metadata.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(metadata.base64)) fail();
  const compressed = Buffer.from(metadata.base64 as string, "base64");
  if (compressed.toString("base64") !== metadata.base64) fail();
  let bytes: Buffer;
  try {
    // info.bytesWritten detects trailing input even on Node versions predating
    // rejectGarbageAfterEnd. The declared length is also the allocation ceiling.
    const result = brotliDecompressSync(compressed, {
      maxOutputLength: Number(metadata.byteLength), info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (result.engine.bytesWritten !== compressed.length) fail();
    bytes = result.buffer;
  } catch { return fail(); }
  if (bytes.length !== metadata.byteLength || sha256(bytes) !== metadata.sha256) fail();
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail();
  const snapshot = parse(text);
  if (!object(snapshot) || own(snapshot, MANAGER_SNAPSHOT_STORAGE_KEY) || !compressible(snapshot)) fail();
  const { [MANAGER_SNAPSHOT_STORAGE_KEY]: _metadata, ...actualProjection } = envelope;
  if (!isDeepStrictEqual(actualProjection, projection(snapshot))) fail();
  return text;
}
