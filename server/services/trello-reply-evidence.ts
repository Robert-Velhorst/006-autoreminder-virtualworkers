import {
  deactivateMissingTrelloReplyThreads,
  upsertReplyThread,
} from "../replyMonitorDb";
import {
  getCardCommentActions,
  getTrelloMemberIdentity,
  getWorkerCards,
  type TrelloAction,
  type TrelloCard,
  type TrelloMemberIdentity,
} from "./trello-manus";
import { mapWithConcurrency } from "../utils/concurrency";

const REPLY_DEADLINE_MS = 12 * 60 * 60 * 1000;
const COMMENT_CONCURRENCY = 5;

export type ReplyEvidenceAssessment = {
  latestExternal: TrelloAction | null;
  latestWorker: TrelloAction | null;
  status: "pending" | "replied" | "overdue" | null;
};

function isWorkerAction(action: TrelloAction, worker: TrelloMemberIdentity) {
  const creator = action.memberCreator;
  if (!creator?.id || !creator.username) return false;
  return creator.id === worker.id
    || creator.username.toLowerCase() === worker.username.toLowerCase();
}

export function assessReplyEvidence(
  actions: TrelloAction[],
  worker: TrelloMemberIdentity,
  nowMs = Date.now(),
): ReplyEvidenceAssessment {
  const comments = actions
    .filter((action) => action.type === "commentCard"
      && action.data.card?.id
      && action.memberCreator?.id
      && action.memberCreator.username)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const latestExternal = comments.find((action) => !isWorkerAction(action, worker)) ?? null;
  const latestWorker = comments.find((action) => isWorkerAction(action, worker)) ?? null;
  if (!latestExternal) return { latestExternal: null, latestWorker, status: null };

  const externalAt = new Date(latestExternal.date).getTime();
  const workerAt = latestWorker ? new Date(latestWorker.date).getTime() : 0;
  const status = workerAt >= externalAt
    ? "replied"
    : nowMs - externalAt >= REPLY_DEADLINE_MS
      ? "overdue"
      : "pending";
  return { latestExternal, latestWorker, status };
}

export async function syncWorkerTrelloReplyEvidence(input: {
  vaId: number;
  trelloMemberId: string | null | undefined;
  apiKey?: string;
  apiToken?: string;
  nowMs?: number;
}) {
  const apiKey = input.apiKey ?? process.env.TRELLO_API_KEY ?? process.env.TrelloAPIKey;
  const apiToken = input.apiToken ?? process.env.TRELLO_TOKEN ?? process.env.TrelloAPIToken;
  const trelloMemberId = input.trelloMemberId?.trim();
  if (!apiKey || !apiToken) throw new Error("Trello API credentials not configured");
  if (!trelloMemberId) throw new Error("Worker Trello member ID is not configured");

  const [worker, cards] = await Promise.all([
    getTrelloMemberIdentity(apiKey, apiToken, trelloMemberId),
    getWorkerCards(apiKey, apiToken, trelloMemberId),
  ]);
  const orderedCards = [...cards].sort(
    (a, b) => new Date(b.dateLastActivity).getTime() - new Date(a.dateLastActivity).getTime(),
  );
  const evidence = await mapWithConcurrency(orderedCards, COMMENT_CONCURRENCY, async (card) => ({
    card,
    assessment: assessReplyEvidence(
      await getCardCommentActions(apiKey, apiToken, card.id),
      worker,
      input.nowMs,
    ),
  }));

  let threads = 0;
  let pending = 0;
  let overdue = 0;
  let replied = 0;
  for (const { card, assessment } of evidence) {
    if (!assessment.latestExternal || !assessment.status) continue;
    const latestExternal = assessment.latestExternal;
    const latestWorker = assessment.latestWorker;
    await upsertReplyThread(input.vaId, {
      source: "trello",
      cardId: card.id,
      cardName: card.name,
      cardUrl: card.url,
      boardName: card.boardName ?? "Unknown board",
      listName: card.list?.name ?? "Unknown list",
      lastNonWorkerMsgAt: new Date(latestExternal.date),
      lastNonWorkerAuthor: latestExternal.memberCreator.fullName || latestExternal.memberCreator.username,
      lastNonWorkerText: latestExternal.data.text ?? "",
      lastWorkerReplyAt: latestWorker ? new Date(latestWorker.date) : null,
      status: assessment.status,
      demerited: false,
    });
    threads += 1;
    if (assessment.status === "pending") pending += 1;
    if (assessment.status === "overdue") overdue += 1;
    if (assessment.status === "replied") replied += 1;
  }

  const inactive = await deactivateMissingTrelloReplyThreads(
    input.vaId,
    orderedCards.map((card: TrelloCard) => card.id),
  );
  return {
    scannedCards: orderedCards.length,
    threads,
    pending,
    overdue,
    replied,
    inactive,
  };
}
