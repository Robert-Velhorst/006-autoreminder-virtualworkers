import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import nodemailer from "nodemailer";
import {
  appSettings,
  aptlssPlans,
  emailTasks,
  workspaceEvidenceItems,
  workspaceEvidenceLinks,
} from "../drizzle/schema";
import { getDb } from "./db";
import { upsertSourceCommitment } from "./sourceCommitments";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
import { zonedDateTimeToUtc } from "../shared/workerTime";
import { mapWithConcurrency } from "./utils/concurrency";

const SETTINGS_KEY = "googleEvidence";
const TOKEN_KEY = "googleEvidenceRefreshToken";
const MAIL_DELIVERY_TOKEN_KEY = "googleMailDeliveryRefreshToken";
const MAIL_DELIVERY_PROFILE_KEY = "googleMailDeliveryProfile";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const GMAIL_MESSAGE_DETAILS_CONCURRENCY = 5;

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
  lastError: string | null;
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
    lastError: null,
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
    lastError: nullableString(raw.lastError, 512),
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

async function writeSettings(vaId: number, settings: GoogleEvidenceSettings) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to save Google evidence settings");
  await db.insert(appSettings).values({
    vaId,
    key: scopedKey(vaId),
    value: JSON.stringify(settings),
  }).onDuplicateKeyUpdate({
    set: { vaId, value: JSON.stringify(settings) },
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
  await db.insert(appSettings).values({ vaId: null, key, value }).onDuplicateKeyUpdate({
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
  }).onDuplicateKeyUpdate({
    set: { vaId, value: encryptGoogleRefreshToken(clean) },
  });
}

export async function clearGoogleRefreshToken(vaId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to remove Google credentials");
  await db.delete(appSettings).where(eq(appSettings.key, scopedTokenKey(vaId)));
}

async function configuredGoogleCredentials(vaId: number) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  // A global refresh token is suitable only for local development. In a
  // shared production workspace, every worker must use their own encrypted
  // OAuth connection so evidence cannot cross worker boundaries.
  const refreshToken = await getStoredRefreshToken(vaId) ?? developmentGoogleRefreshTokenFallback();
  return {
    clientId,
    clientSecret,
    refreshToken,
    ready: Boolean(clientId && clientSecret && refreshToken),
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
}) {
  if (!credentials.clientId || !credentials.clientSecret) {
    return "Google evidence needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.";
  }
  if (!credentials.refreshToken) {
    return "Connect Google for this worker to authorize read-only Gmail and Drive evidence.";
  }
  return null;
}

export function developmentGoogleRefreshTokenFallback(env = process.env) {
  if (env.NODE_ENV === "production") return null;
  return env.GOOGLE_REFRESH_TOKEN?.trim() || null;
}

function safeGoogleError(error: unknown) {
  if (!(error instanceof Error)) return "Google evidence sync failed.";
  if (/timed out|abort/i.test(error.message)) return "Google evidence request timed out.";
  if (/unauthori[sz]ed|forbidden|invalid_grant|access token/i.test(error.message)) {
    return "Google access was rejected. Reconnect the Google credentials.";
  }
  return "Google evidence sync failed. Check server configuration and Google API access.";
}

async function getGoogleAccessToken(vaId: number) {
  const credentials = await configuredGoogleCredentials(vaId);
  if (!credentials.ready) throw new Error(googleEvidenceSetupMessage(credentials) ?? "Google evidence is not ready.");
  return getGoogleAccessTokenForRefreshToken(credentials.clientId!, credentials.clientSecret!, credentials.refreshToken!);
}

async function getGoogleAccessTokenForRefreshToken(clientId: string, clientSecret: string, refreshToken: string) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const payload = await response.json() as { access_token?: unknown };
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

async function getGoogleMailDeliveryAccessToken() {
  const credentials = await configuredGoogleMailDeliveryCredentials();
  if (!credentials.ready) throw new Error("Google mail delivery is not connected");
  return getGoogleAccessTokenForRefreshToken(credentials.clientId!, credentials.clientSecret!, credentials.refreshToken!);
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

export async function sendGoogleMail(options: { to: string; subject: string; html: string; text: string }) {
  const [token, from] = await Promise.all([
    getGoogleMailDeliveryAccessToken(),
    getGoogleMailDeliverySenderEmail(),
  ]);
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const composed = await composer.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  const raw = (composed.message as Buffer).toString("base64url");
  const response = await fetch(`${GMAIL_API_URL}/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Gmail send request failed (${response.status})`);
  const payload = await response.json() as { id?: unknown };
  return { id: typeof payload.id === "string" ? payload.id : null };
}

async function googleJson<T>(url: string, token: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google API request failed (${response.status})`);
  return response.json() as Promise<T>;
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
  const financial = /\b(invoice|factuur|payment|betaling|receipt|bon|statement|afschrift|balance|saldo|credit|debit|bank|tax|belasting|btw|subscription|abonnement)\b/i.test(haystack);
  const deliveryFailure = /delivery status notification|address not found|undeliverable|niet bezorgd/i.test(haystack);
  const requiresReview = /identity|verification|verify|document|proof of address|actie vereist|action required|deadline|urgent/i.test(haystack);
  const suggestedNextAction = deliveryFailure
    ? "Correct the recipient details, then resend or record the delivery failure on the related card."
    : requiresReview
      ? "Review the request, identify the required document or response, then link it to the related card."
      : financial
        ? "Review the financial record, file it against the related work, and act only if a follow-up is required."
        : "Review the message, decide whether a reply or filing action is required, and link it to the related card.";
  return {
    category: financial ? "financial" as const : "non_financial" as const,
    suggestedNextAction,
    summary: snippet.trim().slice(0, 2_000) || "No message preview was provided by Gmail.",
  };
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

async function listGmailMessages(token: string, lookbackDays: number): Promise<GmailMessage[]> {
  const query = new URLSearchParams({
    q: `in:inbox -in:spam -in:trash newer_than:${lookbackDays}d`,
    maxResults: "100",
  });
  const listed = await googleJson<{ messages?: Array<{ id?: string; threadId?: string }> }>(
    `${GMAIL_API_URL}/messages?${query.toString()}`,
    token,
  );
  const messages = await mapWithConcurrency((listed.messages ?? []).slice(0, 100), GMAIL_MESSAGE_DETAILS_CONCURRENCY, async (item) => {
    if (!item.id || !item.threadId) return null;
    const params = new URLSearchParams({ format: "metadata", metadataHeaders: "From", fields: "id,threadId,snippet,internalDate,payload(headers)" });
    params.append("metadataHeaders", "Subject");
    const details = await googleJson<{
      id?: string;
      threadId?: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }>(`${GMAIL_API_URL}/messages/${encodeURIComponent(item.id)}?${params.toString()}`, token);
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

  const latestByThread = new Map<string, GmailMessage>();
  for (const message of messages.filter((item): item is GmailMessage => Boolean(item))) {
    const current = latestByThread.get(message.threadId);
    if (!current || message.receivedAt > current.receivedAt) latestByThread.set(message.threadId, message);
  }
  return Array.from(latestByThread.values());
}

async function syncGmailEvidence(vaId: number, settings: GoogleEvidenceSettings["gmail"], token: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to ingest Gmail evidence");
  const [messages, cards, worker] = await Promise.all([
    listGmailMessages(token, settings.lookbackDays),
    getWorkerCards(vaId),
    resolveWorkerOperatorContextById(vaId),
  ]);
  let linked = 0;
  let commitmentsCreated = 0;
  for (const message of messages) {
    const classification = classifyGoogleEmail(message.subject, message.snippet);
    const match = findExactCardMatch(`${message.subject}\n${message.snippet}`, cards);
    const deadline = extractExplicitDeadline(`${message.subject}\n${message.snippet}`, worker.timezone);
    const deadlineIsPlausible = deadline
      && deadline.dueAt.getTime() >= message.receivedAt.getTime() - 24 * 60 * 60_000
      && deadline.dueAt.getTime() <= message.receivedAt.getTime() + 5 * 365 * 24 * 60 * 60_000;
    if (match) linked++;
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
    await db.insert(emailTasks).values(values).onDuplicateKeyUpdate({
      set: {
        gmailThreadId: values.gmailThreadId,
        subject: values.subject,
        fromAddress: values.fromAddress,
        fromName: values.fromName,
        snippet: values.snippet,
        receivedAt: values.receivedAt,
        category: values.category,
        deadlineAt: values.deadlineAt,
        trelloCardId: values.trelloCardId,
        trelloCardName: values.trelloCardName,
        trelloCardUrl: values.trelloCardUrl,
        suggestedNextAction: values.suggestedNextAction,
        llmSummary: values.llmSummary,
      },
    });
    await db.update(emailTasks).set({ status: "archived", archivedAt: new Date() }).where(and(
      eq(emailTasks.vaId, vaId),
      eq(emailTasks.gmailThreadId, message.threadId),
      lt(emailTasks.receivedAt, message.receivedAt),
    ));
    if (deadlineIsPlausible && worker.founderId) {
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
      });
      if (outcome.state === "created" || outcome.state === "updated") commitmentsCreated++;
    }
  }
  return { scanned: messages.length, imported: messages.length, linked, commitmentsCreated };
}

async function listDriveFiles(token: string, settings: GoogleEvidenceSettings["drive"]): Promise<DriveFile[]> {
  const modifiedAfter = new Date(Date.now() - settings.lookbackDays * 24 * 60 * 60 * 1_000).toISOString();
  const clauses = ["trashed = false", `modifiedTime >= '${modifiedAfter}'`];
  if (settings.folderId) clauses.push(`'${settings.folderId.replace(/'/g, "\\'")}' in parents`);
  const query = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: "100",
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,description,parents,size)",
  });
  const result = await googleJson<{ files?: Array<Record<string, unknown>> }>(`${DRIVE_API_URL}/files?${query.toString()}`, token);
  return (result.files ?? []).flatMap((file) => {
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

async function replaceAutomaticEvidenceLinks(evidenceId: number, match: ReturnType<typeof findExactCardMatch>) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to link Google Drive evidence");
  const current = await db.select({ linkMethod: workspaceEvidenceLinks.linkMethod })
    .from(workspaceEvidenceLinks)
    .where(eq(workspaceEvidenceLinks.evidenceId, evidenceId));
  if (current.some((link) => link.linkMethod === "manual")) return false;
  await db.delete(workspaceEvidenceLinks).where(and(
    eq(workspaceEvidenceLinks.evidenceId, evidenceId),
    eq(workspaceEvidenceLinks.linkMethod, "automatic"),
  ));
  if (!match) return false;
  await db.insert(workspaceEvidenceLinks).values({
    evidenceId,
    cardId: match.card.cardId,
    relevanceScore: match.score,
    matchReason: match.reason,
    linkMethod: "automatic",
  }).onDuplicateKeyUpdate({
    set: { relevanceScore: match.score, matchReason: match.reason, linkMethod: "automatic" },
  });
  return true;
}

async function syncDriveEvidence(vaId: number, settings: GoogleEvidenceSettings["drive"], token: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to ingest Google Drive evidence");
  const [files, cards] = await Promise.all([listDriveFiles(token, settings), getWorkerCards(vaId)]);
  let linked = 0;
  for (const file of files) {
    const sourceId = `${vaId}:${file.id}`;
    const observedAt = new Date();
    const metadata = JSON.stringify({ googleFileId: file.id, parents: file.parents, size: file.size });
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ name: file.name, description: file.description, modifiedAt: file.modifiedAt?.toISOString(), sourceUrl: file.sourceUrl }))
      .digest("hex");
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
    await db.insert(workspaceEvidenceItems).values(values).onDuplicateKeyUpdate({
      set: {
        vaId,
        sourceContainerId: values.sourceContainerId,
        kind: values.kind,
        title: values.title,
        summary: values.summary,
        content: values.content,
        sourceUrl: values.sourceUrl,
        mimeType: values.mimeType,
        modifiedAt: values.modifiedAt,
        observedAt: values.observedAt,
        contentHash: values.contentHash,
        metadataJson: values.metadataJson,
        active: true,
      },
    });
    const [stored] = await db.select({ id: workspaceEvidenceItems.id })
      .from(workspaceEvidenceItems)
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId),
        eq(workspaceEvidenceItems.source, "google_drive"),
        eq(workspaceEvidenceItems.sourceId, sourceId),
      ))
      .limit(1);
    const match = findExactCardMatch(`${file.name}\n${file.description ?? ""}`, cards);
    if (stored && await replaceAutomaticEvidenceLinks(stored.id, match)) linked++;
  }
  return { scanned: files.length, imported: files.length, linked };
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
  return {
    credentialsReady: credentials.ready,
    clientConfigured: Boolean(credentials.clientId && credentials.clientSecret),
    connectionMode: credentials.refreshToken ? (await getStoredRefreshToken(vaId) ? "worker" : "environment") : null,
    setupMessage: googleEvidenceSetupMessage(credentials),
    settings,
    gmail: {
      enabled: settings.gmail.enabled,
      lastSyncedAt: settings.lastGmailSyncAt,
      intervalMinutes: settings.gmail.intervalMinutes,
      hasRetainedEvidence: emailRows.length > 0,
    },
    drive: {
      enabled: settings.drive.enabled,
      lastSyncedAt: settings.lastDriveSyncAt,
      intervalMinutes: settings.drive.intervalMinutes,
      folderScoped: Boolean(settings.drive.folderId),
      hasRetainedEvidence: driveRows.length > 0,
    },
    lastError: settings.lastError,
  };
}

export async function syncWorkerGoogleEvidence(
  vaId: number,
  options: { gmail?: boolean; drive?: boolean; onlyDue?: boolean } = {},
) {
  const settings = await readSettings(vaId);
  const now = new Date();
  const requestedGmail = options.gmail ?? true;
  const requestedDrive = options.drive ?? true;
  const gmailDue = settings.gmail.enabled && requestedGmail && (!options.onlyDue || shouldSync(settings.lastGmailSyncAt, settings.gmail.intervalMinutes, now));
  const driveDue = settings.drive.enabled && requestedDrive && (!options.onlyDue || shouldSync(settings.lastDriveSyncAt, settings.drive.intervalMinutes, now));
  const credentials = await configuredGoogleCredentials(vaId);

  if (!credentials.ready) {
    return {
      configured: false,
      gmail: { state: gmailDue ? "blocked" : "skipped", scanned: 0, imported: 0, linked: 0 },
      drive: { state: driveDue ? "blocked" : "skipped", scanned: 0, imported: 0, linked: 0 },
      message: googleEvidenceSetupMessage(credentials),
    };
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(vaId);
  } catch (error) {
    const message = safeGoogleError(error);
    await writeSettings(vaId, { ...settings, lastError: message });
    return {
      configured: true,
      gmail: { state: gmailDue ? "failed" : "skipped", scanned: 0, imported: 0, linked: 0 },
      drive: { state: driveDue ? "failed" : "skipped", scanned: 0, imported: 0, linked: 0 },
      message,
    };
  }
  let next = settings;
  let lastError: string | null = null;
  const result = {
    configured: true,
    gmail: { state: gmailDue ? "synced" : "skipped", scanned: 0, imported: 0, linked: 0 },
    drive: { state: driveDue ? "synced" : "skipped", scanned: 0, imported: 0, linked: 0 },
    message: null as string | null,
  };
  if (gmailDue) {
    try {
      Object.assign(result.gmail, await syncGmailEvidence(vaId, settings.gmail, token));
      next = { ...next, lastGmailSyncAt: now.toISOString() };
    } catch (error) {
      result.gmail.state = "failed";
      lastError = safeGoogleError(error);
    }
  }
  if (driveDue) {
    try {
      Object.assign(result.drive, await syncDriveEvidence(vaId, settings.drive, token));
      next = { ...next, lastDriveSyncAt: now.toISOString() };
    } catch (error) {
      result.drive.state = "failed";
      lastError = safeGoogleError(error);
    }
  }
  next = { ...next, lastError };
  await writeSettings(vaId, next);
  result.message = lastError;
  return result;
}

export async function syncWorkerGoogleEvidenceIfDue(vaId: number) {
  return syncWorkerGoogleEvidence(vaId, { onlyDue: true });
}
