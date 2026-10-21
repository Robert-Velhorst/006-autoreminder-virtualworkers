import { eq } from "drizzle-orm";
import { ForbiddenError } from "../shared/_core/errors";
import { users, type User } from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { DatabaseUnavailableError } from "./databaseAvailability";
import { getActiveWorkerProfileId } from "./workerOperatorContext";
import { sessionIdentityProof, type SessionIdentityProof } from "./_core/sessionIdentity";

/** Serialize identity verification/minting against lifecycle-trigger invalidation. */
export async function withSessionIdentity<T>(
  openId: string,
  expected: SessionIdentityProof | "legacy" | undefined,
  action: (user: User) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  if (!db) throw new DatabaseUnavailableError();
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.openId, openId)).limit(1).for("share");
    if (!user) throw ForbiddenError("Invalid session identity");
    const proof = sessionIdentityProof(user);
    if (expected === "legacy" ? proof.sessionEpoch !== "0"
      : expected && (expected.userId !== proof.userId || expected.sessionEpoch !== proof.sessionEpoch)) {
      throw ForbiddenError("Session identity changed");
    }
    if (user.role === "worker" && await getActiveWorkerProfileId(user.id, tx) === null) {
      throw ForbiddenError("An active worker profile is required");
    }
    return action(user);
  });
}
