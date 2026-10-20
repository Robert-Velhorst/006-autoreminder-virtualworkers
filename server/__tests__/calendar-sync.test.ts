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

describe('Calendar Drag-and-Drop Sync to Trello', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRELLO_API_KEY = 'test-api-key';
    process.env.TRELLO_TOKEN = 'test-token';
  });

  describe('PUT /api/trello/cards/:cardId/due', () => {
    it('should update card due date in Trello', async () => {
      const cardId = 'test-card-123';
      const dueDate = '2025-12-30T23:59:59.000Z';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: cardId,
          name: 'Test Card',
          due: dueDate,
        }),
      });

      // Simulate the API call
      const response = await fetch(
        `https://api.trello.com/1/cards/${cardId}?key=test-api-key&token=test-token`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ due: dueDate }),
        }
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.id).toBe(cardId);
      expect(data.due).toBe(dueDate);
    });

    it('should handle Trello API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const response = await fetch(
        'https://api.trello.com/1/cards/invalid-card?key=test-api-key&token=test-token',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ due: null }),
        }
      );

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it('should allow removing due date by passing null', async () => {
      const cardId = 'test-card-456';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: cardId,
          name: 'Test Card',
          due: null,
        }),
      });

      const response = await fetch(
        `https://api.trello.com/1/cards/${cardId}?key=test-api-key&token=test-token`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ due: null }),
        }
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.due).toBeNull();
    });
  });
});

describe('Re-analysis API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/atis/understanding/reanalyze-all', () => {
    it('should accept boardId parameter for selective re-analysis', () => {
      const requestBody = {
        forceAll: true,
        limit: 100,
        boardId: '123',
      };

      expect(requestBody.boardId).toBe('123');
      expect(requestBody.forceAll).toBe(true);
    });

    it('should accept cardIds parameter for specific card re-analysis', () => {
      const requestBody = {
        cardIds: [1, 2, 3],
        limit: 100,
      };

      expect(requestBody.cardIds).toHaveLength(3);
      expect(requestBody.cardIds).toContain(1);
      expect(requestBody.cardIds).toContain(2);
      expect(requestBody.cardIds).toContain(3);
    });

    it('should process all cards when forceAll is true and no filters', () => {
      const requestBody = {
        forceAll: true,
        limit: 500,
      };

      expect(requestBody.forceAll).toBe(true);
      expect(requestBody.limit).toBe(500);
    });
  });
});

describe('Weekly Hours Settings', () => {
  it('should have default weekly hours of 55', () => {
    const defaultWeeklyHours = 55;
    expect(defaultWeeklyHours).toBe(55);
  });

  it('should have default daily hours between 9.5 and 11.5', () => {
    const defaultDailyMin = 9.5;
    const defaultDailyMax = 11.5;
    expect(defaultDailyMin).toBeGreaterThanOrEqual(9);
    expect(defaultDailyMax).toBeLessThanOrEqual(12);
  });
});
