import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import {
  appSettings,
  aptlssPlans,
  aptlssEvidenceRevisions,
  aptlssEvidenceSubjectLinks,
  emailTasks,
  users,
  workspaceEvidenceItems,
  workspaceEvidenceLinks,
} from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { upsertSourceCommitment } from "./sourceCommitments";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
import { zonedDateTimeToUtc } from "../shared/workerTime";
import { gmailContentScope } from "../shared/gmailContentScope";
import { mapWithConcurrency } from "./utils/concurrency";
import { enqueueManagerTask, type ManagerQueueConnection, type ManagerQueueTransaction } from "./aptlssManagerQueue";
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from "./scheduledJobRuntime";
import { assertEmailDispatchAllowed, EmailDispatchNotStartedError } from "./services/email-dispatch-guard";

const SETTINGS_KEY = "googleEvidence";
const TOKEN_KEY = "googleEvidenceRefreshToken";
const OAUTH_STATE_KEY = "googleEvidenceOAuthState";
const MAIL_DELIVERY_TOKEN_KEY = "googleMailDeliveryRefreshToken";
const MAIL_DELIVERY_PROFILE_KEY = "googleMailDeliveryProfile";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const GMAIL_MESSAGE_DETAILS_CONCURRENCY = 5;
export const GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING = "Review required: at least one email record could not be safely updated. The saved data was left unchanged because source order or ownership could not be verified. Do not rely on the affected evidence; ask your manager to review and reconcile the source.";

async function googleOwnershipCheckpoint(context?: ScheduledJobContext, transaction?: ScheduledJobOwnershipReader) {
  if (!context) return;
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context.assertOwnership(transaction);
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
}

function googleRequestSignal(context?: ScheduledJobContext) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return context ? AbortSignal.any([context.signal, timeout]) : timeout;
}

async function rethrowGoogleOwnershipLoss(error: unknown, context?: ScheduledJobContext) {
  if (error instanceof ScheduledJobLeaseLostError) throw error;
  await googleOwnershipCheckpoint(context);
}

export type GoogleEvidenceSettings = {
  gmail: {
    enabled: boolean;
    intervalMinutes: number;
    lookbackDays: number;
  };
  drive: {
    enabled: boolean;
    intervalMinutes: number;
    lookbackDays: number;
    folderId: string | null;
  };
  lastGmailSyncAt: string | null;
  lastDriveSyncAt: string | null;
  lastGmailError: string | null;
  // Sticky until a future explicit review flow reconciles the affected source record.
  gmailSourceConflictPending: boolean;
  lastDriveError: string | null;
  lastError: string | null;
  invalidRefreshTokenFingerprint: string | null;
};

type GoogleEvidenceSettingsInput = {
  gmail?: Partial<GoogleEvidenceSettings["gmail"]>;
  drive?: Partial<GoogleEvidenceSettings["drive"]>;
};

type WorkerCard = {
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
};

type GmailMessage = {
  id: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  snippet: string;
  receivedAt: Date;
};

type GmailEvidenceSourceSnapshot = {
  gmailMessageId: string;
  gmailThreadId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  snippet: string | null;
  receivedAt: Date;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string | null;
  modifiedAt: Date | null;
  sourceUrl: string | null;
  description: string | null;
  parents: string[];
  size: string | null;
};

export function googleGmailEvidenceRevision(value: {
  gmailMessageId: string;
  gmailThreadId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  snippet: string | null;
  receivedAt: Date;
  category: string;
  deadlineAt: Date | null;
  trelloCardId: string | null | undefined;
  trelloCardName: string | null | undefined;
  trelloCardUrl: string | null | undefined;
  suggestedNextAction: string | null;
  llmSummary: string | null;
}) {
  return createHash("sha256").update(JSON.stringify([
    value.gmailMessageId,
    value.gmailThreadId,
    value.subject,
    value.fromAddress,
    value.fromName,
    value.snippet,
    value.receivedAt.toISOString(),
    value.category,
    value.deadlineAt?.toISOString() ?? null,
    value.trelloCardId ?? null,
    value.trelloCardName ?? null,
    value.trelloCardUrl ?? null,
    value.suggestedNextAction,
    value.llmSummary,
  ])).digest("hex");
}

function normalizeGmailEvidenceInsert(value: typeof emailTasks.$inferInsert) {
  return {
    gmailMessageId: value.gmailMessageId,
    gmailThreadId: value.gmailThreadId,
    subject: value.subject ?? "(no subject)",
    fromAddress: value.fromAddress ?? "",
    fromName: value.fromName ?? "",
    snippet: value.snippet ?? null,
    receivedAt: value.receivedAt,
    category: value.category ?? "non_financial",
    deadlineAt: value.deadlineAt ?? null,
    trelloCardId: value.trelloCardId ?? null,
    trelloCardName: value.trelloCardName ?? null,
    trelloCardUrl: value.trelloCardUrl ?? null,
    suggestedNextAction: value.suggestedNextAction ?? null,
    llmSummary: value.llmSummary ?? null,
  };
}

function googleGmailSourceRevision(value: GmailEvidenceSourceSnapshot) {
  return createHash("sha256").update(JSON.stringify([
    value.gmailMessageId,
    value.gmailThreadId,
    value.subject,
    value.fromAddress,
    value.fromName,
    value.snippet,
    value.receivedAt.toISOString(),
  ])).digest("hex");
}

export function googleGmailSourceDisposition(
  existing: GmailEvidenceSourceSnapshot | null,
  incoming: GmailEvidenceSourceSnapshot,
): "new" | "same_source" | "conflict" {
  if (!existing) return "new";
  // receivedAt is message time, not a persisted revision sequence for changed content.
  return googleGmailSourceRevision(existing) === googleGmailSourceRevision(incoming)
    ? "same_source"
    : "conflict";
}

export function googleGmailSourceConflictState(pending: boolean, newlyDetected = 0) {
  const unresolved = pending || newlyDetected > 0;
  return {
    pending: unresolved,
    warning: unresolved ? GOOGLE_GMAIL_SOURCE_CONFLICT_WARNING : null,
  };
}

export function googleGmailRevisionTransition(messageId: string, previousRevision: string | null, nextRevision: string) {
  if (previousRevision === nextRevision) return null;
  return `google-gmail:${messageId}:${randomBytes(16).toString("hex")}`;
}

export async function enqueueGoogleGmailReassessment(
  tx: ManagerQueueTransaction,
  vaId: number,
  messageId: string,
  previousRevision: string | null,
  nextRevision: string,
  context?: ScheduledJobContext,
) {
  const eventKey = googleGmailRevisionTransition(messageId, previousRevision, nextRevision);
  if (!eventKey) return false;
  await googleOwnershipCheckpoint(context, tx);
  await enqueueManagerTask(tx, { vaId, trigger: "source_ingested", eventKey });
  return true;
}

export function gmailEvidenceNeedsReassessment(
  existing: { status: string; trelloCardId: string | null } | null,
  incomingCardId: string | null | undefined,
  archivedOnImport = false,
) {
  if (archivedOnImport && !existing?.trelloCardId && !incomingCardId) return false;
  return !existing || existing.status === "pending" || Boolean(existing.trelloCardId || incomingCardId);
}

export function reconcileGmailThreadMessage(
  incoming: { id: string; receivedAt: Date },
  retained: Array<{ gmailMessageId: string; receivedAt: Date }>,
) {
  return {
    archiveIncoming: retained.some((item) => item.gmailMessageId !== incoming.id && item.receivedAt > incoming.receivedAt),
    archiveOlderMessageIds: retained
      .filter((item) => item.gmailMessageId !== incoming.id && item.receivedAt < incoming.receivedAt)
      .map((item) => item.gmailMessageId),
  };
}

export function googleDriveEvidenceRevision(file: DriveFile) {
  return createHash("sha256").update(JSON.stringify({
    name: file.name,
    mimeType: file.mimeType,
    modifiedAt: file.modifiedAt?.toISOString() ?? null,
    sourceUrl: file.sourceUrl,
    description: file.description,
    parents: [...file.parents].sort(),
    size: file.size,
  })).digest("hex");
}

export function googleDriveRevisionDisposition(
  existing: { modifiedAt: Date | null; contentHash: string | null } | null,
  incoming: { modifiedAt: Date | null; contentHash: string },
): "accept" | "stale" | "ambiguous" {
  if (!existing) return "accept";
  if (existing.contentHash === incoming.contentHash) return "accept";
  if (!existing.modifiedAt || !incoming.modifiedAt) return "ambiguous";
  if (existing.modifiedAt && incoming.modifiedAt) {
    if (incoming.modifiedAt.getTime() < existing.modifiedAt.getTime()) return "stale";
    if (incoming.modifiedAt.getTime() > existing.modifiedAt.getTime()) return "accept";
  }
  return "ambiguous";
}

export function evidenceRevisionChanged(previous: string | null | undefined, next: string, active = true) {
  return !previous || !active || previous !== next;
}

export function gmailEvidenceOwnerMatches(existingVaId: number | null, requestedVaId: number) {
  return existingVaId === null || existingVaId === requestedVaId;
}

export async function retainGmailEvidenceRecord(
  tx: ManagerQueueTransaction,
  values: typeof emailTasks.$inferInsert,
  context?: ScheduledJobContext,
) {
  // A non-locking read avoids taking a gap lock for a globally unique ID that is not inserted yet.
  await googleOwnershipCheckpoint(context, tx);
  const [existing] = await tx.select().from(emailTasks)
    .where(eq(emailTasks.gmailMessageId, values.gmailMessageId)).limit(1);
  if (!gmailEvidenceOwnerMatches(existing?.vaId ?? null, values.vaId)) {
    return { retained: false as const, existing: null, conflict: "ownership" as const };
  }

  const normalizedValues = normalizeGmailEvidenceInsert(values);
  const sourceDisposition = googleGmailSourceDisposition(existing ?? null, normalizedValues);
  if (sourceDisposition === "conflict") {
    return { retained: false as const, existing: null, conflict: "source_revision" as const };
  }
  const exactDuplicate = existing
    && googleGmailEvidenceRevision(existing) === googleGmailEvidenceRevision(normalizedValues);

  if (!exactDuplicate) {
    await googleOwnershipCheckpoint(context, tx);
    await tx.insert(emailTasks).values(values).onConflictDoUpdate({ target: emailTasks.gmailMessageId,
      set: {
        gmailThreadId: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.gmailThreadId} ELSE ${emailTasks.gmailThreadId} END`,
        subject: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.subject} ELSE ${emailTasks.subject} END`,
        fromAddress: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.fromAddress} ELSE ${emailTasks.fromAddress} END`,
        fromName: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.fromName} ELSE ${emailTasks.fromName} END`,
        snippet: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.snippet ?? null} ELSE ${emailTasks.snippet} END`,
        receivedAt: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.receivedAt} ELSE ${emailTasks.receivedAt} END`,
        category: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.category} ELSE ${emailTasks.category} END`,
        deadlineAt: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.deadlineAt ?? null} ELSE ${emailTasks.deadlineAt} END`,
        trelloCardId: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.trelloCardId ?? null} ELSE ${emailTasks.trelloCardId} END`,
        trelloCardName: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.trelloCardName ?? null} ELSE ${emailTasks.trelloCardName} END`,
        trelloCardUrl: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.trelloCardUrl ?? null} ELSE ${emailTasks.trelloCardUrl} END`,
        suggestedNextAction: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.suggestedNextAction ?? null} ELSE ${emailTasks.suggestedNextAction} END`,
        llmSummary: sql`CASE WHEN ${emailTasks.vaId} = ${values.vaId} THEN ${values.llmSummary ?? null} ELSE ${emailTasks.llmSummary} END`,
      },
    });
  }

  // This locking read sees the winner of a concurrent first insert, even under repeatable-read.
  const [retained] = await tx.select().from(emailTasks)
    .where(eq(emailTasks.gmailMessageId, values.gmailMessageId)).limit(1).for("update");
  if (!retained || retained.vaId !== values.vaId) {
    return { retained: false as const, existing: null, conflict: "ownership" as const };
  }
  return { retained: true as const, existing: existing ?? null };
}

type GoogleMailDeliveryProfile = {
  emailAddress: string;
  connectedAt: string;
};

export type GoogleMailDeliveryStatus = {
  clientConfigured: boolean;
  connected: boolean;
  senderEmail: string | null;
  setupMessage: string | null;
};

function scopedKey(vaId: number) {
  return `${SETTINGS_KEY}:${vaId}`;
}

function scopedTokenKey(vaId: number) {
  return `${TOKEN_KEY}:${vaId}`;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function nullableString(value: unknown, maximum = 256) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maximum);
  return trimmed || null;
}

export function defaultGoogleEvidenceSettings(): GoogleEvidenceSettings {
  return {
    gmail: { enabled: true, intervalMinutes: 60, lookbackDays: 30 },
    drive: { enabled: true, intervalMinutes: 180, lookbackDays: 30, folderId: null },
    lastGmailSyncAt: null,
    lastDriveSyncAt: null,
    lastGmailError: null,
    gmailSourceConflictPending: false,
    lastDriveError: null,
    lastError: null,
    invalidRefreshTokenFingerprint: null,
  };
}

export function normalizeGoogleEvidenceSettings(value: unknown): GoogleEvidenceSettings {
  const defaults = defaultGoogleEvidenceSettings();
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const gmail = raw.gmail && typeof raw.gmail === "object" ? raw.gmail as Record<string, unknown> : {};
  const drive = raw.drive && typeof raw.drive === "object" ? raw.drive as Record<string, unknown> : {};

  return {
    gmail: {
      enabled: typeof gmail.enabled === "boolean" ? gmail.enabled : defaults.gmail.enabled,
      intervalMinutes: clampInteger(gmail.intervalMinutes, defaults.gmail.intervalMinutes, 15, 1_440),
      lookbackDays: clampInteger(gmail.lookbackDays, defaults.gmail.lookbackDays, 1, 90),
    },
    drive: {
      enabled: typeof drive.enabled === "boolean" ? drive.enabled : defaults.drive.enabled,
      intervalMinutes: clampInteger(drive.intervalMinutes, defaults.drive.intervalMinutes, 15, 1_440),
      lookbackDays: clampInteger(drive.lookbackDays, defaults.drive.lookbackDays, 1, 90),
      folderId: nullableString(drive.folderId),
    },
    lastGmailSyncAt: nullableString(raw.lastGmailSyncAt, 64),
    lastDriveSyncAt: nullableString(raw.lastDriveSyncAt, 64),
    lastGmailError: nullableString(raw.lastGmailError, 512),
    gmailSourceConflictPending: raw.gmailSourceConflictPending === true,
    lastDriveError: nullableString(raw.lastDriveError, 512),
    lastError: nullableString(raw.lastError, 512),
    invalidRefreshTokenFingerprint: nullableString(raw.invalidRefreshTokenFingerprint, 64),
  };
}

async function readSettings(vaId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to read Google evidence settings");
  const [row] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, scopedKey(vaId)))
    .limit(1);
  if (!row?.value) return defaultGoogleEvidenceSettings();
  try {
    return normalizeGoogleEvidenceSettings(JSON.parse(row.value));
  } catch {
    return defaultGoogleEvidenceSettings();
  }
}

async function writeSettings(vaId: number, settings: GoogleEvidenceSettings, context?: ScheduledJobContext) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to save Google evidence settings");
  const serialized = JSON.stringify(settings);
  await googleOwnershipCheckpoint(context);
  await db.insert(appSettings).values({
    vaId,
    key: scopedKey(vaId),
    value: serialized,
  }).onConflictDoUpdate({ target: appSettings.key,
    set: {
      vaId,
      value: sql`CASE
        WHEN CASE WHEN pg_input_is_valid(${appSettings.value}, 'jsonb')
          THEN ${appSettings.value}::jsonb ->> 'gmailSourceConflictPending' = 'true' ELSE false END
        THEN jsonb_set(${serialized}::jsonb, '{gmailSourceConflictPending}', 'true'::jsonb)::text
        ELSE ${serialized}
      END`,
    },
  });
}

export async function getGoogleEvidenceSettings(vaId: number) {
  return readSettings(vaId);
}

export async function updateGoogleEvidenceSettings(vaId: number, input: GoogleEvidenceSettingsInput) {
  const current = await readSettings(vaId);
  const next = normalizeGoogleEvidenceSettings({
    ...current,
    gmail: { ...current.gmail, ...input.gmail },
    drive: { ...current.drive, ...input.drive },
  });
  await writeSettings(vaId, next);
  return next;
}

async function getStoredRefreshToken(vaId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to read Google credentials");
  const [row] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, scopedTokenKey(vaId)))
    .limit(1);
  if (!row?.value) return null;
  try {
    return decryptGoogleRefreshToken(row.value);
  } catch {
    return null;
  }
}

async function readGlobalSetting(key: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to read Google delivery settings");
  const [row] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function writeGlobalSetting(key: string, value: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to save Google delivery settings");
  await db.insert(appSettings).values({ vaId: null, key, value }).onConflictDoUpdate({ target: appSettings.key,
    set: { vaId: null, value },
  });
}

async function getGoogleMailDeliveryRefreshToken() {
  const value = await readGlobalSetting(MAIL_DELIVERY_TOKEN_KEY);
  if (!value) return null;
  try {
    return decryptGoogleRefreshToken(value);
  } catch {
    return null;
  }
}

async function getGoogleMailDeliveryProfile(): Promise<GoogleMailDeliveryProfile | null> {
  const value = await readGlobalSetting(MAIL_DELIVERY_PROFILE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<GoogleMailDeliveryProfile>;
    const emailAddress = nullableString(parsed.emailAddress, 320);
    const connectedAt = nullableString(parsed.connectedAt, 64);
    return emailAddress && connectedAt ? { emailAddress, connectedAt } : null;
  } catch {
    return null;
  }
}

export async function saveGoogleMailDeliveryConnection(refreshToken: string, emailAddress: string) {
  const token = refreshToken.trim();
  const senderEmail = emailAddress.trim().toLowerCase();
  if (!token || !senderEmail || !senderEmail.includes("@")) throw new Error("A Google refresh token and sender email are required");
  await Promise.all([
    writeGlobalSetting(MAIL_DELIVERY_TOKEN_KEY, encryptGoogleRefreshToken(token)),
    writeGlobalSetting(MAIL_DELIVERY_PROFILE_KEY, JSON.stringify({ emailAddress: senderEmail, connectedAt: new Date().toISOString() } satisfies GoogleMailDeliveryProfile)),
  ]);
}

export async function clearGoogleMailDeliveryConnection() {
  const db = await getDb();
  if (!db) throw new Error("Database is required to remove Google delivery settings");
  await db.delete(appSettings).where(and(
    eq(appSettings.key, MAIL_DELIVERY_TOKEN_KEY),
  ));
  await db.delete(appSettings).where(and(
    eq(appSettings.key, MAIL_DELIVERY_PROFILE_KEY),
  ));
}

function encryptionKey() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET is required to protect Google credentials");
  return createHash("sha256").update(secret).digest();
}

export function encryptGoogleRefreshToken(refreshToken: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptGoogleRefreshToken(value: string) {
  const [version, ivValue, ciphertextValue, tagValue] = value.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue || !tagValue) throw new Error("Invalid encrypted Google credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

export async function saveGoogleRefreshToken(vaId: number, refreshToken: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to save Google credentials");
  const clean = refreshToken.trim();
  if (!clean) throw new Error("Google refresh token is required");
  await db.insert(appSettings).values({
    vaId,
    key: scopedTokenKey(vaId),
    value: encryptGoogleRefreshToken(clean),
  }).onConflictDoUpdate({ target: appSettings.key,
    set: { vaId, value: encryptGoogleRefreshToken(clean) },
  });
}

export async function clearGoogleRefreshToken(vaId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to remove Google credentials");
  await db.delete(appSettings).where(eq(appSettings.key, scopedTokenKey(vaId)));
}

export async function saveGoogleOAuthState(
  purpose: "worker" | "mail-delivery",
  userId: number,
  nonce: string,
  expiresAt: number,
) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to save Google OAuth state");
  const key = `${OAUTH_STATE_KEY}:${purpose}:${userId}`;
  const value = JSON.stringify({ nonce, expiresAt });
  await db.insert(appSettings).values({ vaId: userId, key, value }).onConflictDoUpdate({ target: appSettings.key,
    set: { vaId: userId, value },
  });
}

export async function consumeGoogleOAuthState(
  purpose: "worker" | "mail-delivery",
  userId: number,
  nonce: string,
  expiresAt: number,
) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to consume Google OAuth state");
  const key = `${OAUTH_STATE_KEY}:${purpose}:${userId}`;
  const value = JSON.stringify({ nonce, expiresAt });
  const result = await db.delete(appSettings).where(and(
    eq(appSettings.key, key),
    eq(appSettings.vaId, userId),
    eq(appSettings.value, value),
  ));
  return result.rowCount === 1;
}

async function configuredGoogleCredentials(vaId: number) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const [refreshToken, settings] = await Promise.all([getStoredRefreshToken(vaId), readSettings(vaId)]);
  const reconnectRequired = Boolean(
    refreshToken && settings.invalidRefreshTokenFingerprint === googleRefreshTokenFingerprint(refreshToken),
  );
  return {
    clientId,
    clientSecret,
    refreshToken,
    reconnectRequired,
    ready: Boolean(clientId && clientSecret && refreshToken && !reconnectRequired),
  };
}

async function configuredGoogleMailDeliveryCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = await getGoogleMailDeliveryRefreshToken();
  return {
    clientId,
    clientSecret,
    refreshToken,
    ready: Boolean(clientId && clientSecret && refreshToken),
  };
}

export function googleEvidenceSetupMessage(credentials: {
  clientId?: string | null;
  clientSecret?: string | null;
  refreshToken?: string | null;
  reconnectRequired?: boolean;
}) {
  if (!credentials.clientId || !credentials.clientSecret) {
    return "Google evidence needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.";
  }
  if (credentials.reconnectRequired) {
    return "Google connection expired. Reconnect Google for this worker to continue Gmail and Drive evidence sync.";
  }
  if (!credentials.refreshToken) {
    return "Connect Google for this worker to authorize read-only Gmail and Drive evidence.";
  }
  return null;
}

function googleRefreshTokenFingerprint(refreshToken: string) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

class GoogleTokenRequestError extends Error {
  constructor(readonly status: number, readonly providerCode: string | null) {
    super(`Google token request failed (${status})`);
    this.name = "GoogleTokenRequestError";
  }
}

function safeGoogleError(error: unknown) {
  if (error instanceof GoogleTokenRequestError && error.providerCode === "invalid_grant") {
    return "Google connection expired. Reconnect Google for this worker to continue Gmail and Drive evidence sync.";
  }
  if (!(error instanceof Error)) return "Google evidence sync failed.";
  if (/timed out|abort/i.test(error.message)) return "Google evidence request timed out.";
  if (/unauthori[sz]ed|forbidden|invalid_grant|access token/i.test(error.message)) {
    return "Google access was rejected. Reconnect the Google credentials.";
  }
  return "Google evidence sync failed. Check server configuration and Google API access.";
}

async function getGoogleAccessToken(credentials: Awaited<ReturnType<typeof configuredGoogleCredentials>>, context?: ScheduledJobContext) {
  if (!credentials.ready) throw new Error(googleEvidenceSetupMessage(credentials) ?? "Google evidence is not ready.");
  return getGoogleAccessTokenForRefreshToken(credentials.clientId!, credentials.clientSecret!, credentials.refreshToken!, context);
}

async function getGoogleAccessTokenForRefreshToken(clientId: string, clientSecret: string, refreshToken: string, context?: ScheduledJobContext) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  await googleOwnershipCheckpoint(context);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: googleRequestSignal(context),
  });
  await googleOwnershipCheckpoint(context);
  if (!response.ok) {
    let providerCode: string | null = null;
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === "string") providerCode = payload.error;
    } catch (error) {
      await rethrowGoogleOwnershipLoss(error, context);
      // Provider error bodies are optional; status remains available without logging response content.
    }
    await googleOwnershipCheckpoint(context);
    throw new GoogleTokenRequestError(response.status, providerCode);
  }
  const payload = await response.json() as { access_token?: unknown };
  await googleOwnershipCheckpoint(context);
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Google token response did not include an access token");
  }
  return payload.access_token;
}

export async function getGoogleMailDeliveryStatus(): Promise<GoogleMailDeliveryStatus> {
  const [credentials, profile] = await Promise.all([
    configuredGoogleMailDeliveryCredentials(),
    getGoogleMailDeliveryProfile(),
  ]);
  const clientConfigured = Boolean(credentials.clientId && credentials.clientSecret);
  const connected = Boolean(credentials.ready && profile?.emailAddress);
  return {
    clientConfigured,
    connected,
    senderEmail: profile?.emailAddress ?? null,
    setupMessage: connected
      ? null
      : clientConfigured
        ? "Connect the owner Gmail account to authorize dashboard delivery."
        : "Google mail delivery needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.",
  };
}

async function getGoogleMailDeliveryAccessToken(context?: ScheduledJobContext) {
  const credentials = await configuredGoogleMailDeliveryCredentials();
  if (!credentials.ready) throw new Error("Google mail delivery is not connected");
  return getGoogleAccessTokenForRefreshToken(credentials.clientId!, credentials.clientSecret!, credentials.refreshToken!, context);
}

export async function getGoogleMailDeliverySenderEmail() {
  const profile = await getGoogleMailDeliveryProfile();
  if (!profile) throw new Error("Google mail delivery is not connected");
  return profile.emailAddress;
}

export async function validateGoogleMailDeliveryConnection() {
  try {
    const token = await getGoogleMailDeliveryAccessToken();
    const response = await fetch(`${GMAIL_API_URL}/profile`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch (error) {
    console.error("[GoogleMailDelivery] Validation failed", error);
    return false;
  }
}

export async function sendGoogleMail(options: { to: string; subject: string; html: string; text: string }, context?: ScheduledJobContext,
  beforeDispatch?: () => Promise<boolean>) {
  await googleOwnershipCheckpoint(context);
  const [token, from] = await Promise.all([
    getGoogleMailDeliveryAccessToken(context),
    getGoogleMailDeliverySenderEmail(),
  ]).catch(async error => { await rethrowGoogleOwnershipLoss(error, context); throw error; });
  await googleOwnershipCheckpoint(context);
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const composed = await composer.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    html: sanitizeHtml(options.html, {
      allowedTags: ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "hr"],
      allowedAttributes: { a: ["href", "title"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
      allowedSchemes: ["https", "http", "mailto"], allowProtocolRelative: false,
    }),
    text: options.text,
  });
  const raw = (composed.message as Buffer).toString("base64url");
  await googleOwnershipCheckpoint(context);
  await assertEmailDispatchAllowed(beforeDispatch, context);
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
  // From this point on, no error can establish that mail was definitely not sent.
  try {
    const response = await fetch(`${GMAIL_API_URL}/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: googleRequestSignal(context),
    }).catch(async error => { await rethrowGoogleOwnershipLoss(error, context); throw error; });
    await googleOwnershipCheckpoint(context);
    if (!response.ok) throw new Error(`Google Gmail send request failed (${response.status})`);
    const payload = await response.json().catch(async error => {
      await rethrowGoogleOwnershipLoss(error, context); throw error;
    }) as { id?: unknown };
    await googleOwnershipCheckpoint(context);
    return { id: typeof payload.id === "string" ? payload.id : null };
  } catch (error) {
    if (error instanceof EmailDispatchNotStartedError) throw new Error('Gmail delivery outcome is unconfirmed');
    throw error;
  }
}

async function googleJson<T>(url: string, token: string, context?: ScheduledJobContext) {
  await googleOwnershipCheckpoint(context);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: googleRequestSignal(context),
  });
  await googleOwnershipCheckpoint(context);
  if (!response.ok) throw new Error(`Google API request failed (${response.status})`);
  const payload = await response.json() as T;
  await googleOwnershipCheckpoint(context);
  return payload;
}

async function googleJsonPages<T>(url: string, token: string, collection: "messages" | "files", context?: ScheduledJobContext) {
  const items: T[] = [];
  const visitedPageTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const pageUrl = new URL(url);
    if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
    const page = await googleJson<Record<string, unknown> & { nextPageToken?: unknown }>(pageUrl.toString(), token, context);
    const pageItems = page[collection];
    if (pageItems !== undefined && pageItems !== null && !Array.isArray(pageItems)) {
      throw new Error("Google API returned an invalid evidence page.");
    }
    if (Array.isArray(pageItems)) items.push(...pageItems as T[]);

    const nextPageToken = page.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === null || nextPageToken === "") return items;
    if (typeof nextPageToken !== "string") throw new Error("Google API returned an invalid page token.");
    if (visitedPageTokens.has(nextPageToken)) throw new Error("Google API repeated an evidence page token.");
    visitedPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

const DEADLINE_MARKER = "(?:due(?:\\s+date)?|deadline|by|before|no\\s+later\\s+than|uiterlijk|voor)";
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januari: 1,
  february: 2, feb: 2, februari: 2,
  march: 3, mar: 3, maart: 3,
  april: 4, apr: 4,
  may: 5, mei: 5,
  june: 6, jun: 6, juni: 6,
  july: 7, jul: 7, juli: 7,
  august: 8, aug: 8, augustus: 8,
  september: 9, sep: 9,
  october: 10, oct: 10, oktober: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export type ExplicitDeadline = {
  dueAt: Date;
  dateOnly: boolean;
  evidence: string;
};

function deadlineFromParts(
  year: number,
  month: number,
  day: number,
  hour: number | undefined,
  minute: number | undefined,
  timezone: string,
  evidence: string,
): ExplicitDeadline | null {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const hasTime = hour !== undefined && minute !== undefined;
  const safeHour = hasTime ? hour : 23;
  const safeMinute = hasTime ? minute : 59;
  if (safeHour < 0 || safeHour > 23 || safeMinute < 0 || safeMinute > 59) return null;
  const dateKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    dueAt: zonedDateTimeToUtc(dateKey, `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`, timezone),
    dateOnly: !hasTime,
    evidence: evidence.trim().slice(0, 160),
  };
}

export function extractExplicitDeadline(text: string, timezone = "UTC"): ExplicitDeadline | null {
  const iso = new RegExp(`${DEADLINE_MARKER}\\s*(?:is|on|:)?\\s*(\\d{4})-(\\d{2})-(\\d{2})(?:[ T,]*(?:at|om)?\\s*(\\d{1,2}):(\\d{2}))?`, "i").exec(text);
  if (iso) return deadlineFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4] ? Number(iso[4]) : undefined, iso[5] ? Number(iso[5]) : undefined, timezone, iso[0]);

  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  const named = new RegExp(`${DEADLINE_MARKER}\\s*(?:is|on|:)?\\s*(?:the\\s+)?(\\d{1,2})?\\s*(${monthNames})\\s*(\\d{1,2})?(?:st|nd|rd|th)?[,]?\\s*(\\d{4})(?:[ ,]*(?:at|om)?\\s*(\\d{1,2}):(\\d{2}))?`, "i").exec(text);
  if (named) {
    const month = MONTHS[named[2].toLocaleLowerCase()];
    const day = Number(named[1] || named[3]);
    if (month && day) return deadlineFromParts(Number(named[4]), month, day, named[5] ? Number(named[5]) : undefined, named[6] ? Number(named[6]) : undefined, timezone, named[0]);
  }

  const numeric = new RegExp(`${DEADLINE_MARKER}\\s*(?:is|on|:)?\\s*(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})(?:[ ,]*(?:at|om)?\\s*(\\d{1,2}):(\\d{2}))?`, "i").exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const markerIsDutch = /uiterlijk|voor/i.test(numeric[0]);
    if (day > 12 || markerIsDutch) {
      return deadlineFromParts(Number(numeric[3]), month, day, numeric[4] ? Number(numeric[4]) : undefined, numeric[5] ? Number(numeric[5]) : undefined, timezone, numeric[0]);
    }
  }
  return null;
}

export function classifyGoogleEmail(subject: string, snippet: string) {
  const haystack = `${subject} ${snippet}`.toLocaleLowerCase();
  const scope = gmailContentScope(subject, snippet);
  const financial = /\b(invoice|factuur|payment|betaling|receipt|bon|statement|afschrift|balance|saldo|credit|debit|bank|tax|belasting|btw|subscription|abonnement)\b/i.test(haystack);
  const deliveryFailure = /delivery status notification|address not found|undeliverable|niet bezorgd/i.test(haystack);
  const requiresReview = /identity|verification|verify|document|proof of address|actie vereist|action required|deadline|urgent/i.test(haystack);
  const suggestedNextAction = scope === "portal_notice"
    ? "Open the notice and the linked portal correspondence. Record what the underlying document asks, any deadline, and the source before deciding a follow-up."
    : deliveryFailure
    ? "Correct the recipient details, then resend or record the delivery failure on the related card."
    : requiresReview
      ? "Review the request, identify the required document or response, then link it to the related card."
      : financial
        ? "Review the financial record, file it against the related work, and act only if a follow-up is required."
        : "Review the message, decide whether a reply or filing action is required, and link it to the related card.";
  return {
    scope,
    category: financial ? "financial" as const : "non_financial" as const,
    suggestedNextAction,
    summary: snippet.trim().slice(0, 2_000) || "No message preview was provided by Gmail.",
  };
}

export function candidateGmailDeadline(subject: string, snippet: string, timezone: string) {
  if (gmailContentScope(subject, snippet) === "portal_notice") return null;
  return extractExplicitDeadline(`${subject}\n${snippet}`, timezone);
}

export function findExactCardMatch(text: string, cards: WorkerCard[]) {
  const normalizedText = normalizeText(text);
  for (const card of cards) {
    if (card.cardId && text.includes(card.cardId)) return { card, score: 100, reason: "Exact Trello card ID" };
  }
  for (const card of cards) {
    const normalizedName = normalizeText(card.cardName);
    if (normalizedName.length >= 12 && normalizedText.includes(normalizedName)) {
      return { card, score: 85, reason: "Exact Trello card title" };
    }
  }
  return null;
}

async function getWorkerCards(vaId: number): Promise<WorkerCard[]> {
  const db = await getDb();
  if (!db) throw new Error("Database is required to match Google evidence");
  return db.select({
    cardId: aptlssPlans.cardId,
    cardName: aptlssPlans.cardName,
    cardUrl: aptlssPlans.cardUrl,
    boardName: aptlssPlans.boardName,
    listName: aptlssPlans.listName,
  }).from(aptlssPlans).where(eq(aptlssPlans.vaId, vaId));
}

function splitFrom(value: string) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return match
    ? { fromName: match[1].replace(/^"|"$/g, "").trim(), fromAddress: match[2].trim() }
    : { fromName: "", fromAddress: value.trim() };
}

export async function listGmailMessages(token: string, lookbackDays: number, context?: ScheduledJobContext): Promise<GmailMessage[]> {
  const query = new URLSearchParams({
    q: `in:inbox -in:spam -in:trash newer_than:${lookbackDays}d`,
    maxResults: "100",
  });
  const listedMessages = await googleJsonPages<{ id?: string; threadId?: string }>(
    `${GMAIL_API_URL}/messages?${query.toString()}`,
    token,
    "messages",
    context,
  );
  const messages = await mapWithConcurrency(listedMessages, GMAIL_MESSAGE_DETAILS_CONCURRENCY, async (item) => {
    await googleOwnershipCheckpoint(context);
    if (!item.id || !item.threadId) return null;
    const params = new URLSearchParams({ format: "metadata", metadataHeaders: "From", fields: "id,threadId,snippet,internalDate,payload(headers)" });
    params.append("metadataHeaders", "Subject");
    const details = await googleJson<{
      id?: string;
      threadId?: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }>(`${GMAIL_API_URL}/messages/${encodeURIComponent(item.id)}?${params.toString()}`, token, context);
    if (!details.id || !details.threadId || !details.internalDate) return null;
    const headers = new Map((details.payload?.headers ?? []).map((header) => [header.name?.toLocaleLowerCase(), header.value ?? ""]));
    const from = splitFrom(headers.get("from") ?? "");
    return {
      id: details.id,
      threadId: details.threadId,
      subject: (headers.get("subject") || "(no subject)").slice(0, 1_024),
      fromAddress: from.fromAddress.slice(0, 320),
      fromName: from.fromName.slice(0, 256),
      snippet: (details.snippet ?? "").slice(0, 8_000),
      receivedAt: new Date(Number(details.internalDate)),
    } satisfies GmailMessage;
  });

  await googleOwnershipCheckpoint(context);
  const latestByThread = new Map<string, GmailMessage>();
  for (const message of messages.filter((item): item is GmailMessage => Boolean(item))) {
    const current = latestByThread.get(message.threadId);
    if (!current || message.receivedAt > current.receivedAt) latestByThread.set(message.threadId, message);
  }
  return Array.from(latestByThread.values());
}

async function syncGmailEvidence(vaId: number, settings: GoogleEvidenceSettings["gmail"], token: string, context?: ScheduledJobContext) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to ingest Gmail evidence");
  const [messages, cards, worker] = await Promise.all([
    listGmailMessages(token, settings.lookbackDays, context),
    getWorkerCards(vaId),
    resolveWorkerOperatorContextById(vaId),
  ]);
  await googleOwnershipCheckpoint(context);
  let linked = 0;
  let imported = 0;
  let commitmentsCreated = 0;
  let sourceConflictCount = 0;
  for (const message of messages) {
    const classification = classifyGoogleEmail(message.subject, message.snippet);
    const match = findExactCardMatch(`${message.subject}\n${message.snippet}`, cards);
    const deadline = candidateGmailDeadline(message.subject, message.snippet, worker.timezone);
    const deadlineIsPlausible = deadline
      && deadline.dueAt.getTime() >= message.receivedAt.getTime() - 24 * 60 * 60_000
      && deadline.dueAt.getTime() <= message.receivedAt.getTime() + 5 * 365 * 24 * 60 * 60_000;
    const values = {
      vaId,
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      subject: message.subject,
      fromAddress: message.fromAddress,
      fromName: message.fromName,
      snippet: message.snippet,
      receivedAt: message.receivedAt,
      category: classification.category,
      status: "pending" as const,
      deadlineAt: deadlineIsPlausible ? deadline.dueAt : null,
      trelloCardId: match?.card.cardId,
      trelloCardName: match?.card.cardName,
      trelloCardUrl: match?.card.cardUrl,
      suggestedNextAction: classification.suggestedNextAction,
      llmSummary: classification.summary,
    };
    const revision = googleGmailEvidenceRevision(values);
    await googleOwnershipCheckpoint(context);
    const retained = await db.transaction(async (tx) => {
      await googleOwnershipCheckpoint(context, tx);
      // Serialize overlapping sync snapshots for this worker before reading thread state.
      const [workerLock] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, vaId)).limit(1).for("update");
      if (!workerLock) {
        await googleOwnershipCheckpoint(context, tx);
        return { retained: false, sourceConflict: false };
      }
      const retainedRecord = await retainGmailEvidenceRecord(tx, values, context);
      if (!retainedRecord.retained) {
        await googleOwnershipCheckpoint(context, tx);
        return { retained: false, sourceConflict: true };
      }
      const { existing } = retainedRecord;
      const previousRevision = existing ? googleGmailEvidenceRevision(existing) : null;
      const retainedThreadMessages = await tx.select({
        gmailMessageId: emailTasks.gmailMessageId,
        receivedAt: emailTasks.receivedAt,
      }).from(emailTasks).where(and(
        eq(emailTasks.vaId, vaId),
        eq(emailTasks.gmailThreadId, message.threadId),
      ));
      const threadDisposition = reconcileGmailThreadMessage(message, retainedThreadMessages);
      if (threadDisposition.archiveIncoming) {
        await googleOwnershipCheckpoint(context, tx);
        await tx.update(emailTasks).set({ status: "archived", archivedAt: new Date() }).where(and(
          eq(emailTasks.vaId, vaId),
          eq(emailTasks.gmailMessageId, message.id),
        ));
      }
      if (threadDisposition.archiveOlderMessageIds.length) {
        await googleOwnershipCheckpoint(context, tx);
        await tx.update(emailTasks).set({ status: "archived", archivedAt: new Date() }).where(and(
          eq(emailTasks.vaId, vaId),
          inArray(emailTasks.gmailMessageId, threadDisposition.archiveOlderMessageIds),
        ));
      }
      if (gmailEvidenceNeedsReassessment(existing ? {
        status: existing.status,
        trelloCardId: existing.trelloCardId,
      } : null, values.trelloCardId, threadDisposition.archiveIncoming)) {
        await enqueueGoogleGmailReassessment(tx, vaId, message.id, previousRevision, revision, context);
      }
      // Reject inside the callback so detected lease loss rolls back the staged writes.
      await googleOwnershipCheckpoint(context, tx);
      return { retained: true, sourceConflict: false };
    });
    await googleOwnershipCheckpoint(context);
    if (retained.sourceConflict) sourceConflictCount++;
    if (!retained.retained) continue;
    imported++;
    if (match) linked++;
    if (deadlineIsPlausible && worker.founderId) {
      await googleOwnershipCheckpoint(context);
      const outcome = await upsertSourceCommitment({
        workspaceOwnerId: worker.founderId,
        assignedUserId: vaId,
        sourceType: "gmail",
        sourceId: message.threadId,
        sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(message.threadId)}`,
        title: message.subject,
        context: [
          `Email from ${message.fromName || message.fromAddress}`,
          classification.suggestedNextAction,
          `Deadline evidence: ${deadline.evidence}`,
          deadline.dateOnly ? "Date-only deadline interpreted as end of the worker's local day." : null,
        ].filter(Boolean).join("\n"),
        dueAt: deadline.dueAt,
        reminderOffsetMinutes: deadline.dateOnly ? 14 * 60 + 59 : 60,
      }, context);
      await googleOwnershipCheckpoint(context);
      if (outcome.state === "created" || outcome.state === "updated") commitmentsCreated++;
    }
  }
  return { scanned: messages.length, imported, linked, commitmentsCreated, sourceConflictCount };
}

export async function listDriveFiles(token: string, settings: GoogleEvidenceSettings["drive"], context?: ScheduledJobContext): Promise<DriveFile[]> {
  const modifiedAfter = new Date(Date.now() - settings.lookbackDays * 24 * 60 * 60 * 1_000).toISOString();
  const clauses = ["trashed = false", `modifiedTime >= '${modifiedAfter}'`];
  if (settings.folderId) clauses.push(`'${settings.folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents`);
  const query = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: "100",
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,description,parents,size)",
  });
  const files = await googleJsonPages<Record<string, unknown>>(`${DRIVE_API_URL}/files?${query.toString()}`, token, "files", context);
  return files.flatMap((file) => {
    if (typeof file.id !== "string" || typeof file.name !== "string") return [];
    const modifiedAt = typeof file.modifiedTime === "string" ? new Date(file.modifiedTime) : null;
    return [{
      id: file.id,
      name: file.name.slice(0, 1_024),
      mimeType: typeof file.mimeType === "string" ? file.mimeType.slice(0, 256) : null,
      modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.getTime()) ? modifiedAt : null,
      sourceUrl: typeof file.webViewLink === "string" ? file.webViewLink.slice(0, 2_048) : null,
      description: typeof file.description === "string" ? file.description.slice(0, 4_000) : null,
      parents: Array.isArray(file.parents) ? file.parents.filter((value): value is string => typeof value === "string").slice(0, 20) : [],
      size: typeof file.size === "string" ? file.size.slice(0, 64) : null,
    } satisfies DriveFile];
  });
}

async function replaceAutomaticEvidenceLinks(
  db: ManagerQueueConnection,
  evidenceId: number,
  match: ReturnType<typeof findExactCardMatch>,
  context?: ScheduledJobContext,
) {
  const current = await db.select({
    cardId: workspaceEvidenceLinks.cardId,
    relevanceScore: workspaceEvidenceLinks.relevanceScore,
    matchReason: workspaceEvidenceLinks.matchReason,
    linkMethod: workspaceEvidenceLinks.linkMethod,
  }).from(workspaceEvidenceLinks)
    .where(eq(workspaceEvidenceLinks.evidenceId, evidenceId));
  const manual = current.some((link) => link.linkMethod === "manual");
  if (manual) return { changed: false, relevant: true };
  const automatic = current.filter((link) => link.linkMethod === "automatic");
  const unchanged = match
    ? automatic.length === 1
      && automatic[0].cardId === match.card.cardId
      && automatic[0].relevanceScore === match.score
      && automatic[0].matchReason === match.reason
    : automatic.length === 0;
  if (unchanged) return { changed: false, relevant: Boolean(match || automatic.length) };
  await googleOwnershipCheckpoint(context, db);
  await db.delete(workspaceEvidenceLinks).where(and(
    eq(workspaceEvidenceLinks.evidenceId, evidenceId),
    eq(workspaceEvidenceLinks.linkMethod, "automatic"),
  ));
  if (match) {
    await googleOwnershipCheckpoint(context, db);
    await db.insert(workspaceEvidenceLinks).values({
      evidenceId,
      cardId: match.card.cardId,
      relevanceScore: match.score,
      matchReason: match.reason,
      linkMethod: "automatic",
    }).onConflictDoUpdate({ target: [workspaceEvidenceLinks.evidenceId, workspaceEvidenceLinks.cardId],
      set: { relevanceScore: match.score, matchReason: match.reason, linkMethod: "automatic" },
    });
  }
  return { changed: true, relevant: Boolean(match || automatic.length) };
}

export async function retainGoogleDriveEvidenceRecord(
  tx: ManagerQueueTransaction,
  values: typeof workspaceEvidenceItems.$inferInsert,
  context?: ScheduledJobContext,
) {
  if (values.vaId === null || values.vaId === undefined) {
    return { retained: false as const, changed: false as const };
  }

  // Serialize first inserts too; locking only the evidence row cannot lock a missing row.
  await googleOwnershipCheckpoint(context, tx);
  const [workerLock] = await tx.select({ id: users.id }).from(users)
    .where(eq(users.id, values.vaId)).limit(1).for("update");
  if (!workerLock) return { retained: false as const, changed: false as const };

  const [existing] = await tx.select({
    id: workspaceEvidenceItems.id,
    contentHash: workspaceEvidenceItems.contentHash,
    active: workspaceEvidenceItems.active,
    observedAt: workspaceEvidenceItems.observedAt,
    modifiedAt: workspaceEvidenceItems.modifiedAt,
  }).from(workspaceEvidenceItems).where(and(
    eq(workspaceEvidenceItems.vaId, values.vaId),
    eq(workspaceEvidenceItems.source, values.source),
    eq(workspaceEvidenceItems.sourceId, values.sourceId),
  )).limit(1).for("update");
  const revisionDisposition = googleDriveRevisionDisposition(existing ? {
    modifiedAt: existing.modifiedAt,
    contentHash: existing.contentHash,
  } : null, {
    modifiedAt: values.modifiedAt ?? null,
    contentHash: values.contentHash,
  });
  if (revisionDisposition === "stale") {
    return { retained: false as const, changed: false as const };
  }
  if (revisionDisposition === "ambiguous") {
    throw new Error("Google Drive returned changed file metadata without a provably newer modification time.");
  }

  const changed = evidenceRevisionChanged(existing?.contentHash, values.contentHash, existing?.active);
  const stableValues = {
    ...values,
    observedAt: changed ? values.observedAt : existing?.observedAt ?? values.observedAt,
  };
  await googleOwnershipCheckpoint(context, tx);
  await tx.insert(workspaceEvidenceItems).values(stableValues).onConflictDoUpdate({ target: [workspaceEvidenceItems.vaId, workspaceEvidenceItems.source, workspaceEvidenceItems.sourceId],
    set: {
      vaId: stableValues.vaId,
      sourceContainerId: stableValues.sourceContainerId,
      kind: stableValues.kind,
      title: stableValues.title,
      summary: stableValues.summary,
      content: stableValues.content,
      sourceUrl: stableValues.sourceUrl,
      mimeType: stableValues.mimeType,
      modifiedAt: stableValues.modifiedAt,
      observedAt: stableValues.observedAt,
      contentHash: stableValues.contentHash,
      metadataJson: stableValues.metadataJson,
      active: true,
      ...(changed ? {
        reviewStatus: "unreviewed" as const,
        reviewedAt: null,
        reviewedBy: null,
      } : {}),
    },
  });
  const [stored] = await tx.select({ id: workspaceEvidenceItems.id })
    .from(workspaceEvidenceItems)
    .where(and(
      eq(workspaceEvidenceItems.vaId, values.vaId),
      eq(workspaceEvidenceItems.source, values.source),
      eq(workspaceEvidenceItems.sourceId, values.sourceId),
    ))
    .limit(1)
    .for("update");
  if (!stored) throw new Error("Google Drive evidence was not retained");

  if (changed) {
    const [knownRevision] = await tx.select({ id: aptlssEvidenceRevisions.id })
      .from(aptlssEvidenceRevisions)
      .where(and(
        eq(aptlssEvidenceRevisions.evidenceId, stored.id),
        eq(aptlssEvidenceRevisions.contentHash, values.contentHash),
      ))
      .limit(1);
    if (!knownRevision) {
      await googleOwnershipCheckpoint(context, tx);
      await tx.insert(aptlssEvidenceRevisions).values({
        evidenceId: stored.id,
        contentHash: values.contentHash,
        truthClass: "source_record",
        summary: values.summary ?? null,
        content: values.content ?? null,
        metadataJson: values.metadataJson ?? null,
        observedAt: values.observedAt,
        recordedBy: null,
      });
    }
  }
  return { retained: true as const, changed, evidenceId: stored.id };
}

async function syncDriveEvidence(vaId: number, settings: GoogleEvidenceSettings["drive"], token: string, context?: ScheduledJobContext) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to ingest Google Drive evidence");
  const [files, cards] = await Promise.all([listDriveFiles(token, settings, context), getWorkerCards(vaId)]);
  await googleOwnershipCheckpoint(context);
  let linked = 0;
  let imported = 0;
  for (const file of files) {
    const sourceId = `${vaId}:${file.id}`;
    const observedAt = new Date();
    const metadata = JSON.stringify({ googleFileId: file.id, parents: [...file.parents].sort(), size: file.size });
    const contentHash = googleDriveEvidenceRevision(file);
    const values = {
      vaId,
      source: "google_drive" as const,
      sourceId,
      sourceContainerId: `worker:${vaId}`,
      kind: "file",
      title: file.name,
      summary: "Google Drive file metadata collected for cross-source work verification.",
      content: file.description,
      sourceUrl: file.sourceUrl,
      mimeType: file.mimeType,
      modifiedAt: file.modifiedAt,
      observedAt,
      contentHash,
      metadataJson: metadata,
      active: true,
    };
    const match = findExactCardMatch(`${file.name}\n${file.description ?? ""}`, cards);
    await googleOwnershipCheckpoint(context);
    const outcome = await db.transaction(async (tx) => {
      await googleOwnershipCheckpoint(context, tx);
      const retained = await retainGoogleDriveEvidenceRecord(tx, values, context);
      if (!retained.retained) {
        await googleOwnershipCheckpoint(context, tx);
        return { linked: false, changed: false, retained: false };
      }
      const linkOutcome = await replaceAutomaticEvidenceLinks(tx, retained.evidenceId, match, context);
      const [graphLink] = retained.changed && !linkOutcome.relevant
        ? await tx.select({ id: aptlssEvidenceSubjectLinks.id }).from(aptlssEvidenceSubjectLinks).where(and(
          eq(aptlssEvidenceSubjectLinks.evidenceId, retained.evidenceId),
          eq(aptlssEvidenceSubjectLinks.vaId, vaId),
          eq(aptlssEvidenceSubjectLinks.subjectType, "card"),
        )).limit(1)
        : [];
      if ((retained.changed || linkOutcome.changed) && (linkOutcome.relevant || graphLink)) {
        await googleOwnershipCheckpoint(context, tx);
        await enqueueManagerTask(tx, {
          vaId,
          trigger: "source_ingested",
          eventKey: `google-drive:${sourceId}:${contentHash}:${file.modifiedAt?.toISOString() ?? "unknown"}:${match?.card.cardId ?? "unlinked"}:${observedAt.getTime()}`,
        });
      }
      await googleOwnershipCheckpoint(context, tx);
      return { linked: Boolean(match), changed: retained.changed, retained: true };
    });
    await googleOwnershipCheckpoint(context);
    if (outcome.retained) imported++;
    if (outcome.linked) linked++;
  }
  return { scanned: files.length, imported, linked };
}

function shouldSync(lastSync: string | null, intervalMinutes: number, now: Date) {
  if (!lastSync) return true;
  const last = new Date(lastSync);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= intervalMinutes * 60_000;
}

export async function getGoogleEvidenceStatus(vaId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to inspect Google evidence status");
  const [settings, emailRows, driveRows] = await Promise.all([
    readSettings(vaId),
    db.select({ id: emailTasks.id }).from(emailTasks)
      .where(eq(emailTasks.vaId, vaId)).orderBy(desc(emailTasks.receivedAt)).limit(1),
    db.select({ id: workspaceEvidenceItems.id }).from(workspaceEvidenceItems)
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId),
        eq(workspaceEvidenceItems.source, "google_drive"),
        eq(workspaceEvidenceItems.sourceContainerId, `worker:${vaId}`),
      ))
      .orderBy(desc(workspaceEvidenceItems.observedAt))
      .limit(1),
  ]);
  const credentials = await configuredGoogleCredentials(vaId);
  const sourceConflict = googleGmailSourceConflictState(settings.gmailSourceConflictPending);
  return {
    credentialsReady: credentials.ready,
    clientConfigured: Boolean(credentials.clientId && credentials.clientSecret),
    connectionMode: credentials.refreshToken ? "worker" : null,
    connectionStatus: credentials.reconnectRequired ? "reconnect_required" : credentials.refreshToken ? "configured" : "not_connected",
    setupMessage: googleEvidenceSetupMessage(credentials),
    settings,
    gmail: {
      enabled: settings.gmail.enabled,
      lastSyncedAt: settings.lastGmailSyncAt,
      lastError: settings.lastGmailError,
      sourceConflictPending: sourceConflict.pending,
      sourceConflictWarning: sourceConflict.warning,
      intervalMinutes: settings.gmail.intervalMinutes,
      hasRetainedEvidence: emailRows.length > 0,
    },
    drive: {
      enabled: settings.drive.enabled,
      lastSyncedAt: settings.lastDriveSyncAt,
      lastError: settings.lastDriveError,
      intervalMinutes: settings.drive.intervalMinutes,
      folderScoped: Boolean(settings.drive.folderId),
      hasRetainedEvidence: driveRows.length > 0,
    },
    lastError: settings.lastError,
  };
}

export async function syncWorkerGoogleEvidence(
  vaId: number,
  options: { gmail?: boolean; drive?: boolean; onlyDue?: boolean; context?: ScheduledJobContext } = {},
) {
  const { context } = options;
  await googleOwnershipCheckpoint(context);
  const settings = await readSettings(vaId);
  await googleOwnershipCheckpoint(context);
  const now = new Date();
  const requestedGmail = options.gmail ?? true;
  const requestedDrive = options.drive ?? true;
  const gmailDue = settings.gmail.enabled && requestedGmail && (!options.onlyDue || shouldSync(settings.lastGmailSyncAt, settings.gmail.intervalMinutes, now));
  const driveDue = settings.drive.enabled && requestedDrive && (!options.onlyDue || shouldSync(settings.lastDriveSyncAt, settings.drive.intervalMinutes, now));
  const credentials = await configuredGoogleCredentials(vaId);
  await googleOwnershipCheckpoint(context);
  const existingSourceConflict = googleGmailSourceConflictState(settings.gmailSourceConflictPending);

  if (!credentials.ready) {
    return {
      configured: false,
      gmail: {
        state: gmailDue ? "blocked" : "skipped", scanned: 0, imported: 0, linked: 0,
        sourceConflictCount: 0, sourceConflictWarning: existingSourceConflict.warning,
      },
      drive: { state: driveDue ? "blocked" : "skipped", scanned: 0, imported: 0, linked: 0 },
      message: googleEvidenceSetupMessage(credentials),
    };
  }

  if (options.onlyDue && !gmailDue && !driveDue) {
    return {
      configured: true,
      gmail: {
        state: "skipped" as const, scanned: 0, imported: 0, linked: 0,
        sourceConflictCount: 0, sourceConflictWarning: existingSourceConflict.warning,
      },
      drive: { state: "skipped" as const, scanned: 0, imported: 0, linked: 0 },
      message: null,
    };
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(credentials, context);
  } catch (error) {
    await rethrowGoogleOwnershipLoss(error, context);
    const message = safeGoogleError(error);
    await writeSettings(vaId, {
      ...settings,
      ...(error instanceof GoogleTokenRequestError && error.providerCode === "invalid_grant" && credentials.refreshToken
        ? { invalidRefreshTokenFingerprint: googleRefreshTokenFingerprint(credentials.refreshToken) }
        : {}),
      lastGmailError: gmailDue ? message : settings.lastGmailError,
      lastDriveError: driveDue ? message : settings.lastDriveError,
      lastError: message,
    }, context);
    await googleOwnershipCheckpoint(context);
    return {
      configured: true,
      gmail: {
        state: gmailDue ? "failed" : "skipped", scanned: 0, imported: 0, linked: 0,
        sourceConflictCount: 0, sourceConflictWarning: existingSourceConflict.warning,
      },
      drive: { state: driveDue ? "failed" : "skipped", scanned: 0, imported: 0, linked: 0 },
      message,
    };
  }
  let next = { ...settings, invalidRefreshTokenFingerprint: null };
  let lastError: string | null = null;
  const result = {
    configured: true,
    gmail: {
      state: gmailDue ? "synced" : "skipped", scanned: 0, imported: 0, linked: 0,
      sourceConflictCount: 0, sourceConflictWarning: existingSourceConflict.warning,
    },
    drive: { state: driveDue ? "synced" : "skipped", scanned: 0, imported: 0, linked: 0 },
    message: null as string | null,
  };
  if (gmailDue) {
    try {
      const gmailOutcome = await syncGmailEvidence(vaId, settings.gmail, token, context);
      await googleOwnershipCheckpoint(context);
      Object.assign(result.gmail, gmailOutcome);
      const sourceConflict = googleGmailSourceConflictState(
        next.gmailSourceConflictPending,
        gmailOutcome.sourceConflictCount,
      );
      result.gmail.sourceConflictWarning = sourceConflict.warning;
      next = {
        ...next,
        lastGmailSyncAt: now.toISOString(),
        lastGmailError: null,
        gmailSourceConflictPending: sourceConflict.pending,
      };
    } catch (error) {
      await rethrowGoogleOwnershipLoss(error, context);
      result.gmail.state = "failed";
      lastError = safeGoogleError(error);
      next = { ...next, lastGmailError: lastError };
    }
  }
  if (driveDue) {
    try {
      Object.assign(result.drive, await syncDriveEvidence(vaId, settings.drive, token, context));
      await googleOwnershipCheckpoint(context);
      next = { ...next, lastDriveSyncAt: now.toISOString(), lastDriveError: null };
    } catch (error) {
      await rethrowGoogleOwnershipLoss(error, context);
      result.drive.state = "failed";
      lastError = safeGoogleError(error);
      next = { ...next, lastDriveError: lastError };
    }
  }
  next = { ...next, lastError };
  await googleOwnershipCheckpoint(context);
  await writeSettings(vaId, next, context);
  await googleOwnershipCheckpoint(context);
  result.message = lastError;
  return result;
}

export async function syncWorkerGoogleEvidenceIfDue(vaId: number) {
  return syncWorkerGoogleEvidence(vaId, { onlyDue: true });
}
