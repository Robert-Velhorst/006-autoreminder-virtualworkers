import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { vaProfiles, type User } from "../../drizzle/schema";
import { getDb } from "../db";
import { getActiveWorkerProfileId, selectWorkerProfile } from "../workerOperatorContext";

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

export async function requireActiveWorkerProfile(req: Request, res: Response, next: NextFunction) {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "worker") {
    next();
    return;
  }

  try {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Worker access could not be verified" });
      return;
    }
    const profileId = await getActiveWorkerProfileId(user.id, db);
    if (profileId === null) {
      res.status(403).json({ error: "An active worker profile is required" });
      return;
    }
    next();
  } catch {
    res.status(503).json({ error: "Worker access could not be verified" });
  }
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

  const profiles = await db
    .select({ id: vaProfiles.id, status: vaProfiles.status })
    .from(vaProfiles)
    .where(eq(vaProfiles.userId, user.id))
    .orderBy(vaProfiles.id);

  return selectWorkerProfile(profiles)?.id ?? null;
}
