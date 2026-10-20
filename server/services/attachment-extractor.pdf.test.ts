import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFParse } from "pdf-parse";

const mocks = vi.hoisted(() => ({ download: vi.fn(), resolve: vi.fn() }));
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("./attachment-download", () => ({
  MAX_ATTACHMENT_DOWNLOAD_BYTES: 20 * 1024 * 1024,
  downloadPinnedHttpsAttachment: mocks.download,
}));
vi.mock("./attachment-url-policy", () => ({
  isTrelloAttachmentUrl: () => false,
  resolveSafeAttachmentDownloadTarget: mocks.resolve,
}));

import { AttachmentExtractorService } from "./attachment-extractor";

// A one-page PDF with a correct byte-offset xref, using no network or user data.
function pdfFixture(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

const attachment = {
  id: 1, trelloId: "fixture", cardId: 1, name: "report.pdf",
  url: "https://fixture.example.test/report.pdf", mimeType: "application/pdf", bytes: null,
};

describe("PDF attachment extraction with the installed parser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ url: new URL("https://fixture.example.test/report.pdf"), addresses: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("extracts real PDF text and page count without adding page markers", async () => {
    mocks.download.mockResolvedValue(pdfFixture("APTLSS fixture text"));
    const destroy = vi.spyOn(PDFParse.prototype, "destroy");
    const result = await new AttachmentExtractorService().extractAttachment(attachment);
    expect(result).toMatchObject({ success: true, content: "APTLSS fixture text", wordCount: 3, pageCount: 1 });
    expect(result.extractedAt).toBeInstanceOf(Date);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("counts a blank PDF as zero words and still releases its parser", async () => {
    mocks.download.mockResolvedValue(pdfFixture(""));
    const destroy = vi.spyOn(PDFParse.prototype, "destroy");
    const result = await new AttachmentExtractorService().extractAttachment(attachment);
    expect(result).toMatchObject({ success: true, content: "", wordCount: 0, pageCount: 1 });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bytes and releases the parser after extraction fails", async () => {
    mocks.download.mockResolvedValue(Buffer.from("not a PDF"));
    const destroy = vi.spyOn(PDFParse.prototype, "destroy");
    const result = await new AttachmentExtractorService().extractAttachment(attachment);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PDF extraction failed");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps valid extraction and logs no private error when cleanup rejects", async () => {
    mocks.download.mockResolvedValue(pdfFixture("APTLSS fixture text"));
    const originalDestroy = PDFParse.prototype.destroy;
    const destroy = vi.spyOn(PDFParse.prototype, "destroy").mockImplementation(async function (this: PDFParse) {
      await originalDestroy.call(this);
      throw new Error("private-parser-cleanup-data");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await new AttachmentExtractorService().extractAttachment(attachment);
    expect(result).toMatchObject({ success: true, content: "APTLSS fixture text", pageCount: 1 });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[AttachmentExtractor] PDF parser cleanup failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-parser-cleanup-data");
  });

  it("handles an asynchronous download rejection without exposing its URL or credentials", async () => {
    mocks.download.mockRejectedValueOnce(new Error("https://fixture.example.test/private-document?token=private-download-token"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new AttachmentExtractorService().extractAttachment(attachment)).resolves.toEqual({ success: false, error: "Failed to download attachment" });
    expect(logged).toHaveBeenCalledWith("[AttachmentExtractor] Attachment download failed");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-download-token");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-document");
  });

  it("rejects a failed URL resolution without logging the supplied private address", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("private-address-or-document-data"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new AttachmentExtractorService().extractAttachment(attachment)).resolves.toEqual({ success: false, error: "Failed to download attachment" });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-address-or-document-data");
  });
});
