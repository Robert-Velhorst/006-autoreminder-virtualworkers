/**
 * Attachment Content Extraction Service
 * 
 * Extracts text content from various attachment types:
 * - PDFs using pdf-parse
 * - Documents (txt, md, html)
 * - Images (basic metadata, OCR would require additional setup)
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { fetchWithRetry } from '../utils/retry';
import { createRequire } from 'module';

// pdf-parse doesn't have proper ESM exports, use createRequire
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

interface ExtractionResult {
  success: boolean;
  content?: string;
  wordCount?: number;
  pageCount?: number;
  error?: string;
  extractedAt?: Date;
}

interface AttachmentInfo {
  id: number;
  trelloId: string;
  cardId: number;
  name: string;
  url: string;
  mimeType: string | null;
  bytes: number | null;
}

export class AttachmentExtractorService {
  private trelloApiKey: string;
  private trelloToken: string;

  constructor() {
    this.trelloApiKey = process.env.TRELLO_API_KEY || '';
    this.trelloToken = process.env.TRELLO_TOKEN || '';
  }

  /**
   * Get file extension from filename
   */
  private getExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  /**
   * Determine if file type is extractable
   */
  private isExtractable(filename: string, mimeType: string | null): boolean {
    const ext = this.getExtension(filename);
    const extractableExtensions = ['pdf', 'txt', 'md', 'html', 'htm', 'json', 'csv', 'xml'];
    const extractableMimes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/html',
      'application/json',
      'text/csv',
      'application/xml',
      'text/xml',
    ];

    return extractableExtensions.includes(ext) || 
           (mimeType !== null && extractableMimes.includes(mimeType));
  }

  /**
   * Download attachment content from Trello
   */
  private async downloadAttachment(url: string): Promise<Buffer | null> {
    try {
      // Add API credentials only to Trello's attachment download endpoint.
      // CDN/S3 URLs are already signed and must never receive Trello secrets.
      const downloadUrl = new URL(url);
      const isTrelloAttachmentDownload =
        (downloadUrl.hostname === 'trello.com' || downloadUrl.hostname === 'api.trello.com') &&
        /^\/1\/cards\/[^/]+\/attachments\/[^/]+\/download(?:\/.*)?$/.test(downloadUrl.pathname);
      if (isTrelloAttachmentDownload) {
        downloadUrl.searchParams.set('key', this.trelloApiKey);
        downloadUrl.searchParams.set('token', this.trelloToken);
      }

      const response = await fetchWithRetry(downloadUrl.toString(), {
        headers: {
          'Accept': '*/*',
        },
      });

      if (!response.ok) {
        console.error(`[AttachmentExtractor] Failed to download: ${response.status}`);
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error: any) {
      console.error(`[AttachmentExtractor] Download error:`, error.message);
      return null;
    }
  }

  /**
   * Extract text from PDF
   */
  private async extractPdf(buffer: Buffer): Promise<ExtractionResult> {
    try {
      const data = await pdfParse(buffer);
      const content = data.text.trim();
      
      return {
        success: true,
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        pageCount: data.numpages,
        extractedAt: new Date(),
      };
    } catch (error: any) {
      return {
        success: false,
        error: `PDF extraction failed: ${error.message}`,
      };
    }
  }

  /**
   * Extract text from plain text files
   */
  private async extractText(buffer: Buffer): Promise<ExtractionResult> {
    try {
      const content = buffer.toString('utf-8').trim();
      
      return {
        success: true,
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        extractedAt: new Date(),
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Text extraction failed: ${error.message}`,
      };
    }
  }

  /**
   * Extract content from an attachment
   */
  async extractAttachment(attachment: AttachmentInfo): Promise<ExtractionResult> {
    const ext = this.getExtension(attachment.name);

    // Check if extractable
    if (!this.isExtractable(attachment.name, attachment.mimeType)) {
      return {
        success: false,
        error: `File type not supported for extraction: ${ext}`,
      };
    }

    // Download the file
    const buffer = await this.downloadAttachment(attachment.url);
    if (!buffer) {
      return {
        success: false,
        error: 'Failed to download attachment',
      };
    }

    // Extract based on type
    if (ext === 'pdf' || attachment.mimeType === 'application/pdf') {
      return this.extractPdf(buffer);
    } else if (['txt', 'md', 'html', 'htm', 'json', 'csv', 'xml'].includes(ext)) {
      return this.extractText(buffer);
    }

    return {
      success: false,
      error: `Unsupported file type: ${ext}`,
    };
  }

  /**
   * Store extracted content in database
   */
  async storeExtractedContent(
    attachmentId: number,
    result: ExtractionResult
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    try {
      if (result.success && result.content) {
        // Truncate content if too long (max 65535 chars for TEXT field)
        const truncatedContent = result.content.substring(0, 65000);
        
        await db.execute(sql`
          UPDATE atis_attachments
          SET 
            "extractedContent" = ${truncatedContent},
            "extractionStatus" = 'success',
            "extractedAt" = NOW()
          WHERE id = ${attachmentId}
        `);
      } else {
        await db.execute(sql`
          UPDATE atis_attachments
          SET 
            "extractionStatus" = 'failed',
            "extractionError" = ${result.error || 'Unknown error'}
          WHERE id = ${attachmentId}
        `);
      }
    } catch (error: any) {
      console.error(`[AttachmentExtractor] Failed to store content:`, error.message);
    }
  }

  /**
   * Process pending attachments
   */
  async processPendingAttachments(limit: number = 50): Promise<{
    processed: number;
    success: number;
    failed: number;
    skipped: number;
  }> {
    const db = await getDb();
    if (!db) {
      return { processed: 0, success: 0, failed: 0, skipped: 0 };
    }

    // Get pending attachments
    const result = await db.execute(sql`
      SELECT id, "trelloId", "cardId", COALESCE(filename, '') AS name,
        COALESCE(url, '') AS url, "mimeType", bytes
      FROM atis_attachments
      WHERE "extractionStatus" IS NULL OR "extractionStatus" = 'pending'
      LIMIT ${limit}
    `);

    const attachments = result.rows as unknown as AttachmentInfo[];
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const attachment of attachments) {
      // Skip non-extractable files
      if (!this.isExtractable(attachment.name, attachment.mimeType)) {
        await db.execute(sql`
          UPDATE atis_attachments
          SET "extractionStatus" = 'skipped'
          WHERE id = ${attachment.id}
        `);
        skipped++;
        continue;
      }

      console.log(`[AttachmentExtractor] Processing: ${attachment.name}`);
      
      const extractionResult = await this.extractAttachment(attachment);
      await this.storeExtractedContent(attachment.id, extractionResult);

      if (extractionResult.success) {
        success++;
        console.log(`[AttachmentExtractor] Extracted ${extractionResult.wordCount} words from ${attachment.name}`);
      } else {
        failed++;
        console.log(`[AttachmentExtractor] Failed: ${extractionResult.error}`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
      processed: attachments.length,
      success,
      failed,
      skipped,
    };
  }

  /**
   * Get extraction statistics
   */
  async getExtractionStats(): Promise<{
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    pending: number;
    totalWords: number;
  }> {
    const db = await getDb();
    if (!db) {
      return { total: 0, completed: 0, failed: 0, skipped: 0, pending: 0, totalWords: 0 };
    }

    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN "extractionStatus" = 'success' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN "extractionStatus" = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN "extractionStatus" = 'unreadable' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN "extractionStatus" IS NULL OR "extractionStatus" = 'pending' THEN 1 ELSE 0 END) as pending,
        0 as totalWords
      FROM atis_attachments
    `);

    const row = result.rows[0] || {};
    return {
      total: Number(row.total) || 0,
      completed: Number(row.completed) || 0,
      failed: Number(row.failed) || 0,
      skipped: Number(row.skipped) || 0,
      pending: Number(row.pending) || 0,
      totalWords: Number(row.totalWords) || 0,
    };
  }

  /**
   * Get extracted content for a card
   */
  async getCardAttachmentContent(cardId: number): Promise<string[]> {
    const db = await getDb();
    if (!db) return [];

    const result = await db.execute(sql`
      SELECT "extractedContent"
      FROM atis_attachments
      WHERE "cardId" = ${cardId}
      AND "extractionStatus" = 'success'
      AND "extractedContent" IS NOT NULL
    `);

    const rows = result.rows;
    return rows.map((r: any) => r.extractedContent).filter(Boolean);
  }
}

/**
 * Create extractor service instance
 */
export function createAttachmentExtractor(): AttachmentExtractorService {
  return new AttachmentExtractorService();
}
