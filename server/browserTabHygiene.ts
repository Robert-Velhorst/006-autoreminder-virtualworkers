import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { and, desc, eq, like } from "drizzle-orm";
import {
  browserTabDailyEvidence,
  browserTabStates,
  appSettings,
  users,
  vaProfiles,
} from "../drizzle/schema";
import {
  DEFAULT_BROWSER_TAB_POLICY,
  evaluateBrowserTabHygiene,
  normalizeBrowserTabPolicy,
  type BrowserTabPolicy,
} from "../shared/browserTabPolicy";
import { dateKeyInTimeZone } from "../shared/workerTime";
import { getDb } from "./db";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";

const POLICY_KEY = "browserTabPolicy";
const COLLECTOR_TOKEN_KEY = "browserTabCollectorToken";
const MAX_STORED_TABS = 250;
const COLLECTOR_TOKEN_HASH_PREFIX = "sha256:";
const LEGACY_COLLECTOR_TOKEN_HASH_PREFIX = "sha256hex:";

export interface BrowserTabInventoryItem {
  id: string;
  title: string;
  url: string;
  pinned: boolean;
  active: boolean;
  windowId: number;
}

export interface BrowserTabInventoryInput {
  collectorId: string;
  collectorLabel?: string;
  tabs: BrowserTabInventoryItem[];
}

function scopedSettingKey(key: string, vaId: number) {
  return `${key}:${vaId}`;
}

async function readSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function writeSetting(key: string, value: string, vaId: number | null = null) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to persist browser-tab settings");
  await db.insert(appSettings).values({ vaId, key, value }).onDuplicateKeyUpdate({ set: { value, vaId } });
}

async function readWorkerSetting(key: string, vaId: number) {
  return readSetting(scopedSettingKey(key, vaId));
}

async function getWorkEndTime(vaId: number) {
  const db = await getDb();
  if (!db) return "18:00";
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.vaId, vaId), eq(appSettings.key, "daily_schedule")))
    .orderBy(desc(appSettings.updatedAt))
    .limit(1);
  try {
    const parsed = JSON.parse(rows[0]?.value ?? "{}") as { endTime?: unknown };
    return typeof parsed.endTime === "string" && /^\d{2}:\d{2}$/.test(parsed.endTime)
      ? parsed.endTime
      : (await resolveWorkerOperatorContextById(vaId)).workEndTime;
  } catch {
    return (await resolveWorkerOperatorContextById(vaId)).workEndTime;
  }
}

export async function getBrowserTabPolicy(vaId: number): Promise<BrowserTabPolicy> {
  const raw = await readWorkerSetting(POLICY_KEY, vaId);
  if (!raw) return DEFAULT_BROWSER_TAB_POLICY;
  try {
    return normalizeBrowserTabPolicy(JSON.parse(raw) as Partial<BrowserTabPolicy>);
  } catch {
    return DEFAULT_BROWSER_TAB_POLICY;
  }
}

export async function setBrowserTabPolicy(vaId: number, input: Partial<BrowserTabPolicy>) {
  const policy = normalizeBrowserTabPolicy(input);
  await writeSetting(scopedSettingKey(POLICY_KEY, vaId), JSON.stringify(policy), vaId);
  return policy;
}

export async function ensureBrowserTabCollectorToken(vaId: number) {
  const existing = await readWorkerSetting(COLLECTOR_TOKEN_KEY, vaId);
  // Older installations stored the raw collector token. Preserve an already
  // configured extension once, then replace the database value with a hash.
  if (existing?.trim()
    && !existing.startsWith(COLLECTOR_TOKEN_HASH_PREFIX)
    && !existing.startsWith(LEGACY_COLLECTOR_TOKEN_HASH_PREFIX)) {
    const token = existing.trim();
    await writeSetting(scopedSettingKey(COLLECTOR_TOKEN_KEY, vaId), hashBrowserTabCollectorToken(token), vaId);
    return token;
  }
  const token = randomBytes(32).toString("base64url");
  await writeSetting(scopedSettingKey(COLLECTOR_TOKEN_KEY, vaId), hashBrowserTabCollectorToken(token), vaId);
  return token;
}

export async function hasBrowserTabCollectorToken(vaId: number) {
  return Boolean((await readWorkerSetting(COLLECTOR_TOKEN_KEY, vaId))?.trim());
}

export function hashBrowserTabCollectorToken(token: string) {
  return `${COLLECTOR_TOKEN_HASH_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

export function browserTabCollectorTokenMatches(stored: string | null | undefined, candidate: string | null | undefined) {
  if (!stored || !candidate) return false;
  const expected = stored.startsWith(COLLECTOR_TOKEN_HASH_PREFIX)
    ? stored
    : stored.startsWith(LEGACY_COLLECTOR_TOKEN_HASH_PREFIX)
      ? stored
      : hashBrowserTabCollectorToken(stored);
  const actual = hashBrowserTabCollectorToken(candidate);
  const legacyActual = `${LEGACY_COLLECTOR_TOKEN_HASH_PREFIX}${createHash("sha256").update(candidate).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(expected.startsWith(LEGACY_COLLECTOR_TOKEN_HASH_PREFIX) ? legacyActual : actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function tokenMatches(expected: string | null | undefined, candidate: string | null | undefined) {
  return browserTabCollectorTokenMatches(expected, candidate);
}

async function legacyCollectorOwnerId() {
  const db = await getDb();
  if (!db) return null;
  const [profile] = await db.select({ userId: vaProfiles.userId }).from(vaProfiles)
    .where(eq(vaProfiles.status, "active"))
    .orderBy(vaProfiles.id)
    .limit(1)
    .catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { code?: string }).code === "ER_NO_SUCH_TABLE") return [];
      throw error;
    });
  if (profile) return profile.userId;
  const [worker] = await db.select({ id: users.id }).from(users)
    .where(eq(users.role, "worker"))
    .orderBy(users.id)
    .limit(1);
  return worker?.id ?? null;
}

export async function resolveBrowserTabCollectorWorker(candidate: string | null | undefined) {
  if (!candidate) return null;
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ vaId: appSettings.vaId, value: appSettings.value })
    .from(appSettings)
    .where(like(appSettings.key, `${COLLECTOR_TOKEN_KEY}:%`));
  for (const row of rows) {
    if (row.vaId && tokenMatches(row.value, candidate)) return row.vaId;
  }
  const legacy = await readSetting(COLLECTOR_TOKEN_KEY);
  return tokenMatches(legacy, candidate) ? legacyCollectorOwnerId() : null;
}

export async function resolveBrowserTabCollectorUserOpenId(vaId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ openId: users.openId })
    .from(users)
    .where(eq(users.id, vaId))
    .limit(1);
  return row?.openId ?? null;
}

function sanitizeUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`.slice(0, 2_048);
    }
    return `${parsed.protocol}//`.slice(0, 2_048);
  } catch {
    return "unknown://";
  }
}

function sanitizeTab(tab: BrowserTabInventoryItem): BrowserTabInventoryItem {
  return {
    id: String(tab.id).slice(0, 64),
    title: tab.title.trim().slice(0, 512) || "Untitled tab",
    url: sanitizeUrl(tab.url),
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    windowId: Number.isFinite(tab.windowId) ? Math.trunc(tab.windowId) : 0,
  };
}

function actionableTabs(tabs: BrowserTabInventoryItem[], policy: BrowserTabPolicy) {
  return tabs.filter((tab) => policy.includePinnedTabs || !tab.pinned);
}

export async function ingestBrowserTabInventory(vaId: number, input: BrowserTabInventoryInput, now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to ingest browser-tab state");
  const tabs = input.tabs.slice(0, MAX_STORED_TABS).map(sanitizeTab);
  const collectorId = input.collectorId.trim().slice(0, 128);
  const worker = await resolveWorkerOperatorContextById(vaId);
  const collectorLabel = input.collectorLabel?.trim().slice(0, 128) || `${worker.displayName} browser`;
  if (!collectorId) throw new Error("collectorId is required");

  const values = {
    vaId,
    collectorId,
    collectorLabel,
    totalTabs: tabs.length,
    pinnedTabs: tabs.filter((tab) => tab.pinned).length,
    windowCount: new Set(tabs.map((tab) => tab.windowId)).size,
    tabsJson: JSON.stringify(tabs),
    capturedAt: now,
  };
  await db.insert(browserTabStates).values(values).onDuplicateKeyUpdate({ set: values });

  const status = await getBrowserTabStatus(vaId, now);
  if (status.warningWindow) await recordBrowserTabEodEvidence(vaId, now, "collector");
  return status;
}

function parseTabs(raw: string): BrowserTabInventoryItem[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_STORED_TABS) : [];
  } catch {
    return [];
  }
}

export async function getLatestBrowserTabState(vaId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(browserTabStates)
    .where(eq(browserTabStates.vaId, vaId))
    .orderBy(desc(browserTabStates.capturedAt))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, tabs: parseTabs(row.tabsJson) } : null;
}

export async function getBrowserTabStatus(vaId: number, now = new Date()) {
  const worker = await resolveWorkerOperatorContextById(vaId);
  const [policy, workEnd, latest, collectorConfigured] = await Promise.all([
    getBrowserTabPolicy(vaId),
    getWorkEndTime(vaId),
    getLatestBrowserTabState(vaId),
    hasBrowserTabCollectorToken(vaId),
  ]);
  const tabs = latest?.tabs ?? [];
  const actionable = actionableTabs(tabs, policy);
  const evaluation = evaluateBrowserTabHygiene({
    now,
    workEnd,
    policy,
    totalTabs: latest?.totalTabs ?? 0,
    actionableTabs: actionable.length,
    capturedAt: latest?.capturedAt ?? null,
    timeZone: worker.timezone,
  });
  return {
    ...evaluation,
    policy,
    workEnd,
    collectorConfigured,
    collectorLabel: latest?.collectorLabel ?? null,
    capturedAt: latest?.capturedAt ?? null,
    pinnedTabs: latest?.pinnedTabs ?? 0,
    windowCount: latest?.windowCount ?? 0,
    tabs: actionable
      .sort((left, right) => Number(right.active) - Number(left.active) || left.title.localeCompare(right.title))
      .slice(0, 50),
  };
}

export async function recordBrowserTabEodEvidence(vaId: number, now = new Date(), source = "auto") {
  const db = await getDb();
  if (!db) throw new Error("Database is required to record browser-tab evidence");
  const worker = await resolveWorkerOperatorContextById(vaId);
  const status = await getBrowserTabStatus(vaId, now);
  const snapshotDate = dateKeyInTimeZone(now, worker.timezone);
  const values = {
    vaId,
    snapshotDate: snapshotDate as unknown as Date,
    status: status.status,
    totalTabs: status.totalTabs,
    actionableTabs: status.actionableTabs,
    allowedTabs: status.allowedTabs,
    compliant: status.compliant,
    source: source.slice(0, 32),
    evidenceJson: JSON.stringify({
      version: 1,
      collectorLabel: status.collectorLabel,
      windowCount: status.windowCount,
      pinnedTabs: status.pinnedTabs,
      excessTabs: status.excessTabs,
      ageMinutes: status.ageMinutes,
      workEnd: status.workEnd,
      tabs: status.tabs,
    }),
    capturedAt: status.capturedAt,
    verifiedAt: now,
  };
  await db.insert(browserTabDailyEvidence).values(values).onDuplicateKeyUpdate({ set: values });
  return { ...status, snapshotDate };
}

export async function getBrowserTabEvidenceHistory(vaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(browserTabDailyEvidence)
    .where(eq(browserTabDailyEvidence.vaId, vaId))
    .orderBy(desc(browserTabDailyEvidence.snapshotDate))
    .limit(Math.min(366, Math.max(1, limit)));
}

export async function getBrowserTabEvidenceByDate(vaId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(browserTabDailyEvidence)
    .where(and(
      eq(browserTabDailyEvidence.vaId, vaId),
      eq(browserTabDailyEvidence.snapshotDate, dateKey as unknown as Date),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return { ...row, evidence: JSON.parse(row.evidenceJson) as Record<string, unknown> };
  } catch {
    return { ...row, evidence: {} };
  }
}
