import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema.postgres";
import { TRPCError } from "@trpc/server";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../databaseAvailability";
import { resolveRequestAuthentication, type AuthenticatedRequest } from "./requestAuthentication";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  const requestWithUser = opts.req as AuthenticatedRequest;
  if (!("user" in requestWithUser)) {
    Object.assign(requestWithUser, await resolveRequestAuthentication(opts.req));
  }
  if (requestWithUser.authenticationUnavailable) {
    opts.res.setHeader("Retry-After", "5");
    opts.res.setHeader("Cache-Control", "no-store");
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_UNAVAILABLE_MESSAGE });
  }

  return {
    req: opts.req,
    res: opts.res,
    user: requestWithUser.user ?? null,
  };
}
