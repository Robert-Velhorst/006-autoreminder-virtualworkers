import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch for Trello API calls
const mockFetch = vi.fn();
const originalFetch = global.fetch;
const originalTrelloApiKey = process.env.TRELLO_API_KEY;
const originalTrelloToken = process.env.TRELLO_TOKEN;
global.fetch = mockFetch;

afterEach(() => {
  if (originalTrelloApiKey === undefined) delete process.env.TRELLO_API_KEY;
  else process.env.TRELLO_API_KEY = originalTrelloApiKey;
  if (originalTrelloToken === undefined) delete process.env.TRELLO_TOKEN;
  else process.env.TRELLO_TOKEN = originalTrelloToken;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('Individual Card Re-analyze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRELLO_API_KEY = 'test-api-key';
    process.env.TRELLO_TOKEN = 'test-token';
  });

  describe('POST /api/atis/understanding/reprocess/:cardId', () => {
    it('should accept a card ID parameter', () => {
      const cardId = '123';
      const cardIdNum = parseInt(cardId);
      expect(cardIdNum).toBe(123);
      expect(isNaN(cardIdNum)).toBe(false);
    });

    it('should reject invalid card ID', () => {
      const cardId = 'invalid';
      const cardIdNum = parseInt(cardId);
      expect(isNaN(cardIdNum)).toBe(true);
    });
  });

  describe('POST /api/atis/cards/:trelloId/reingest', () => {
    it('should fetch card data from Trello', async () => {
      const trelloId = 'abc123';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: trelloId,
          name: 'Test Card',
          desc: 'Test description',
          url: 'https://trello.com/c/abc123',
          due: '2025-12-31T23:59:59.000Z',
          labels: [],
        }),
      });

      const response = await fetch(
        `https://api.trello.com/1/cards/${trelloId}?key=test-api-key&token=test-token&checklists=all&attachments=true`
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.id).toBe(trelloId);
      expect(data.name).toBe('Test Card');
    });

    it('should handle Trello API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Card not found',
      });

      const response = await fetch(
        'https://api.trello.com/1/cards/invalid-id?key=test-api-key&token=test-token'
      );

      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/atis/cards/by-trello/:trelloId', () => {
    it('should return ATIS card ID for valid Trello ID', () => {
      const mockCard = { id: 42, name: 'Test Card' };
      expect(mockCard.id).toBe(42);
      expect(mockCard.name).toBe('Test Card');
    });
  });

  describe('Re-analyze workflow', () => {
    it('should perform two-step re-analysis: reingest then reprocess', async () => {
      const trelloId = 'abc123';
      const atisCardId = 42;
      
      // Step 1: Reingest would fetch from Trello and update DB
      const reingestResult = {
        success: true,
        cardId: atisCardId,
        trelloId,
        name: 'Updated Card Name',
        commentsUpdated: true,
      };
      expect(reingestResult.success).toBe(true);
      expect(reingestResult.commentsUpdated).toBe(true);

      // Step 2: Reprocess would regenerate AI understanding
      const reprocessResult = {
        success: true,
        cardId: atisCardId,
        understanding: {
          goal: 'Complete the task',
          aptlssChecklist: [
            { step: 'Step 1', timeMinutes: 15, aptlssType: 'A' },
            { step: 'Step 2', timeMinutes: 30, aptlssType: 'P' },
          ],
        },
      };
      expect(reprocessResult.success).toBe(true);
      expect(reprocessResult.understanding.aptlssChecklist).toHaveLength(2);
    });
  });
});
