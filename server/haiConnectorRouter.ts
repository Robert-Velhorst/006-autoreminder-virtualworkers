import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { getHaiConnectorStatus, revokeHaiConnectorToken, rotateHaiConnectorToken } from "./haiConnector";

const ownerProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role === "worker") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage the HAI connector" });
  }
  return next({ ctx });
});

export const haiConnectorRouter = router({
  status: ownerProcedure.query(({ ctx }) => getHaiConnectorStatus(ctx.user)),
  rotate: ownerProcedure.input(z.object({ label: z.string().trim().min(1).max(128).optional() })).mutation(({ ctx, input }) => (
    rotateHaiConnectorToken(ctx.user, input.label)
  )),
  revoke: ownerProcedure.mutation(({ ctx }) => revokeHaiConnectorToken(ctx.user)),
});
