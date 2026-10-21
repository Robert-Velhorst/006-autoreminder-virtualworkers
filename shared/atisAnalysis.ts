export const ATIS_ANALYSIS_MAX_CARDS = 100;
export const ATIS_ANALYSIS_PREVIEW_TTL_MS = 10 * 60_000;

export type AtisAnalysisGuidance = {
  goal?: string;
  deliverable?: string;
  successCriteria?: string[];
};

export type AtisAnalysisSelection = {
  mode: "pending" | "low_confidence" | "reanalyze" | "single" | "active_placeholders";
  cardId?: number;
  cardIds?: number[];
  boardId?: number;
  forceAll?: boolean;
  minConfidence?: number;
  limit?: number;
  afterCardId?: number;
  guidance?: AtisAnalysisGuidance;
};

export type AtisAnalysisPreview = {
  id: string;
  expiresAt: string;
  matched: number;
  total: number;
  remaining: number;
  nextAfterCardId?: number;
  cards: Array<{ id: number; name: string }>;
  recoveryOperationId?: number;
};

export type AtisAnalysisItemState = "pending" | "calling" | "generated" | "fallback" | "missing" | "failed" | "uncertain";

export type AtisAnalysisJob = {
  id: string;
  operationId?: number;
  state: "queued" | "running" | "completed" | "failed" | "interrupted";
  matched: number;
  total: number;
  remaining: number;
  nextAfterCardId?: number;
  processed: number;
  generated: number;
  fallback: number;
  missing: number;
  failed: number;
  uncertain: number;
  pending: number;
  items: Array<{ cardId: number; cardName: string; state: AtisAnalysisItemState }>;
  error?: string;
};
