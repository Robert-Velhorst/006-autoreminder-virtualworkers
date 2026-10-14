/**
 * ATIS Data Ingestion Service
 * 
 * Fetches ALL data from Trello and stores it in the database.
 * This is the foundation for the knowledge-based task breakdown system.
 */

import { getDb } from '../db';
import { 
  atisWorkspaces, 
  atisBoards, 
  atisCards, 
  atisAttachments, 
  atisComments,
  atisIngestionJobs,
  type InsertATISCard,
  type InsertATISAttachment,
  type InsertATISComment,
} from '../../drizzle/schema.postgres';
import { eq, and, sql } from 'drizzle-orm';
import { fetchWithRetry } from '../utils/retry';

const TRELLO_API_BASE = 'https://api.trello.com/1';

interface TrelloCredentials {
  apiKey: string;
  token: string;
}

interface IngestionProgress {
  jobId: number;
  phase: string;
  current: number;
  total: number;
  message: string;
}

type ProgressCallback = (progress: IngestionProgress) => void;

/**
 * Main ingestion service class
 */
export class ATISIngestionService {
  private credentials: TrelloCredentials;
  private onProgress?: ProgressCallback;

  constructor(credentials: TrelloCredentials, onProgress?: ProgressCallback) {
    this.credentials = credentials;
    this.onProgress = onProgress;
  }

  /**
   * Build Trello API URL with authentication
   */
  private buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${TRELLO_API_BASE}${endpoint}`);
    url.searchParams.set('key', this.credentials.apiKey);
    url.searchParams.set('token', this.credentials.token);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Fetch from Trello API with retry logic
   */
  private async fetchTrello<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    const response = await fetchWithRetry(url, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Trello API error: ${response.status} - ${text}`);
    }
    
    return response.json() as Promise<T>;
  }

  /**
   * Determine file type from mime type or filename
   */
  determineFileType(mimeType: string, filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    
    if (mimeType?.includes('pdf') || ext === 'pdf') return 'pdf';
    if (mimeType?.includes('word') || ext === 'docx' || ext === 'doc') return 'docx';
    if (mimeType?.includes('excel') || mimeType?.includes('spreadsheet') || ext === 'xlsx' || ext === 'xls') return 'xlsx';
    if (mimeType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) return 'image';
    if (mimeType?.includes('email') || ext === 'eml' || ext === 'msg') return 'email';
    if (filename.startsWith('http://') || filename.startsWith('https://')) return 'link';
    
    return 'other';
  }

  /**
   * Get ingestion statistics
   */
  async getStats(): Promise<{
    workspaces: number;
    boards: number;
    cards: number;
    attachments: number;
    comments: number;
    pendingAttachments: number;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const [workspaceResult] = await db.select({ count: sql<number>`count(*)` }).from(atisWorkspaces);
    const [boardResult] = await db.select({ count: sql<number>`count(*)` }).from(atisBoards);
    const [cardResult] = await db.select({ count: sql<number>`count(*)` }).from(atisCards);
    const [attachmentResult] = await db.select({ count: sql<number>`count(*)` }).from(atisAttachments);
    const [commentResult] = await db.select({ count: sql<number>`count(*)` }).from(atisComments);
    const pendingAttachments = await db.select()
      .from(atisAttachments)
      .where(eq(atisAttachments.extractionStatus, 'pending'));

    return {
      workspaces: Number(workspaceResult?.count) || 0,
      boards: Number(boardResult?.count) || 0,
      cards: Number(cardResult?.count) || 0,
      attachments: Number(attachmentResult?.count) || 0,
      comments: Number(commentResult?.count) || 0,
      pendingAttachments: pendingAttachments.length,
    };
  }
}

/**
 * Create an ingestion service instance with credentials from environment
 */
export function createIngestionService(onProgress?: ProgressCallback): ATISIngestionService {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    throw new Error('TRELLO_API_KEY and TRELLO_TOKEN must be set in environment');
  }

  return new ATISIngestionService({ apiKey, token }, onProgress);
}
