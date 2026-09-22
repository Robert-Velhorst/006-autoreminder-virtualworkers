import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { PASSWORD_MIN_LENGTH, validatePassword } from "./passwordPolicy";
import { and, eq, gt, isNull } from "drizzle-orm";
import { users, vaProfiles, workerInvitations } from "../drizzle/schema";
import { getDb } from "./db";

export const WORKER_INVITATION_TTL_MS = 48 * 60 * 60 * 1_000;
export const WORKER_INVITATION_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;

export class WorkerInvitationError extends Error {
  constructor(message: string, public readonly code: "invalid" | "expired" | "used" | "database" | "conflict") {
    super(message);
  }
}

export function normalizeWorkerInvitationEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 64 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WorkerInvitationError("Enter a valid worker email address of 64 characters or fewer.", "invalid");
  }
  return email;
}

export function hashWorkerInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function validateWorkerInvitationPassword(password: string) {
  try {
    validatePassword(password);
  } catch {
    throw new WorkerInvitationError(
      `Password must be at least ${WORKER_INVITATION_PASSWORD_MIN_LENGTH} characters.`,
      "invalid",
    );
  }
}

function createToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashWorkerInvitationToken(token) };
}

export type WorkerInvitationProfileInput = {
  name: string;
  email: string;
  timezone?: string;
  hourlyRate?: number | null;
  currency?: string;
  workStartHour?: number;
  workEndHour?: number;
  workingDays?: string;
  breakfastTime?: number | null;
  breakfastDuration?: number;
  lunchTime?: number | null;
  lunchDuration?: number;
  dinnerTime?: number | null;
  dinnerDuration?: number;
  trelloMemberId?: string | null;
};

export async function createWorkerInvitation(founderId: number, input: WorkerInvitationProfileInput) {
  const db = await getDb();
  if (!db) throw new WorkerInvitationError("Database unavailable", "database");

  const name = input.name.trim();
  const email = normalizeWorkerInvitationEmail(input.email);
  if (!name || name.length > 255) throw new WorkerInvitationError("Enter a worker name of 255 characters or fewer.", "invalid");
  if (input.timezone && (input.timezone.length > 50 || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(input.timezone))) {
    throw new WorkerInvitationError("Enter a valid IANA timezone.", "invalid");
  }
  for (const [label, hour] of [["start", input.workStartHour], ["end", input.workEndHour], ["breakfast", input.breakfastTime], ["lunch", input.lunchTime], ["dinner", input.dinnerTime]] as const) {
    if (hour !== undefined && hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
      throw new WorkerInvitationError(`The ${label} hour must be between 0 and 23.`, "invalid");
    }
  }
  if (input.workingDays && !/^[0-6](?:,[0-6])*$/.test(input.workingDays)) {
    throw new WorkerInvitationError("Working days must be comma-separated values from 0 through 6.", "invalid");
  }
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) {
    throw new WorkerInvitationError("Currency must be a three-letter code.", "invalid");
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.openId, email)).limit(1);
  if (existing.length) throw new WorkerInvitationError("This email already belongs to an account.", "conflict");

  const { token, tokenHash } = createToken();
  const expiresAt = new Date(Date.now() + WORKER_INVITATION_TTL_MS);

  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      openId: email,
      name,
      email,
      loginMethod: "local",
      role: "worker",
      passwordHash: null,
    }).$returningId();

    const [profile] = await tx.insert(vaProfiles).values({
      founderId,
      userId: user.id,
      name,
      email,
      timezone: input.timezone || "Asia/Manila",
      hourlyRate: input.hourlyRate ?? null,
      currency: input.currency || "USD",
      workStartHour: input.workStartHour ?? 9,
      workEndHour: input.workEndHour ?? 18,
      workingDays: input.workingDays || "1,2,3,4,5",
      breakfastTime: input.breakfastTime ?? null,
      breakfastDuration: input.breakfastDuration ?? 0,
      lunchTime: input.lunchTime ?? 12,
      lunchDuration: input.lunchDuration ?? 60,
      dinnerTime: input.dinnerTime ?? null,
      dinnerDuration: input.dinnerDuration ?? 0,
      trelloMemberId: input.trelloMemberId || null,
      status: "inactive",
    }).$returningId();

    const [invitation] = await tx.insert(workerInvitations).values({
      userId: user.id,
      vaId: profile.id,
      founderId,
      email,
      tokenHash,
      expiresAt,
    }).$returningId();

    return { userId: user.id, vaId: profile.id, invitationId: invitation.id };
  });

  return { ...created, name, email, token, expiresAt };
}

export async function markWorkerInvitationSent(invitationId: number) {
  const db = await getDb();
  if (!db) throw new WorkerInvitationError("Database unavailable", "database");
  await db.update(workerInvitations).set({ sentAt: new Date() }).where(eq(workerInvitations.id, invitationId));
}

export async function getWorkerInvitation(token: string) {
  const db = await getDb();
  if (!db) throw new WorkerInvitationError("Database unavailable", "database");
  if (!token || token.length > 128) throw new WorkerInvitationError("This invitation link is invalid.", "invalid");

  const [row] = await db.select({
    id: workerInvitations.id,
    email: workerInvitations.email,
    expiresAt: workerInvitations.expiresAt,
    acceptedAt: workerInvitations.acceptedAt,
    revokedAt: workerInvitations.revokedAt,
    name: vaProfiles.name,
  }).from(workerInvitations)
    .innerJoin(vaProfiles, eq(vaProfiles.id, workerInvitations.vaId))
    .where(eq(workerInvitations.tokenHash, hashWorkerInvitationToken(token)))
    .limit(1);

  if (!row || row.revokedAt) throw new WorkerInvitationError("This invitation link is invalid.", "invalid");
  if (row.acceptedAt) throw new WorkerInvitationError("This invitation has already been used.", "used");
  if (row.expiresAt.getTime() <= Date.now()) throw new WorkerInvitationError("This invitation has expired.", "expired");
  return row;
}

export async function acceptWorkerInvitation(token: string, password: string) {
  validateWorkerInvitationPassword(password);
  const db = await getDb();
  if (!db) throw new WorkerInvitationError("Database unavailable", "database");
  const tokenHash = hashWorkerInvitationToken(token);
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      id: workerInvitations.id,
      userId: workerInvitations.userId,
      vaId: workerInvitations.vaId,
      openId: users.openId,
      name: users.name,
    }).from(workerInvitations)
      .innerJoin(users, eq(users.id, workerInvitations.userId))
      .where(and(
        eq(workerInvitations.tokenHash, tokenHash),
        isNull(workerInvitations.acceptedAt),
        isNull(workerInvitations.revokedAt),
        gt(workerInvitations.expiresAt, now),
      ))
      .limit(1);

    if (!row) throw new WorkerInvitationError("This invitation is invalid, expired, or already used.", "invalid");

    const updateResult = await tx.update(workerInvitations)
      .set({ acceptedAt: now })
      .where(and(
        eq(workerInvitations.id, row.id),
        isNull(workerInvitations.acceptedAt),
        isNull(workerInvitations.revokedAt),
      ));
    const affectedRows = Array.isArray(updateResult)
      ? Number((updateResult[0] as { affectedRows?: number })?.affectedRows ?? 0)
      : 0;
    if (affectedRows !== 1) throw new WorkerInvitationError("This invitation has already been used.", "used");

    await tx.update(users).set({ passwordHash, lastSignedIn: now }).where(eq(users.id, row.userId));
    await tx.update(vaProfiles).set({ status: "active" }).where(eq(vaProfiles.id, row.vaId));

    return { userId: row.userId, openId: row.openId, name: row.name || "Worker" };
  });
}
