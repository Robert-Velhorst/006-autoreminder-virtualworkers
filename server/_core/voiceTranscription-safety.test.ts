import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("voice transcription download boundary", () => {
  it("uses the shared safe URL resolver and streams audio within the byte limit", () => {
    const source = readFileSync(new URL("./voiceTranscription.ts", import.meta.url), "utf8");

    expect(source).toContain('resolveSafeAttachmentDownloadUrl(options.audioUrl)');
    expect(source).toContain('readResponseBufferWithinLimit(response, MAX_AUDIO_DOWNLOAD_BYTES)');
    expect(source).toContain('AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS)');
    expect(source).not.toContain('fetch(options.audioUrl)');
    expect(source).not.toContain('Buffer.from(await response.arrayBuffer())');
  });
});
