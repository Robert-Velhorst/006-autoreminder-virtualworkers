import type { ChecklistItem } from './services/trello-checklist-sync';

export type ChecklistSyncCard = {
  cardId: number;
  trelloId: string;
  checklist: ChecklistItem[];
};

type ChecklistSyncRow = {
  id?: unknown;
  trello_id?: unknown;
  aptlssChecklist?: unknown;
};

function toChecklistItem(value: unknown): ChecklistItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ChecklistItem> & {
    name?: unknown;
    estimatedMinutes?: unknown;
    priority?: unknown;
  };
  const step = typeof item.step === 'string' ? item.step.trim()
    : typeof item.name === 'string' ? item.name.trim()
      : '';
  const timeMinutes = typeof item.timeMinutes === 'number' ? item.timeMinutes
    : typeof item.estimatedMinutes === 'number' ? item.estimatedMinutes
      : Number.NaN;
  const aptlssType = typeof item.aptlssType === 'string' ? item.aptlssType
    : typeof item.priority === 'string' ? item.priority
      : '';
  if (!step
    || !Number.isFinite(timeMinutes)
    || timeMinutes < 0
    || !['A', 'P', 'T', 'L', 'S'].includes(aptlssType)) {
    return null;
  }
  return { step, timeMinutes, aptlssType: aptlssType as ChecklistItem['aptlssType'] };
}

export function normalizeChecklistSyncCardIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((id) => typeof id === "number" ? id : Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)];
}

export function toChecklistSyncCards(rows: ChecklistSyncRow[]): ChecklistSyncCard[] {
  return rows.flatMap((row) => {
    const cardId = Number(row.id);
    const trelloId = typeof row.trello_id === "string" ? row.trello_id.trim() : "";
    if (!Number.isInteger(cardId) || cardId <= 0 || !trelloId) return [];

    try {
      const sourceChecklist = typeof row.aptlssChecklist === "string" ? JSON.parse(row.aptlssChecklist) : [];
      const checklist = Array.isArray(sourceChecklist)
        ? sourceChecklist.map(toChecklistItem).filter((item): item is ChecklistItem => item !== null)
        : [];
      return checklist.length > 0
        ? [{ cardId, trelloId, checklist }]
        : [];
    } catch {
      return [];
    }
  });
}
