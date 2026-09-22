import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { vaProfiles, type User } from "../../drizzle/schema";
import { getDb } from "../db";

export function requestUser(req: Request) {
  return (req as Request & { user?: User | null }).user ?? null;
}

export function requireAuthenticated(req: Request, res: Response, next: NextFunction) {
  if (!requestUser(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Forbidden - admin only" });
    return;
  }
  next();
}

export async function resolveWorkerProfileId(req: Request, requestedWorkerId?: unknown) {
  const user = requestUser(req);
  if (!user) return null;

  if (user.role === "admin") {
    const id = Number(requestedWorkerId);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  if (user.role !== "worker") return null;
  const db = await getDb();
  if (!db) return null;

  const [profile] = await db
    .select({ id: vaProfiles.id })
    .from(vaProfiles)
    .where(eq(vaProfiles.userId, user.id))
    .limit(1);

  return profile?.id ?? null;
}
