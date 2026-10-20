/**
 * Trello card context fetcher — gathers all available context for a card
 * so the LLM can generate a rich, accurate APTLSS plan.
 *
 * Fetches:
 *   - Card details (name, description, due date, labels, members, shortUrl)
 *   - Board and list name
 *   - Checklists (all items with completion state)
 *   - Recent comments (last 10) — normalised to { text, date, memberName }
 *   - Attachments (names/URLs)
 *   - lastActivityMs (Unix ms)
 *
 * NOTE: The TrelloCardContext interface here is the canonical one used by
 * both trelloWebhook.ts and aptlssEngine.ts. aptlssEngine.ts re-exports a
 * compatible interface so callers can use either import path.
 */
import axios from "axios";

const TRELLO_API_BASE = "https://api.trello.com/1";
const TRELLO_REQUEST_TIMEOUT_MS = 15_000;

// ─── Sub-types (kept for backward compat with formatContextForLLM) ───────────
export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: Array<{
    id: string;
    name: string;
    state: "complete" | "incomplete";
  }>;
}

export interface TrelloComment {
  id: string;
  date: string;
  memberCreator: { username: string; fullName: string };
  data: { text: string };
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

/**
 * Canonical TrelloCardContext — compatible with aptlssEngine.ts expectations.
 * Fields marked with * are the additions over the old interface.
 */
export interface TrelloCardContext {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dueComplete: boolean;
  url: string;
  shortUrl: string;       // * required by aptlssEngine
  boardName: string;
  listName: string;
  labels: { name: string; color: string }[];
  checklists: TrelloChecklist[];
  /** Normalised comment list — required by aptlssEngine */
  comments: { text: string; date: string; memberName: string }[];
  /** Raw comment list — kept for formatContextForLLM */
  recentComments: TrelloComment[];
  attachments: { name: string; url: string }[];
  members: Array<{ username: string; fullName: string }>;
  dateLastActivity: string;
  /** Unix ms of last activity — required by aptlssEngine */
  lastActivityMs: number;
}

/**
 * Fetch full context for a Trello card by ID.
 * Throws if the card cannot be fetched.
 */
export async function fetchCardContext(
  cardId: string,
  apiKey: string,
  apiToken: string
): Promise<TrelloCardContext> {
  const encodedCardId = encodeURIComponent(cardId);
  const [cardRes, checklistsRes, actionsRes] = await Promise.all([
    axios.get(`${TRELLO_API_BASE}/cards/${encodedCardId}`, {
      timeout: TRELLO_REQUEST_TIMEOUT_MS,
      params: {
        key: apiKey,
        token: apiToken,
        fields: "name,desc,due,dueComplete,url,shortUrl,idList,idBoard,dateLastActivity",
        members: "true",
        labels: "true",
        attachments: "true",
        attachment_fields: "name,url",
      },
    }),
    axios.get(`${TRELLO_API_BASE}/cards/${encodedCardId}/checklists`, {
      timeout: TRELLO_REQUEST_TIMEOUT_MS,
      params: { key: apiKey, token: apiToken },
    }),
    axios.get(`${TRELLO_API_BASE}/cards/${encodedCardId}/actions`, {
      timeout: TRELLO_REQUEST_TIMEOUT_MS,
      params: {
        key: apiKey,
        token: apiToken,
        filter: "commentCard",
        limit: 10,
      },
    }),
  ]);

  const card = cardRes.data;
  const checklists: TrelloChecklist[] = checklistsRes.data ?? [];
  const actions = actionsRes.data ?? [];

  // Fetch board and list names
  let boardName = "Unknown Board";
  let listName = "Unknown List";
  try {
    const [boardRes, listRes] = await Promise.all([
      axios.get(`${TRELLO_API_BASE}/boards/${encodeURIComponent(card.idBoard)}`, {
        timeout: TRELLO_REQUEST_TIMEOUT_MS,
        params: { key: apiKey, token: apiToken, fields: "name" },
      }),
      axios.get(`${TRELLO_API_BASE}/lists/${encodeURIComponent(card.idList)}`, {
        timeout: TRELLO_REQUEST_TIMEOUT_MS,
        params: { key: apiKey, token: apiToken, fields: "name" },
      }),
    ]);
    boardName = boardRes.data?.name ?? boardName;
    listName = listRes.data?.name ?? listName;
  } catch {
    // Non-fatal — use defaults
  }

  const recentComments: TrelloComment[] = actions
    .filter((a: any) => a.type === "commentCard")
    .map((a: any) => ({
      id: a.id,
      date: a.date,
      memberCreator: {
        username: a.memberCreator?.username ?? "",
        fullName: a.memberCreator?.fullName ?? "",
      },
      data: { text: a.data?.text ?? "" },
    }));

  // Normalised comment list for aptlssEngine
  const comments = recentComments.map((c) => ({
    text: c.data.text,
    date: c.date,
    memberName: c.memberCreator.fullName || c.memberCreator.username,
  }));

  const attachments = (card.attachments ?? []).map((att: any) => ({
    id: att.id,
    name: att.name,
    url: att.url,
  }));

  const members = (card.members ?? []).map((m: any) => ({
    username: m.username ?? "",
    fullName: m.fullName ?? "",
  }));

  const labels = (card.labels ?? []).map((l: any) => ({
    id: l.id,
    name: l.name ?? "",
    color: l.color ?? "",
  }));

  const dateLastActivity: string = card.dateLastActivity ?? "";
  const lastActivityMs = dateLastActivity ? new Date(dateLastActivity).getTime() : Date.now();

  return {
    id: card.id,
    name: card.name,
    desc: card.desc ?? "",
    due: card.due ?? null,
    dueComplete: card.dueComplete ?? false,
    url: card.url ?? card.shortUrl ?? "",
    shortUrl: card.shortUrl ?? card.url ?? "",
    boardName,
    listName,
    labels,
    checklists,
    recentComments,
    comments,
    attachments,
    members,
    dateLastActivity,
    lastActivityMs,
  };
}

/**
 * Render a TrelloCardContext into a compact text block for the LLM prompt.
 */
export function formatContextForLLM(ctx: TrelloCardContext): string {
  const lines: string[] = [];

  lines.push(`CARD: ${ctx.name}`);
  lines.push(`BOARD: ${ctx.boardName}  |  LIST: ${ctx.listName}`);
  lines.push(`URL: ${ctx.shortUrl || ctx.url}`);

  if (ctx.due) {
    const dueDate = new Date(ctx.due);
    const now = new Date();
    const diffMs = dueDate.getTime() - now.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const overdue = diffMs < 0;
    lines.push(
      `DUE: ${dueDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} (${overdue ? `OVERDUE by ${Math.abs(diffDays)} day(s)` : `in ${diffDays} day(s)`})${ctx.dueComplete ? " ✓ COMPLETE" : ""}`
    );
  } else {
    lines.push("DUE: Not set");
  }

  if (ctx.labels.length > 0) {
    lines.push(`LABELS: ${ctx.labels.map((l) => l.name || l.color).join(", ")}`);
  }

  if (ctx.members.length > 0) {
    lines.push(`MEMBERS: ${ctx.members.map((m) => m.fullName || m.username).join(", ")}`);
  }

  if (ctx.desc.trim()) {
    lines.push("");
    lines.push("DESCRIPTION:");
    lines.push(ctx.desc.trim().slice(0, 2000));
  }

  if (ctx.checklists.length > 0) {
    lines.push("");
    lines.push("CHECKLISTS:");
    for (const cl of ctx.checklists) {
      lines.push(`  [${cl.name}]`);
      for (const item of cl.checkItems) {
        lines.push(`    ${item.state === "complete" ? "✓" : "○"} ${item.name}`);
      }
    }
  }

  if (ctx.recentComments.length > 0) {
    lines.push("");
    lines.push("RECENT COMMENTS (newest first):");
    for (const c of ctx.recentComments.slice(0, 5)) {
      const dateStr = new Date(c.date).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`  [${c.memberCreator.fullName || c.memberCreator.username} @ ${dateStr}]`);
      lines.push(`  "${c.data.text.slice(0, 300)}"`);
    }
  }

  if (ctx.attachments.length > 0) {
    lines.push("");
    lines.push("ATTACHMENTS:");
    for (const att of ctx.attachments.slice(0, 5)) {
      lines.push(`  - ${att.name}: ${att.url}`);
    }
  }

  return lines.join("\n");
}
