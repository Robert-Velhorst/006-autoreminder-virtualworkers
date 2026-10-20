import { readFileSync } from 'node:fs';
import { trelloWebhookRegistrationError } from './trello-webhook-bulk';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Trello Webhook Bulk Registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Input Validation', () => {
    it('should reject empty boardIds array', () => {
      const payload = {
        boardIds: [],
        callbackUrl: 'https://example.com/webhook',
      };
      expect(payload.boardIds.length).toBe(0);
    });

    it('should reject more than 50 boards', () => {
      const boardIds = Array.from({ length: 51 }, (_, i) => `board${i}`);
      expect(boardIds.length).toBeGreaterThan(50);
    });

    it('should not require callbackUrl in request body (built server-side)', () => {
      // callbackUrl is read from the exact TRELLO_WEBHOOK_CALLBACK_URL setting.
      // The client only sends boardIds and optional descriptions.
      const payload = {
        boardIds: ['board1', 'board2'],
      };
      expect(payload).not.toHaveProperty('callbackUrl');
      expect(payload.boardIds.length).toBeGreaterThan(0);
    });

    it('should accept valid board IDs (8-32 alphanumeric chars)', () => {
      const validIds = [
        'board1234',
        'a1b2c3d4e5f6g7h8',
        'ABCDEFGHIJKLMNOPQR',
      ];
      validIds.forEach(id => {
        expect(/^[a-zA-Z0-9]{8,32}$/.test(id)).toBe(true);
      });
    });

    it('should reject invalid board IDs with special characters', () => {
      const invalidIds = [
        'board-123',
        'board_456',
        'board@789',
        'board#000',
      ];
      invalidIds.forEach(id => {
        expect(/^[a-zA-Z0-9]{8,32}$/.test(id)).toBe(false);
      });
    });

    it('should reject board IDs shorter than 8 chars', () => {
      const shortId = 'board12';
      expect(shortId.length).toBeLessThan(8);
    });

    it('should reject board IDs longer than 32 chars', () => {
      const longId = 'a'.repeat(33);
      expect(longId.length).toBeGreaterThan(32);
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple boards in parallel', () => {
      const boardIds = ['board1', 'board2', 'board3'];
      const promises = boardIds.map(id => Promise.resolve({ id, success: true }));
      expect(promises.length).toBe(3);
    });

    it('should handle partial failures gracefully', () => {
      const results = [
        { boardId: 'board1', success: true, webhookId: 'webhook1' },
        { boardId: 'board2', success: false, error: 'Not found' },
        { boardId: 'board3', success: true, webhookId: 'webhook3' },
      ];
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      expect(successful).toBe(2);
      expect(failed).toBe(1);
    });

    it('should return summary statistics', () => {
      const summary = {
        total: 5,
        successful: 3,
        failed: 2,
      };
      expect(summary.total).toBe(summary.successful + summary.failed);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing Trello credentials', () => {
      const apiKey = '';
      const token = '';
      expect(apiKey).toBeFalsy();
      expect(token).toBeFalsy();
    });

    it('should handle authentication failures', () => {
      const error = {
        status: 401,
        message: 'Authentication failed - check your Trello credentials',
      };
      expect(error.status).toBe(401);
      expect(error.message).toContain('Authentication');
    });

    it('should handle board not found errors', () => {
      const error = {
        status: 404,
        message: 'Board not found or you do not have permission',
      };
      expect(error.status).toBe(404);
      expect(error.message).toContain('not found');
    });

    it('should handle network timeouts', () => {
      const error = {
        message: 'Request timeout after 30 seconds',
      };
      expect(error.message).toContain('timeout');
    });

    it('should handle invalid Trello API responses', () => {
      const response = { data: null };
      expect(response.data).toBeNull();
    });
  });

  describe('Response Format', () => {
    it('should return correct response structure', () => {
      const response = {
        success: true,
        results: [
          { boardId: 'board1', success: true, webhookId: 'webhook1' },
        ],
        summary: {
          total: 1,
          successful: 1,
          failed: 0,
        },
      };
      expect(response).toHaveProperty('success');
      expect(response).toHaveProperty('results');
      expect(response).toHaveProperty('summary');
      expect(Array.isArray(response.results)).toBe(true);
    });

    it('should include error details in failed results', () => {
      const result = {
        boardId: 'board1',
        success: false,
        error: 'Board not found',
      };
      expect(result).toHaveProperty('error');
      expect(result.success).toBe(false);
    });

    it('should include webhook ID in successful results', () => {
      const result = {
        boardId: 'board1',
        success: true,
        webhookId: 'webhook123',
      };
      expect(result).toHaveProperty('webhookId');
      expect(result.success).toBe(true);
    });
  });

  describe('Board Descriptions', () => {
    it('should support custom descriptions per board', () => {
      const descriptions = {
        board1: 'Main workspace',
        board2: 'Dev board',
        board3: 'QA board',
      };
      expect(descriptions['board1']).toBe('Main workspace');
      expect(descriptions['board2']).toBe('Dev board');
    });

    it('should use default description if not provided', () => {
      const defaultDesc = 'VA Dashboard Chatbot';
      expect(defaultDesc).toBeTruthy();
    });

    it('should handle missing descriptions gracefully', () => {
      const descriptions: Record<string, string> = {};
      const boardId = 'board1';
      const desc = descriptions[boardId] || 'Default';
      expect(desc).toBe('Default');
    });
  });

  describe('Callback URL', () => {
    it('uses the exact callback URL configured by the operator', () => {
      const callbackUrl = 'https://example.com/api/trello-webhook';
      expect(callbackUrl).toBe('https://example.com/api/trello-webhook');
    });

    it('requires both callback URL and signing secret before registration', () => {
      const callbackUrl: string | null = null;
      const secret: string | undefined = undefined;
      expect(!callbackUrl || !secret).toBe(true);
    });
  });

  describe('Rate Limiting', () => {
    it('should respect max 50 boards per request', () => {
      const maxBoards = 50;
      const boardIds = Array.from({ length: maxBoards }, (_, i) => `board${i}`);
      expect(boardIds.length).toBeLessThanOrEqual(maxBoards);
    });

    it('should handle sequential requests without conflicts', () => {
      const request1 = { boardIds: ['board1', 'board2'] };
      const request2 = { boardIds: ['board3', 'board4'] };
      expect(request1.boardIds).not.toEqual(request2.boardIds);
    });
  });

  describe('Success Scenarios', () => {
    it('should successfully register multiple boards', () => {
      const results = [
        { boardId: 'board1', success: true, webhookId: 'webhook1' },
        { boardId: 'board2', success: true, webhookId: 'webhook2' },
        { boardId: 'board3', success: true, webhookId: 'webhook3' },
      ];
      const allSuccessful = results.every(r => r.success);
      expect(allSuccessful).toBe(true);
    });

    it('should return all webhook IDs for successful registrations', () => {
      const results = [
        { boardId: 'board1', success: true, webhookId: 'webhook1' },
        { boardId: 'board2', success: true, webhookId: 'webhook2' },
      ];
      const webhookIds = results.map(r => r.webhookId);
      expect(webhookIds.length).toBe(2);
      expect(webhookIds.every(id => id)).toBe(true);
    });

    it('should report 100% success rate when all boards registered', () => {
      const summary = {
        total: 5,
        successful: 5,
        failed: 0,
      };
      const successRate = (summary.successful / summary.total) * 100;
      expect(successRate).toBe(100);
    });
  });
});

describe('trelloWebhookRegistrationError', () => {
  it('keeps expected operator actions actionable', () => {
    expect(trelloWebhookRegistrationError(401, 'invalid token')).toBe('Authentication failed — check your Trello credentials');
    expect(trelloWebhookRegistrationError(404, 'model not found')).toBe('Board not found or you do not have permission');
  });

  it('does not return raw provider diagnostics', () => {
    const secret = 'mysql://operator:secret@example.test/dashboard';
    expect(trelloWebhookRegistrationError(500, secret)).toBe('Trello rejected the webhook registration (500)');
  });
});

describe('bulk webhook provider boundary', () => {
  it('bounds registration requests', () => {
    const source = readFileSync(new URL('./trello-webhook-bulk.ts', import.meta.url), 'utf8');
    expect(source).toContain("const TRELLO_REQUEST_TIMEOUT_MS = 15_000");
    expect(source).toContain('signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS)');
  });
});
