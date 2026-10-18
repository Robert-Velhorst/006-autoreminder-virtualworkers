import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentExtractorService } from './attachment-extractor';

describe('AttachmentExtractorService outbound credentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not send Trello API credentials to a signed S3 attachment URL', async () => {
    vi.stubEnv('TRELLO_API_KEY', 'api-secret');
    vi.stubEnv('TRELLO_TOKEN', 'token-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response('attachment text', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

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
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.has('key')).toBe(false);
    expect(requestedUrl.searchParams.has('token')).toBe(false);
    expect(requestedUrl.searchParams.get('X-Amz-Signature')).toBe('signed');
  });

  it('adds Trello credentials only to the Trello attachment download endpoint', async () => {
    vi.stubEnv('TRELLO_API_KEY', 'api-secret');
    vi.stubEnv('TRELLO_TOKEN', 'token-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response('attachment text', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

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
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get('key')).toBe('api-secret');
    expect(requestedUrl.searchParams.get('token')).toBe('token-secret');
  });
});
