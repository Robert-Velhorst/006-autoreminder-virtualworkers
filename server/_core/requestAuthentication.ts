import type { NextFunction, Request, Response } from "express";
import type { User } from "../../drizzle/schema";
import { HttpError } from "../../shared/_core/errors";
import { respondDatabaseUnavailable } from "../databaseAvailability";
import { sdk } from "./sdk";

export type AuthenticatedRequest = Request & {
  user?: User | null;
  authenticationUnavailable?: boolean;
};

export async function resolveRequestAuthentication(req: Request) {
  try {
    return { user: await sdk.authenticateRequest(req), authenticationUnavailable: false };
  } catch (error) {
    const rejected = error instanceof HttpError && [401, 403].includes(error.statusCode);
    if (!rejected) console.warn("[Auth] Session verification temporarily unavailable");
    return { user: null, authenticationUnavailable: !rejected };
  }
}

export async function attachRequestAuthentication(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  Object.assign(req, await resolveRequestAuthentication(req));
  if (req.authenticationUnavailable) {
    // tRPC formats its own errors, including batched auth.me responses.
    if (req.path === "/trpc" || req.path.startsWith("/trpc/")) {
      res.setHeader("Retry-After", "5");
      res.setHeader("Cache-Control", "no-store");
    } else {
      respondDatabaseUnavailable(res);
      return;
    }
  }
  next();
}
