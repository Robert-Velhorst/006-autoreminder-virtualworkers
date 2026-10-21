import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  storeConversation: vi.fn(),
  updateConversationResponse: vi.fn(),
  isNaturalLanguageQuery: vi.fn(),
  handleNaturalLanguageQuery: vi.fn(),
}));

vi.mock('../../db', async importOriginal => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getDb: mocks.getDb,
}));
vi.mock('../chatbot-history', () => ({
  storeConversation: mocks.storeConversation,
  updateConversationResponse: mocks.updateConversationResponse,
}));
vi.mock('../ai-chatbot-handler', () => ({
  isNaturalLanguageQuery: mocks.isNaturalLanguageQuery,
  handleNaturalLanguageQuery: mocks.handleNaturalLanguageQuery,
}));

import {
  isTrelloCommentAutomationEnabled,
  parseBotCommand,
  postTrelloComment,
  processBotCommand,
  handleTrelloWebhook,
} from '../trello-chatbot';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockPilotOwners(
  planOwners: number[],
  assignedWorkerIds: number[] = [],
  webhookAuthorIds?: number[],
) {
  const authorLimit = vi.fn().mockResolvedValue((webhookAuthorIds ?? []).map(vaId => ({ vaId })));
  const planLimit = vi.fn().mockResolvedValue(planOwners.map(vaId => ({ vaId })));
  const assignmentLimit = vi.fn().mockResolvedValue(assignedWorkerIds.map(vaId => ({ vaId })));
  const select = vi.fn();
  if (webhookAuthorIds !== undefined) {
    select.mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: authorLimit })) })) });
  }
  select
    .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: planLimit })) })) })
    .mockReturnValueOnce({ from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: assignmentLimit })) })),
    })) });
  mocks.getDb.mockResolvedValue({ select });
}

describe('Trello Chatbot', () => {
  describe('external comment safety', () => {
    it.each(['revoked', 'read-error', 'unchanged', 'post-dispatch-error'])('runs the final guard after deferred readiness: %s', async outcome => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mockPilotOwners([10]);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const database = await mocks.getDb();
      mocks.getDb.mockImplementation(async () => { await ready; return database; });
      const fetchSpy = vi.fn().mockImplementation(async () => {
        if (outcome === 'post-dispatch-error') throw new Error('Connection lost');
        return { ok: true };
      });
      vi.stubGlobal('fetch', fetchSpy);
      let allowed = true;
      const guard = vi.fn(async () => {
        if (outcome === 'read-error') throw new Error('Read unavailable');
        return allowed;
      });
      const pending = postTrelloComment('0123456789abcdef01234567', 'Approved question', guard);
      await Promise.resolve();
      expect(guard).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      if (outcome === 'revoked') allowed = false;
      release();
      expect(await pending).toBe(outcome === 'unchanged');
      expect(guard).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledTimes(outcome === 'unchanged' || outcome === 'post-dispatch-error' ? 1 : 0);
    });

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
        await expect(postTrelloComment('0123456789abcdef01234567', 'Approved update')).resolves.toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]?.[0]).toContain('cards/0123456789abcdef01234567/actions/comments');
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

    it.each(['card/with space', '../members/me', '%2fadmin'])('rejects unsafe comment target %s without provider traffic', async cardId => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(postTrelloComment(cardId, 'Unsent update')).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('blocks comments on a card mapped to an APTLSS pilot worker before Trello is called', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([9]);

      await expect(postTrelloComment('pilot-card', 'Automatic reminder')).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed when pilot ownership cannot be determined', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);

      await expect(postTrelloComment('unmapped-card', 'Automatic reminder')).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed when a configured pilot list is malformed', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9,not-a-worker');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);

      await expect(postTrelloComment('unmapped-card', 'Automatic reminder')).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.getDb).not.toHaveBeenCalled();
    });

    it('fails closed when pilot IDs exist without shadow-only mode', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'false');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);

      await expect(postTrelloComment('unmapped-card', 'Automatic reminder')).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.getDb).not.toHaveBeenCalled();
    });

    it('does not generate or persist a bot response when comment automation is disabled', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
      mocks.isNaturalLanguageQuery.mockReturnValue(true);

      await handleTrelloWebhook({
        action: {
          type: 'commentCard',
          id: 'incoming-comment',
          data: { text: '@bot what should I do?', card: { id: 'card-1', name: 'Task' }, board: { id: 'board-1' } },
          memberCreator: { id: 'member-1', fullName: 'Worker' },
        },
      });

      expect(mocks.handleNaturalLanguageQuery).not.toHaveBeenCalled();
      expect(mocks.storeConversation).not.toHaveBeenCalled();
      expect(mocks.updateConversationResponse).not.toHaveBeenCalled();
    });

    it('preserves comments when the card is explicitly mapped only to non-pilot workers', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([10]);

      await expect(postTrelloComment('0123456789abcdef01234568', 'Automatic reminder')).resolves.toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mocks.getDb).toHaveBeenCalledTimes(1);
    });

    it('holds a card assigned to a pilot worker even when its saved plan belongs to another worker', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([10], [9]);

      await expect(postTrelloComment('shared-card', 'Automatic reminder')).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('holds an AI webhook reply triggered by a pilot worker even on another worker\'s card', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([10], [], [9]);
      mocks.isNaturalLanguageQuery.mockReturnValue(true);
      mocks.handleNaturalLanguageQuery.mockResolvedValue({ text: 'Generated answer' });
      mocks.storeConversation.mockResolvedValue(11);

      await handleTrelloWebhook({
        action: {
          type: 'commentCard',
          id: 'incoming-comment',
          data: { text: '@bot what should I do?', card: { id: 'pilot-card', name: 'Pilot task' }, board: { id: 'board-1' } },
          memberCreator: { id: 'member-1', fullName: 'Pilot worker' },
        },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.updateConversationResponse).toHaveBeenCalledWith(
        11,
        '',
        'Generated answer',
        'failed',
        expect.stringContaining('pilot workers cannot trigger automatic Trello replies'),
      );
    });

    it('fails closed when a webhook author is not linked to a worker profile', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([10], [], []);
      mocks.isNaturalLanguageQuery.mockReturnValue(true);
      mocks.handleNaturalLanguageQuery.mockResolvedValue({ text: 'Generated answer' });
      mocks.storeConversation.mockResolvedValue(12);

      await handleTrelloWebhook({
        action: {
          type: 'commentCard',
          id: 'incoming-comment',
          data: { text: '@bot what should I do?', card: { id: '0123456789abcdef01234568', name: 'Other task' }, board: { id: 'board-1' } },
          memberCreator: { id: 'unlinked-member', fullName: 'Unknown worker' },
        },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.updateConversationResponse).toHaveBeenCalledWith(
        12,
        '',
        'Generated answer',
        'failed',
        expect.stringContaining('Trello author could not be verified'),
      );
    });

    it('keeps automatic replies for a linked non-pilot worker on a non-pilot card', async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
      vi.stubEnv('TRELLO_API_KEY', 'test-key');
      vi.stubEnv('TRELLO_TOKEN', 'test-token');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
      mockPilotOwners([10], [], [10]);
      mocks.isNaturalLanguageQuery.mockReturnValue(true);
      mocks.handleNaturalLanguageQuery.mockResolvedValue({ text: 'Generated answer' });
      mocks.storeConversation.mockResolvedValue(13);

      await handleTrelloWebhook({
        action: {
          type: 'commentCard',
          id: 'incoming-comment',
          data: { text: '@bot what should I do?', card: { id: '0123456789abcdef01234568', name: 'Other task' }, board: { id: 'board-1' } },
          memberCreator: { id: 'non-pilot-member', fullName: 'Non-pilot worker' },
        },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mocks.updateConversationResponse).toHaveBeenCalledWith(13, '', 'Generated answer', 'success', undefined);
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
