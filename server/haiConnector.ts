import { createHash, randomBytes } from "crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  commitments,
  haiConnectorTokens,
  reminderAuditEvents,
} from "../drizzle/schema.postgres";
import { getDb } from "./db";

const TOKEN_PREFIX = "vwc_hai_";
const MAX_FEED_LIMIT = 100;
const MAX_CONTENT_LENGTH = 12_000;

export type HaiConnectorActor = {
  id: number;
  role: string;
};

export type HaiFeedItem = {
  externalId: string;
  title: string;
  content: string;
  sourceUri: string;
  itemType: "worker_commitment_event";
  projectKey: string;
  metadata: string;
};

function requireOwner(actor: HaiConnectorActor) {
  if (actor.role === "worker") throw new Error("Only the workspace owner can manage the HAI connector");
  return actor.id;
}

export function hashHaiConnectorToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function encodeHaiFeedCursor(eventId: number) {
  return Buffer.from(JSON.stringify({ v: 1, eventId }), "utf8").toString("base64url");
}

export function decodeHaiFeedCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;
  if (cursor.length > 256) throw new Error("Invalid HAI feed cursor");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; eventId?: unknown };
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.eventId) || Number(parsed.eventId) < 0) throw new Error();
    return Number(parsed.eventId);
  } catch {
    throw new Error("Invalid HAI feed cursor");
  }
}

export async function getHaiConnectorStatus(actor: HaiConnectorActor) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const workspaceOwnerId = requireOwner(actor);
  const [token] = await db.select({
    id: haiConnectorTokens.id,
    label: haiConnectorTokens.label,
    tokenPrefix: haiConnectorTokens.tokenPrefix,
    scopes: haiConnectorTokens.scopes,
    lastUsedAt: haiConnectorTokens.lastUsedAt,
    expiresAt: haiConnectorTokens.expiresAt,
    createdAt: haiConnectorTokens.createdAt,
  }).from(haiConnectorTokens).where(and(
    eq(haiConnectorTokens.workspaceOwnerId, workspaceOwnerId),
    isNull(haiConnectorTokens.revokedAt),
  )).orderBy(desc(haiConnectorTokens.createdAt)).limit(1);
  return { configured: Boolean(token), token: token ?? null, feedPath: "/api/integrations/hai/feed" };
}

export async function rotateHaiConnectorToken(actor: HaiConnectorActor, label = "HAI Worker Control") {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const workspaceOwnerId = requireOwner(actor);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashHaiConnectorToken(token);
  const tokenPrefix = token.slice(0, TOKEN_PREFIX.length + 8);
  const safeLabel = label.trim().slice(0, 128) || "HAI Worker Control";
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.update(haiConnectorTokens).set({ revokedAt: now }).where(and(
      eq(haiConnectorTokens.workspaceOwnerId, workspaceOwnerId),
      isNull(haiConnectorTokens.revokedAt),
    ));
    await tx.insert(haiConnectorTokens).values({
      workspaceOwnerId,
      createdByUserId: actor.id,
      label: safeLabel,
      tokenPrefix,
      tokenHash,
      scopes: "worker_control:read",
    });
  });
  return { token, tokenPrefix, scopes: ["worker_control:read"] as const };
}

export async function revokeHaiConnectorToken(actor: HaiConnectorActor) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const workspaceOwnerId = requireOwner(actor);
  const now = new Date();
  await db.update(haiConnectorTokens).set({ revokedAt: now }).where(and(
    eq(haiConnectorTokens.workspaceOwnerId, workspaceOwnerId),
    isNull(haiConnectorTokens.revokedAt),
  ));
  return { success: true } as const;
}

export async function resolveHaiConnectorOwner(candidate: string | null | undefined) {
  if (!candidate || !candidate.startsWith(TOKEN_PREFIX) || candidate.length > 128) return null;
  const db = await getDb();
  if (!db) return null;
  const now = new Date();
  const [token] = await db.select({ id: haiConnectorTokens.id, workspaceOwnerId: haiConnectorTokens.workspaceOwnerId })
    .from(haiConnectorTokens)
    .where(and(
      eq(haiConnectorTokens.tokenHash, hashHaiConnectorToken(candidate)),
      isNull(haiConnectorTokens.revokedAt),
      or(isNull(haiConnectorTokens.expiresAt), gt(haiConnectorTokens.expiresAt, now)),
    ))
    .limit(1);
  if (!token) return null;
  await db.update(haiConnectorTokens).set({ lastUsedAt: now }).where(eq(haiConnectorTokens.id, token.id));
  return token.workspaceOwnerId;
}

function bounded(value: string | null | undefined, max: number) {
  const clean = (value ?? "").replace(/\0/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export async function getHaiWorkerControlFeed(workspaceOwnerId: number, cursor: string | null | undefined, requestedLimit: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const afterEventId = decodeHaiFeedCursor(cursor);
  const limit = Math.min(Math.max(Math.trunc(requestedLimit) || 50, 1), MAX_FEED_LIMIT);
  const rows = await db.select({ event: reminderAuditEvents, commitment: commitments })
    .from(reminderAuditEvents)
    .innerJoin(commitments, eq(commitments.id, reminderAuditEvents.commitmentId))
    .where(and(
      eq(reminderAuditEvents.workspaceOwnerId, workspaceOwnerId),
      gt(reminderAuditEvents.id, afterEventId),
    ))
    .orderBy(reminderAuditEvents.id)
    .limit(limit);

  const items: HaiFeedItem[] = rows.map(({ event, commitment }) => ({
    externalId: `worker-control-event:${event.id}`,
    title: bounded(`Commitment update: ${commitment.title}`, 1_000),
    content: bounded([
      `Commitment: ${commitment.title}`,
      `Status: ${commitment.status}`,
      `Due: ${commitment.dueAt.toISOString()}`,
      `Event: ${event.eventType}`,
      commitment.context ? `Context: ${commitment.context}` : "",
      `Origin: ${commitment.sourceType}`,
    ].filter(Boolean).join("\n"), MAX_CONTENT_LENGTH),
    sourceUri: `worker-control://commitments/${commitment.id}/events/${event.id}`,
    itemType: "worker_commitment_event",
    projectKey: `worker-control:${workspaceOwnerId}`,
    metadata: `source=worker_control;read_only=true;sensitive=true;review_required=true;event=${bounded(event.eventType, 64)};status=${commitment.status}`,
  }));
  const lastEventId = rows.at(-1)?.event.id ?? afterEventId;
  return { nextCursor: encodeHaiFeedCursor(lastEventId), items };
}
