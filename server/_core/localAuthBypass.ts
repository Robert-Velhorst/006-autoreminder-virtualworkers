import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { User } from "../../drizzle/schema.postgres";
import { users } from "../../drizzle/schema.postgres";
import { getDb } from "../db";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLocalAuthBypassEnabled() {
  return process.env.LOCAL_AUTH_BYPASS === "true";
}

export function isLoopbackAddress(value: string | undefined | null) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(normalized);
}

export function isAllowedLocalBypassRole(role: string | null | undefined) {
  return role === "worker" || role === "admin";
}

export function assertLocalAuthBypassConfiguration() {
  if (!isLocalAuthBypassEnabled()) return;
  if (process.env.NODE_ENV === "production") {
    throw new Error("LOCAL_AUTH_BYPASS cannot be enabled in production");
  }

  const bindHost = process.env.HOST ?? "127.0.0.1";
  if (!isLoopbackAddress(bindHost)) {
    throw new Error("LOCAL_AUTH_BYPASS requires HOST to be a loopback address");
  }
}

function requestIsLoopback(req: Request) {
  const socketAddress = req.socket.remoteAddress;
  const hostname = req.hostname;
  return isLoopbackAddress(socketAddress) && isLoopbackAddress(hostname);
}

export async function resolveLocalBypassUser(req: Request): Promise<User | null> {
  if (process.env.NODE_ENV === "production") return null;
  if (!isLocalAuthBypassEnabled() || !requestIsLoopback(req)) return null;

  const db = await getDb();
  if (!db) return null;

  const configuredOpenId = process.env.LOCAL_AUTH_BYPASS_OPEN_ID?.trim();
  if (configuredOpenId) {
    const rows = await db.select().from(users).where(eq(users.openId, configuredOpenId)).limit(1);
    const user = rows[0] ?? null;
    return isAllowedLocalBypassRole(user?.role) ? user : null;
  }

  const rows = await db.select().from(users).where(eq(users.role, "worker")).limit(2);
  return rows.length === 1 ? rows[0] : null;
}
