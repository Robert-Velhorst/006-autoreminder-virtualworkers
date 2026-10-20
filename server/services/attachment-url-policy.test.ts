import { describe, expect, it } from "vitest";
import {
  createPinnedAttachmentLookup,
  isSafeAttachmentDownloadUrl,
  resolveSafeAttachmentDownloadTarget,
  resolveSafeAttachmentDownloadUrl,
} from "./attachment-url-policy";
import { UNSUPPORTED_ATTACHMENT_STATUS } from "./attachment-extractor";

describe("attachment download URL policy", () => {
  it("allows a regular HTTPS attachment URL", () => {
    expect(isSafeAttachmentDownloadUrl("https://files.example.com/brief.pdf")).toBe(true);
  });

  it.each([
    "http://files.example.com/brief.pdf",
    "https://localhost/internal.pdf",
    "https://127.0.0.1/internal.pdf",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.2/secret.pdf",
    "https://[::1]/internal.pdf",
    "https://user:password@files.example.com/brief.pdf",
  ])("rejects an unsafe attachment URL: %s", (url) => {
    expect(isSafeAttachmentDownloadUrl(url)).toBe(false);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(resolveSafeAttachmentDownloadUrl(
      "https://files.example.com/brief.pdf",
      async () => [{ address: "10.0.0.2", family: 4 }],
    )).rejects.toThrow("private or reserved address");
  });

  it("allows a hostname when every resolved address is public", async () => {
    await expect(resolveSafeAttachmentDownloadUrl(
      "https://files.example.com/brief.pdf",
      async () => [{ address: "8.8.8.8", family: 4 }],
    )).resolves.toMatchObject({ hostname: "files.example.com" });
  });

  it("pins the validated public DNS answer for the eventual attachment connection", async () => {
    const target = await resolveSafeAttachmentDownloadTarget(
      "https://files.example.com/brief.pdf",
      async () => [{ address: "8.8.8.8", family: 4 }],
    );
    const lookup = createPinnedAttachmentLookup(target.addresses);

    await expect(new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("files.example.com", {}, (error, address, family) => {
        if (error) return reject(error);
        resolve({ address, family });
      });
    })).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("records unsupported attachments as unreadable, which is part of the persisted enum", () => {
    expect(UNSUPPORTED_ATTACHMENT_STATUS).toBe("unreadable");
  });
});
