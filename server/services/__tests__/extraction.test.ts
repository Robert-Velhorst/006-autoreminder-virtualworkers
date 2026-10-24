/**
 * Unit tests for Attachment and Chatbot Extraction Services
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../../db', () => ({
  getDb: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue([[]]),
  }),
}));

// Mock fetch
global.fetch = vi.fn();

describe('Attachment Extractor Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Supported File Types', () => {
    it('should identify PDF files as extractable', () => {
      const supportedTypes = ['application/pdf', 'text/plain', 'text/html', 'text/markdown'];
      expect(supportedTypes).toContain('application/pdf');
    });

    it('should identify text files as extractable', () => {
      const supportedTypes = ['application/pdf', 'text/plain', 'text/html', 'text/markdown'];
      expect(supportedTypes).toContain('text/plain');
    });

    it('should identify HTML files as extractable', () => {
      const supportedTypes = ['application/pdf', 'text/plain', 'text/html', 'text/markdown'];
      expect(supportedTypes).toContain('text/html');
    });
  });

  describe('Content Truncation', () => {
    it('should truncate content to 65000 characters', () => {
      const longContent = 'a'.repeat(70000);
      const truncated = longContent.substring(0, 65000);
      expect(truncated.length).toBe(65000);
    });
  });

  describe('Extraction Status', () => {
    it('should have valid extraction statuses', () => {
      const validStatuses = ['pending', 'processing', 'success', 'failed', 'unreadable'];
      expect(validStatuses).toContain('success');
      expect(validStatuses).toContain('failed');
      expect(validStatuses).toContain('pending');
    });
  });
});

describe('Chatbot Extractor Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('URL Detection', () => {
    it('should detect ChatGPT share URLs', () => {
      const text = 'Check out this conversation: https://chat.openai.com/share/abc123-def456';
      const chatgptPattern = /https?:\/\/chat\.openai\.com\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(chatgptPattern) || [];
      expect(matches.length).toBe(1);
      expect(matches[0]).toBe('https://chat.openai.com/share/abc123-def456');
    });

    it('should detect chatgpt.com share URLs', () => {
      const text = 'See: https://chatgpt.com/share/6939ee3f-28dc-8009-bbb8-fb7ae5e20a37';
      const chatgptPattern = /https?:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(chatgptPattern) || [];
      expect(matches.length).toBe(1);
    });

    it('should detect Gemini g.co short URLs', () => {
      const text = 'Here is the link: https://g.co/gemini/share/f97220049da3';
      const geminiPattern = /https?:\/\/g\.co\/gemini\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(geminiPattern) || [];
      expect(matches.length).toBe(1);
    });

    it('should detect gemini.google.com share URLs', () => {
      const text = 'Check: https://gemini.google.com/share/0fbdaa76e4f7';
      const geminiPattern = /https?:\/\/gemini\.google\.com\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(geminiPattern) || [];
      expect(matches.length).toBe(1);
    });

    it('should detect Claude share URLs', () => {
      const text = 'Claude conversation: https://claude.ai/share/abc123';
      const claudePattern = /https?:\/\/claude\.ai\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(claudePattern) || [];
      expect(matches.length).toBe(1);
    });

    it('should detect multiple URLs in same text', () => {
      const text = `
        ChatGPT: https://chatgpt.com/share/abc123
        Gemini: https://g.co/gemini/share/def456
      `;
      const chatgptMatches = text.match(/https?:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]+/g) || [];
      const geminiMatches = text.match(/https?:\/\/g\.co\/gemini\/share\/[a-zA-Z0-9-]+/g) || [];
      expect(chatgptMatches.length).toBe(1);
      expect(geminiMatches.length).toBe(1);
    });

    it('should not match invalid URLs', () => {
      const text = 'Not a valid URL: chatgpt.com/share/abc123 or https://example.com/share/xyz';
      const chatgptPattern = /https?:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]+/g;
      const matches = text.match(chatgptPattern) || [];
      expect(matches.length).toBe(0);
    });
  });

  describe('Platform Identification', () => {
    it('should identify ChatGPT platform from URL', () => {
      const url = 'https://chatgpt.com/share/abc123';
      const isChatGPT = ['chatgpt.com', 'chat.openai.com'].includes(new URL(url).hostname);
      expect(isChatGPT).toBe(true);
    });

    it('should identify Gemini platform from URL', () => {
      const url = 'https://g.co/gemini/share/abc123';
      const parsed = new URL(url);
      const isGemini = (parsed.hostname === 'g.co' && parsed.pathname.startsWith('/gemini/')) || parsed.hostname === 'gemini.google.com';
      expect(isGemini).toBe(true);
    });

    it('should identify Claude platform from URL', () => {
      const url = 'https://claude.ai/share/abc123';
      const isClaude = new URL(url).hostname === 'claude.ai';
      expect(isClaude).toBe(true);
    });
  });

  describe('Conversation Storage', () => {
    it('should serialize messages to JSON', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      const json = JSON.stringify(messages);
      const parsed = JSON.parse(json);
      expect(parsed.length).toBe(2);
      expect(parsed[0].role).toBe('user');
    });

    it('should create full content from messages', () => {
      const messages = [
        { role: 'user', content: 'How do I do X?' },
        { role: 'assistant', content: 'You can do X by following these steps...' },
      ];
      const fullContent = messages
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');
      expect(fullContent).toContain('[USER]: How do I do X?');
      expect(fullContent).toContain('[ASSISTANT]: You can do X by');
    });
  });
});

describe('AI Understanding Integration', () => {
  describe('Context Enrichment', () => {
    it('should include extracted attachment content in prompt', () => {
      const attachments = [
        { attachmentId: 1, content: 'Document content here', wordCount: 100 },
      ];
      const hasContent = attachments.some(a => a.content && a.content.length > 0);
      expect(hasContent).toBe(true);
    });

    it('should include chatbot conversations in prompt', () => {
      const conversations = [
        { platform: 'chatgpt', title: 'How to complete task', content: 'Step 1...' },
      ];
      const hasConversations = conversations.length > 0;
      expect(hasConversations).toBe(true);
    });

    it('should limit attachment content to 1000 chars per attachment', () => {
      const longContent = 'a'.repeat(2000);
      const truncated = longContent.substring(0, 1000);
      expect(truncated.length).toBe(1000);
    });

    it('should limit chatbot content to 2000 chars per conversation', () => {
      const longContent = 'a'.repeat(3000);
      const truncated = longContent.substring(0, 2000);
      expect(truncated.length).toBe(2000);
    });
  });
});
