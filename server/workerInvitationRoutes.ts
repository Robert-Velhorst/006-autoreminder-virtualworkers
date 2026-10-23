import express, { type Request, type Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { sessionIdentityProof } from "./_core/sessionIdentity";
import {
  acceptWorkerInvitation,
  getWorkerInvitation,
  WorkerInvitationError,
} from "./workerInvitations";

const router = express.Router();

function invitationErrorResponse(error: unknown, res: Response) {
  if (error instanceof WorkerInvitationError) {
    const status = error.code === "database" ? 503 : error.code === "conflict" ? 409 : 400;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error("[WorkerInvitation] Unexpected error", error);
  return res.status(500).json({ error: "The invitation could not be processed." });
}

router.get("/:token", async (req, res) => {
  try {
    const invitation = await getWorkerInvitation(req.params.token);
    return res.json({
      name: invitation.name,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    return invitationErrorResponse(error, res);
  }
});

router.post("/:token/accept", async (req, res) => {
  try {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const accepted = await acceptWorkerInvitation(req.params.token, password);
    const sessionToken = await sdk.createSessionToken(accepted.openId, {
      name: accepted.name,
      expiresInMs: ONE_YEAR_MS,
      expectedIdentity: sessionIdentityProof({ id: accepted.userId, sessionEpoch: accepted.sessionEpoch }),
    });
    res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
    return res.json({ success: true, redirectTo: "/worker/settings?onboarding=1" });
  } catch (error) {
    return invitationErrorResponse(error, res);
  }
});

export default router;
