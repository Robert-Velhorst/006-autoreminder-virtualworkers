import { and, eq, isNull, sql } from "drizzle-orm";
import { appSettings } from "../../drizzle/schema.postgres";
import { getDb } from "../db";
import { OAUTH_LOGIN_STATE_PREFIX, OAUTH_LOGIN_STATE_TTL_MS, type OAuthLoginStateRecord } from "./oauthState";

function stateKey(record: OAuthLoginStateRecord) {
  if (!/^[a-f0-9]{64}$/.test(record.stateHash) || !/^[a-f0-9]{64}$/.test(record.bindingHash)
    || typeof record.callbackUri !== "string" || !record.callbackUri) {
    throw new Error("Invalid OAuth state record");
  }
  return `${OAUTH_LOGIN_STATE_PREFIX}${record.stateHash}`;
}

function stateValue(record: OAuthLoginStateRecord) {
  return JSON.stringify({ bindingHash: record.bindingHash, callbackUri: record.callbackUri });
}

const expiryCutoff = () => sql`timezone('UTC', clock_timestamp()) - ${OAUTH_LOGIN_STATE_TTL_MS}::integer * INTERVAL '1 millisecond'`;

export async function createOAuthLoginState(record: OAuthLoginStateRecord): Promise<void> {
  const key = stateKey(record);
  const db = await getDb();
  if (!db) throw new Error("OAuth state storage unavailable");
  await db.transaction(async tx => {
    await tx.delete(appSettings).where(and(
      sql`left(${appSettings.key}, ${OAUTH_LOGIN_STATE_PREFIX.length}) = ${OAUTH_LOGIN_STATE_PREFIX}`,
      isNull(appSettings.vaId),
      sql`${appSettings.updatedAt} <= ${expiryCutoff()}`,
    ));
    // updatedAt is timestamp WITHOUT time zone: persist and compare UTC explicitly.
    await tx.insert(appSettings).values({ key, vaId: null, value: stateValue(record), updatedAt: sql`timezone('UTC', clock_timestamp())` });
  });
}

export async function consumeOAuthLoginState(record: OAuthLoginStateRecord): Promise<boolean> {
  const key = stateKey(record);
  const db = await getDb();
  if (!db) throw new Error("OAuth state storage unavailable");
  const matches = and(
    eq(appSettings.key, key),
    isNull(appSettings.vaId),
    eq(appSettings.value, stateValue(record)),
  );
  // Serialize consumption in one transaction, checking the clock only after any row-lock wait.
  return db.transaction(async tx => {
    const [locked] = await tx.select({ id: appSettings.id }).from(appSettings)
      .where(matches).for("update");
    if (!locked) return false;
    const consumed = await tx.delete(appSettings).where(and(
      matches,
      eq(appSettings.id, locked.id),
      sql`${appSettings.updatedAt} > ${expiryCutoff()}`,
    )).returning({ id: appSettings.id });
    return consumed.length === 1;
  });
}
