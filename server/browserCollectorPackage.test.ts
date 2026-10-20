import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
// @ts-expect-error Browser package intentionally ships dependency-free JavaScript.
import { collectorPairingIdentity, dashboardOrigin, inventory, isValidCollectorId, MAX_CAPTURE_SEQUENCE, nextCaptureVersion, reconcileCaptureVersion } from "../browser-extension/collector-core.js";
import { MAX_BROWSER_TAB_CAPTURE_SEQUENCE } from "../shared/browserTabProtocol";

function readZipEntries(archive: Buffer) {
  const minimumEndOffset = Math.max(0, archive.length - 22 - 0xffff);
  let endOffset = archive.length - 22;
  while (endOffset >= minimumEndOffset) {
    if (archive.readUInt32LE(endOffset) === 0x06054b50
      && endOffset + 22 + archive.readUInt16LE(endOffset + 20) === archive.length) break;
    endOffset -= 1;
  }
  if (endOffset < minimumEndOffset) throw new Error("ZIP end record is missing or malformed");

  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryEnd = archive.readUInt32LE(endOffset + 16) + centralDirectorySize;
  let offset = archive.readUInt32LE(endOffset + 16);
  if (centralDirectoryEnd > endOffset) throw new Error("ZIP central directory is out of bounds");

  const entries = new Map<string, Buffer>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is malformed");
    }
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffff_ffff)) {
      throw new Error("ZIP64 archives are not supported by this small-package test");
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const name = archive.subarray(nameStart, nameEnd).toString("utf8");
    if (nameEnd + extraLength + commentLength > centralDirectoryEnd || entries.has(name)) {
      throw new Error("ZIP entry name or directory bounds are invalid");
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("ZIP local file header is malformed");
    }
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error("ZIP entry data is out of bounds");
    const compressed = archive.subarray(dataStart, dataEnd);
    const content = compressionMethod === 0
      ? Buffer.from(compressed)
      : compressionMethod === 8
        ? inflateRawSync(compressed)
        : (() => { throw new Error(`Unsupported ZIP compression method ${compressionMethod}`); })();
    if (content.length !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${name}`);
    entries.set(name, content);
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralDirectoryEnd) throw new Error("ZIP central directory size does not match its entries");
  return entries;
}

describe("worker browser collector boundaries", () => {
  it("keeps the downloadable archive byte-for-byte synchronized with extension sources", () => {
    const packageFiles = ["manifest.json", "collector-core.js", "service-worker.js", "options.html", "options.js", "popup.html", "popup.js"];
    const archive = readFileSync(new URL("../client/public/downloads/worker-browser-collector.zip", import.meta.url));
    const entries = readZipEntries(archive);

    expect([...entries.keys()].sort()).toEqual([...packageFiles].sort());
    for (const filename of packageFiles) {
      expect(entries.get(filename), `${filename} should match the current extension source`).toEqual(
        readFileSync(new URL(`../browser-extension/${filename}`, import.meta.url)),
      );
    }
  });

  it("accepts HTTPS and loopback only, never URL credentials or paths", () => {
    expect(dashboardOrigin("https://dashboard.example")).toBe("https://dashboard.example");
    expect(dashboardOrigin("http://127.0.0.1:3025")).toBe("http://127.0.0.1:3025");
    for (const url of ["http://remote.example", "https://user:secret@example.com", "https://@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com/?", "https://example.com/#", "https:example.com"]) expect(() => dashboardOrigin(url)).toThrow();
    expect(() => dashboardOrigin(new URL("https://example.com") as unknown as string)).toThrow();
  });
  it("reports domains only and excludes incognito without understating oversized inventories", () => {
    const tab = { id: 1, title: "Private document", url: "https://user:secret@example.com/private?token=abc#password", pinned: true, active: true, windowId: 3 };
    expect(inventory([tab, { ...tab, incognito: true }])).toEqual([{ id: "1", title: "example.com", url: "https://example.com/", pinned: true, active: true, windowId: 3 }]);
    expect(() => inventory(Array.from({ length: 251 }, () => tab))).toThrow(/no partial inventory/);
  });
  it("hides file-share hosts and rejects malformed eligible tab records", () => {
    expect(inventory([{ id: 2, url: "file://private-share/reports/payroll.xlsx", windowId: 3 }])).toEqual([
      { id: "2", title: "Local file", url: "file:///", pinned: false, active: false, windowId: 3 },
    ]);
    expect(() => inventory(null as never)).toThrow(/malformed tab inventory/);
    expect(() => inventory([null] as never)).toThrow(/malformed tab inventory/);
    expect(() => inventory([{ id: "1", url: "https://example.test/private", windowId: 3 } as never])).toThrow(/malformed tab inventory/);
    expect(() => inventory([{ id: 1, url: "https://example.test/private", windowId: 3, pinned: "false" } as never])).toThrow(/malformed tab inventory/);
  });
  it("increments report versions, initializes upgraded installs, and rotates invalid or exhausted identities", () => {
    const replacement = () => "replacement-id";
    expect(nextCaptureVersion("existing-id", 8, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 9 });
    expect(nextCaptureVersion("existing-id", undefined, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 1 });
    expect(nextCaptureVersion("existing-id", 4_294_967_295, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
    expect(nextCaptureVersion("existing-id", -1, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
    expect(nextCaptureVersion("", 5, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
  });
  it("resynchronizes delayed reports and rotates an exhausted collector sequence", () => {
    const replacement = () => "replacement-id";
    expect(reconcileCaptureVersion("existing-id", 3, 20, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 20 });
    expect(reconcileCaptureVersion("existing-id", 20, 18, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 20 });
    expect(reconcileCaptureVersion("existing-id", 3, 4_294_967_295, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 0 });
    expect(reconcileCaptureVersion("existing-id", 3, Number.NaN, replacement)).toBeNull();
  });
  it("limits collector identities to the ingest protocol and rotates malformed saved identities", () => {
    const replacement = () => "replacement-id";
    expect(isValidCollectorId("collector_01-a")).toBe(true);
    expect(isValidCollectorId("collector/../other")).toBe(false);
    expect(isValidCollectorId("x".repeat(129))).toBe(false);
    expect(collectorPairingIdentity(null as never, "https://dashboard.example", "token", replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 0 });
    expect(collectorPairingIdentity({ dashboardUrl: "https://dashboard.example", collectorToken: "token", collectorId: "bad/id", captureSequence: 2 }, "https://dashboard.example", "token", replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 0 });
  });
  it("keeps the extension sequence ceiling aligned with MySQL unsigned INT", () => {
    const schema = readFileSync(new URL("../drizzle/schema.ts", import.meta.url), "utf8");

    expect(MAX_CAPTURE_SEQUENCE).toBe(MAX_BROWSER_TAB_CAPTURE_SEQUENCE);
    expect(MAX_BROWSER_TAB_CAPTURE_SEQUENCE).toBe(2 ** 32 - 1);
    expect(schema).toMatch(/captureSequence: int\("captureSequence", \{ unsigned: true \}\)/);
  });
  it("has no automatic pairing or automatic tab closing in the background", () => {
    const service = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
    expect(service).not.toContain("tabs.remove");
    expect(service).not.toContain("getCollectorSetup");
    expect(service).toContain('credentials: "omit"');
    expect(service).toContain('redirect: "error"');
    expect(service).toContain("protocolVersion: 2");
    expect(service).toContain("captureSequence");
    expect(service).toContain("reconcileCaptureVersion");
    expect(service).toContain("response.status === 409");
    expect(service).toContain("collectorResetRequiredKey");
    expect(service).not.toContain("set({ collectorId: crypto.randomUUID()");
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).not.toContain("history");
  });
});
