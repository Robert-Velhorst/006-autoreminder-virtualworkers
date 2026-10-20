/**
 * Chatbot URL Context Extraction Service
 * 
 * Detects and extracts conversation content from chatbot share URLs:
 * - ChatGPT share links (chat.openai.com/share/...)
 * - Gemini share links (g.co/gemini/share/...)
 * - Claude share links (claude.ai/share/...)
 * 
 * This captures valuable "how-to" knowledge from VA conversations
 * to enrich task understanding and build a knowledge base.
 */

import { getDb } from '../db';
import { and, isNotNull, ne, sql } from 'drizzle-orm';
import { atisCards, atisComments } from '../../drizzle/schema.postgres';
import { fetchWithRetry } from '../utils/retry';
import { convert } from 'html-to-text';

interface ChatbotConversation {
  platform: 'chatgpt' | 'gemini' | 'claude' | 'unknown';
  url: string;
  title?: string;
  messages: ChatMessage[];
  extractedAt: Date;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ExtractionResult {
  success: boolean;
  conversation?: ChatbotConversation;
  error?: string;
}

interface DetectedUrl {
  url: string;
  platform: 'chatgpt' | 'gemini' | 'claude' | 'unknown';
  cardId: number;
  commentId?: number;
  source: 'description' | 'comment' | 'attachment_name';
}

export class ChatbotExtractorService {
  // URL patterns for different chatbot platforms
  private patterns = {
    chatgpt: [
      /https?:\/\/chat\.openai\.com\/share\/[a-zA-Z0-9-]+/g,
      /https?:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]+/g,
    ],
    gemini: [
      /https?:\/\/g\.co\/gemini\/share\/[a-zA-Z0-9-]+/g,
      /https?:\/\/gemini\.google\.com\/share\/[a-zA-Z0-9-]+/g,
    ],
    claude: [
      /https?:\/\/claude\.ai\/share\/[a-zA-Z0-9-]+/g,
    ],
  };

  /**
   * Detect chatbot URLs in text
   */
  detectUrls(text: string): { url: string; platform: 'chatgpt' | 'gemini' | 'claude' }[] {
    const results: { url: string; platform: 'chatgpt' | 'gemini' | 'claude' }[] = [];

    for (const [platform, patterns] of Object.entries(this.patterns)) {
      for (const pattern of patterns) {
        const matches = text.match(pattern) || [];
        for (const url of matches) {
          results.push({ url, platform: platform as 'chatgpt' | 'gemini' | 'claude' });
        }
      }
    }

    return results;
  }

  /**
   * Extract conversation from ChatGPT share link
   */
  private async extractChatGPT(url: string): Promise<ExtractionResult> {
    try {
      // ChatGPT share pages render client-side, so we need to fetch the page
      // and look for embedded JSON data or parse the HTML
      const response = await fetchWithRetry(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VADashboard/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        return { success: false, error: `Failed to fetch: ${response.status}` };
      }

      const html = await response.text();
      
      // Try to extract conversation data from the page
      // ChatGPT embeds data in a script tag with __NEXT_DATA__
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
      
      if (nextDataMatch) {
        try {
          const data = JSON.parse(nextDataMatch[1]);
          const serverResponse = data?.props?.pageProps?.serverResponse;
          
          if (serverResponse?.data) {
            const conversation = serverResponse.data;
            const messages: ChatMessage[] = [];
            
            // Extract messages from the conversation tree
            if (conversation.mapping) {
              const sortedNodes = Object.values(conversation.mapping as Record<string, any>)
                .filter((node: any) => node.message?.content?.parts)
                .sort((a: any, b: any) => {
                  const timeA = a.message?.create_time || 0;
                  const timeB = b.message?.create_time || 0;
                  return timeA - timeB;
                });

              for (const node of sortedNodes) {
                const msg = node.message;
                if (msg?.content?.parts?.length > 0) {
                  messages.push({
                    role: msg.author?.role === 'user' ? 'user' : 'assistant',
                    content: msg.content.parts.join('\n'),
                  });
                }
              }
            }

            return {
              success: true,
              conversation: {
                platform: 'chatgpt',
                url,
                title: conversation.title || 'Untitled Conversation',
                messages,
                extractedAt: new Date(),
              },
            };
          }
        } catch (parseError) {
          console.error('[ChatbotExtractor] Failed to parse ChatGPT data:', parseError);
        }
      }

      // Fallback: Try to extract visible text from HTML
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(' | ChatGPT', '').trim() : 'ChatGPT Conversation';

      // Extract text content from conversation divs
      const conversationText = this.extractVisibleText(html);

      return {
        success: true,
        conversation: {
          platform: 'chatgpt',
          url,
          title,
          messages: conversationText ? [{ role: 'assistant', content: conversationText }] : [],
          extractedAt: new Date(),
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract conversation from Gemini share link
   */
  private async extractGemini(url: string): Promise<ExtractionResult> {
    try {
      const response = await fetchWithRetry(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VADashboard/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        return { success: false, error: `Failed to fetch: ${response.status}` };
      }

      const html = await response.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].trim() : 'Gemini Conversation';

      // Extract visible text
      const conversationText = this.extractVisibleText(html);

      return {
        success: true,
        conversation: {
          platform: 'gemini',
          url,
          title,
          messages: conversationText ? [{ role: 'assistant', content: conversationText }] : [],
          extractedAt: new Date(),
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract conversation from Claude share link
   */
  private async extractClaude(url: string): Promise<ExtractionResult> {
    try {
      const response = await fetchWithRetry(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VADashboard/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        return { success: false, error: `Failed to fetch: ${response.status}` };
      }

      const html = await response.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].trim() : 'Claude Conversation';

      // Extract visible text
      const conversationText = this.extractVisibleText(html);

      return {
        success: true,
        conversation: {
          platform: 'claude',
          url,
          title,
          messages: conversationText ? [{ role: 'assistant', content: conversationText }] : [],
          extractedAt: new Date(),
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract conversation text without executable page content.
   */
  private extractVisibleText(html: string): string {
    const text = convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'h1', options: { uppercase: false } },
        { selector: 'h2', options: { uppercase: false } },
        { selector: 'h3', options: { uppercase: false } },
      ],
    });
    return text.replace(/\s+/g, ' ').trim().substring(0, 10000);
  }

  /**
   * Extract conversation from any supported platform
   */
  async extractConversation(url: string, platform: 'chatgpt' | 'gemini' | 'claude' | 'unknown'): Promise<ExtractionResult> {
    switch (platform) {
      case 'chatgpt':
        return this.extractChatGPT(url);
      case 'gemini':
        return this.extractGemini(url);
      case 'claude':
        return this.extractClaude(url);
      default:
        return { success: false, error: 'Unknown platform' };
    }
  }

  /**
   * Scan cards and comments for chatbot URLs
   */
  async scanForChatbotUrls(): Promise<DetectedUrl[]> {
    const db = await getDb();
    if (!db) return [];

    const detected: DetectedUrl[] = [];

    // Scan card descriptions
    const cards = await db.select({ id: atisCards.id, description: atisCards.description })
      .from(atisCards)
      .where(and(isNotNull(atisCards.description), ne(atisCards.description, '')));

    for (const card of cards) {
      const urls = this.detectUrls(card.description || '');
      for (const { url, platform } of urls) {
        detected.push({
          url,
          platform,
          cardId: card.id,
          source: 'description',
        });
      }
    }

    // Scan comments
    const comments = await db.select({ id: atisComments.id, cardId: atisComments.cardId, text: atisComments.text })
      .from(atisComments)
      .where(ne(atisComments.text, ''));

    for (const comment of comments) {
      const urls = this.detectUrls(comment.text || '');
      for (const { url, platform } of urls) {
        detected.push({
          url,
          platform,
          cardId: comment.cardId,
          commentId: comment.id,
          source: 'comment',
        });
      }
    }

    return detected;
  }

  /**
   * Store extracted conversation in database
   */
  async storeConversation(
    cardId: number,
    conversation: ChatbotConversation,
    sourceUrl: string,
    commentId?: number
  ): Promise<number | null> {
    const db = await getDb();
    if (!db) return null;

    try {
      // Serialize messages to JSON
      const messagesJson = JSON.stringify(conversation.messages);
      
      // Create full content text for AI context
      const fullContent = conversation.messages
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

      const result = await db.execute(sql`
        INSERT INTO atis_chatbot_conversations 
        (card_id, comment_id, platform, url, title, messages_json, full_content, extracted_at)
        VALUES (
          ${cardId},
          ${commentId || null},
          ${conversation.platform},
          ${sourceUrl},
          ${conversation.title || 'Untitled'},
          ${messagesJson},
          ${fullContent.substring(0, 65000)},
          NOW()
        )
        RETURNING id
      `);

      const inserted = result.rows[0] as { id: number } | undefined;
      return inserted?.id ?? null;
    } catch (error: any) {
      console.error('[ChatbotExtractor] Failed to store conversation:', error.message);
      return null;
    }
  }

  /**
   * Process detected URLs and extract conversations
   */
  async processDetectedUrls(limit: number = 20): Promise<{
    processed: number;
    success: number;
    failed: number;
  }> {
    const db = await getDb();
    if (!db) return { processed: 0, success: 0, failed: 0 };

    // Get already processed URLs
    const existingResult = await db.execute(sql`
      SELECT url FROM atis_chatbot_conversations
    `);
    const existingRows = existingResult.rows as Array<{ url: string }>;
    const existingUrls = new Set(existingRows.map(row => row.url));

    // Scan for new URLs
    const detected = await this.scanForChatbotUrls();
    const newUrls = detected.filter(d => !existingUrls.has(d.url));

    let success = 0;
    let failed = 0;
    const toProcess = newUrls.slice(0, limit);

    for (const detection of toProcess) {
      console.log(`[ChatbotExtractor] Processing ${detection.platform} URL: ${detection.url}`);
      
      const result = await this.extractConversation(detection.url, detection.platform);
      
      if (result.success && result.conversation) {
        const stored = await this.storeConversation(
          detection.cardId,
          result.conversation,
          detection.url,
          detection.commentId
        );
        
        if (stored) {
          success++;
          console.log(`[ChatbotExtractor] Stored conversation: ${result.conversation.title}`);
        } else {
          failed++;
        }
      } else {
        failed++;
        console.log(`[ChatbotExtractor] Failed: ${result.error}`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
      processed: toProcess.length,
      success,
      failed,
    };
  }

  /**
   * Get chatbot conversations for a card
   */
  async getCardConversations(cardId: number): Promise<ChatbotConversation[]> {
    const db = await getDb();
    if (!db) return [];

    const result = await db.execute(sql`
      SELECT platform, url, title, messages_json, extracted_at
      FROM atis_chatbot_conversations
      WHERE card_id = ${cardId}
      ORDER BY extracted_at DESC
    `);

    const rows = result.rows as Array<{
      platform: ChatbotConversation['platform'];
      url: string;
      title: string | null;
      messages_json: string | null;
      extracted_at: Date | string;
    }>;
    return rows.map((r: any) => ({
      platform: r.platform,
      url: r.url,
      title: r.title,
      messages: JSON.parse(r.messages_json || '[]'),
      extractedAt: new Date(r.extracted_at),
    }));
  }

  /**
   * Get extraction statistics
   */
  async getStats(): Promise<{
    totalConversations: number;
    byPlatform: Record<string, number>;
    detectedUrls: number;
    pendingUrls: number;
  }> {
    const db = await getDb();
    if (!db) {
      return { totalConversations: 0, byPlatform: {}, detectedUrls: 0, pendingUrls: 0 };
    }

    // Get stored conversations count
    const countResult = await db.execute(sql`
      SELECT platform, COUNT(*) as count
      FROM atis_chatbot_conversations
      GROUP BY platform
    `);
    const counts = countResult.rows as Array<{ platform: string; count: string | number }>;
    
    const byPlatform: Record<string, number> = {};
    let total = 0;
    for (const row of counts) {
      byPlatform[row.platform] = Number(row.count);
      total += Number(row.count);
    }

    // Get existing URLs
    const existingResult = await db.execute(sql`
      SELECT url FROM atis_chatbot_conversations
    `);
    const existingRows = existingResult.rows as Array<{ url: string }>;
    const existingUrls = new Set(existingRows.map(row => row.url));

    // Scan for all URLs
    const detected = await this.scanForChatbotUrls();
    const uniqueUrls = new Set(detected.map(d => d.url));
    const pendingUrls = Array.from(uniqueUrls).filter(url => !existingUrls.has(url)).length;

    return {
      totalConversations: total,
      byPlatform,
      detectedUrls: uniqueUrls.size,
      pendingUrls,
    };
  }
}

/**
 * Create chatbot extractor service instance
 */
export function createChatbotExtractor(): ChatbotExtractorService {
  return new ChatbotExtractorService();
}
