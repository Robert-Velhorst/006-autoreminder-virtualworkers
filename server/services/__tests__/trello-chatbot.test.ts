import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isTrelloCommentAutomationEnabled,
  parseBotCommand,
  postTrelloComment,
  processBotCommand,
} from '../trello-chatbot';

describe('Trello Chatbot', () => {
  describe('external comment safety', () => {
    it('requires an explicit notification opt-in before automation can post to Trello', () => {
      expect(isTrelloCommentAutomationEnabled({})).toBe(false);
      expect(isTrelloCommentAutomationEnabled({ NOTIFICATIONS_ENABLED: 'false', NODE_ENV: 'production' })).toBe(false);
      expect(isTrelloCommentAutomationEnabled({ NOTIFICATIONS_ENABLED: 'true' })).toBe(true);
    });

    it('does not make a Trello request while automation is disabled', async () => {
      const fetchSpy = vi.fn();
      const originalSetting = process.env.NOTIFICATIONS_ENABLED;
      process.env.NOTIFICATIONS_ENABLED = 'false';
      vi.stubGlobal('fetch', fetchSpy);

      try {
        await expect(postTrelloComment('card123', 'A protected test comment')).resolves.toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        if (originalSetting === undefined) {
          delete process.env.NOTIFICATIONS_ENABLED;
        } else {
          process.env.NOTIFICATIONS_ENABLED = originalSetting;
        }
        vi.unstubAllGlobals();
      }
    });

    it('bounds an approved outbound Trello comment without retrying the mutation', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      const originalSetting = process.env.NOTIFICATIONS_ENABLED;
      const originalKey = process.env.TRELLO_API_KEY;
      const originalToken = process.env.TRELLO_TOKEN;
      process.env.NOTIFICATIONS_ENABLED = 'true';
      process.env.TRELLO_API_KEY = 'test-key';
      process.env.TRELLO_TOKEN = 'test-token';
      vi.stubGlobal('fetch', fetchSpy);

      try {
        await expect(postTrelloComment('card/with space', 'Approved update')).resolves.toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]?.[0]).toContain('cards/card%2Fwith%20space/actions/comments');
        expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
        expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        if (originalSetting === undefined) {
          delete process.env.NOTIFICATIONS_ENABLED;
        } else {
          process.env.NOTIFICATIONS_ENABLED = originalSetting;
        }
        if (originalKey === undefined) delete process.env.TRELLO_API_KEY;
        else process.env.TRELLO_API_KEY = originalKey;
        if (originalToken === undefined) delete process.env.TRELLO_TOKEN;
        else process.env.TRELLO_TOKEN = originalToken;
        vi.unstubAllGlobals();
      }
    });
  });

  describe('parseBotCommand', () => {
    it('should parse @bot status command', () => {
      const result = parseBotCommand(
        '@bot status',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('status');
      expect(result?.args).toEqual([]);
      expect(result?.cardId).toBe('card123');
      expect(result?.authorName).toBe('Test User');
    });

    it('should parse @bot remind command with worker mention', () => {
      const result = parseBotCommand(
        '@bot remind @worker Please update the task',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('remind');
      expect(result?.args).toContain('@worker');
      expect(result?.rawArgs).toContain('Please update the task');
    });

    it('should parse @bot help command', () => {
      const result = parseBotCommand(
        '@bot help',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('help');
    });

    it('should return null for non-bot comments', () => {
      const result = parseBotCommand(
        'This is a regular comment',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).toBeNull();
    });

    it('should handle case-insensitive @BOT mentions', () => {
      const result = parseBotCommand(
        '@BOT STATUS',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('status');
    });

    it('should parse @bot checkin command', () => {
      const result = parseBotCommand(
        '@bot checkin',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('checkin');
    });

    it('should parse @bot time command', () => {
      const result = parseBotCommand(
        '@bot time',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('time');
    });

    it('should parse @bot progress command', () => {
      const result = parseBotCommand(
        '@bot progress',
        'card123',
        'comment456',
        'author789',
        'Test User'
      );

      expect(result).not.toBeNull();
      expect(result?.command).toBe('progress');
    });
  });

  describe('processBotCommand', () => {
    it('should handle help command', async () => {
      const cmd = {
        command: 'help',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Bot Commands');
      expect(response.text).toContain('@bot status');
      expect(response.text).toContain('@bot checkin');
      expect(response.text).toContain('@bot remind');
    });

    it('should handle unknown command', async () => {
      const cmd = {
        command: 'unknown',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain("don't recognize");
      expect(response.text).toContain('@bot help');
    });

    it('should handle status command without card data', async () => {
      const cmd = {
        command: 'status',
        args: [],
        rawArgs: '',
        cardId: 'nonexistent-card',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Status Update');
    });

    it('should handle checkin command', async () => {
      const cmd = {
        command: 'checkin',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Progress Check-in');
      expect(response.text).toContain('Test User');
    });

    it('should handle remind command without worker name', async () => {
      const cmd = {
        command: 'remind',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Usage');
      expect(response.text).toContain('@bot remind @workername');
    });

    it('should handle time command', async () => {
      const cmd = {
        command: 'time',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Time Tracking');
    });

    it('should handle progress command', async () => {
      const cmd = {
        command: 'progress',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Progress Report');
    });

    // Test command aliases
    it('should handle check alias for checkin', async () => {
      const cmd = {
        command: 'check',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Progress Check-in');
    });

    it('should handle timer alias for time', async () => {
      const cmd = {
        command: 'timer',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Time Tracking');
    });

    it('should handle report alias for progress', async () => {
      const cmd = {
        command: 'report',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Progress Report');
    });

    it('should handle ? alias for help', async () => {
      const cmd = {
        command: '?',
        args: [],
        rawArgs: '',
        cardId: 'card123',
        commentId: 'comment456',
        authorId: 'author789',
        authorName: 'Test User',
      };

      const response = await processBotCommand(cmd);

      expect(response.text).toContain('Bot Commands');
    });
  });
});
