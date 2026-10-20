import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ download: vi.fn(), resolve: vi.fn() }));
vi.mock('../db', () => ({ getDb: vi.fn() }));
vi.mock('./attachment-download', () => ({
  MAX_ATTACHMENT_DOWNLOAD_BYTES: 20 * 1024 * 1024,
  downloadPinnedHttpsAttachment: mocks.download,
}));
vi.mock('./attachment-url-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('./attachment-url-policy')>(),
  resolveSafeAttachmentDownloadTarget: mocks.resolve,
}));
import { AttachmentExtractorService } from './attachment-extractor';

describe('AttachmentExtractorService outbound credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockImplementation(async (url: string) => ({ url: new URL(url), addresses: [{ address: '203.0.113.10', family: 4 }] }));
    mocks.download.mockResolvedValue(Buffer.from('attachment text'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not send Trello API credentials to a signed S3 attachment URL', async () => {
    vi.stubEnv('TRELLO_API_KEY', 'api-secret');
    vi.stubEnv('TRELLO_TOKEN', 'token-secret');

    const service = new AttachmentExtractorService();
    const result = await service.extractAttachment({
      id: 1,
      trelloId: 'attachment-id',
      cardId: 1,
      name: 'notes.txt',
      url: 'https://trello-attachments.s3.amazonaws.com/bucket/object?X-Amz-Signature=signed',
      mimeType: 'text/plain',
      bytes: 16,
    });

    expect(result.success).toBe(true);
    const requestedUrl = new URL(mocks.download.mock.calls[0][0] as URL);
    expect(requestedUrl.searchParams.has('key')).toBe(false);
    expect(requestedUrl.searchParams.has('token')).toBe(false);
    expect(requestedUrl.searchParams.get('X-Amz-Signature')).toBe('signed');
  });

  it('adds Trello credentials only to the Trello attachment download endpoint', async () => {
    vi.stubEnv('TRELLO_API_KEY', 'api-secret');
    vi.stubEnv('TRELLO_TOKEN', 'token-secret');

    const service = new AttachmentExtractorService();
    const result = await service.extractAttachment({
      id: 1,
      trelloId: 'attachment-id',
      cardId: 1,
      name: 'notes.txt',
      url: 'https://trello.com/1/cards/card-id/attachments/attachment-id/download/notes.txt',
      mimeType: 'text/plain',
      bytes: 16,
    });

    expect(result.success).toBe(true);
    const requestedUrl = new URL(mocks.download.mock.calls[0][0] as URL);
    expect(requestedUrl.searchParams.get('key')).toBe('api-secret');
    expect(requestedUrl.searchParams.get('token')).toBe('token-secret');
  });
});
