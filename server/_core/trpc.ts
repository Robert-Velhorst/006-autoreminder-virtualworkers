import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getActiveWorkerProfileResolution } from "../workerOperatorContext";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

async function assertActiveWorkerProfile(userId: number) {
  let resolution: Awaited<ReturnType<typeof getActiveWorkerProfileResolution>>;
  try {
    resolution = await getActiveWorkerProfileResolution(userId);
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to verify the active worker profile",
    });
  }

  if (resolution.profileId === null || !Number.isSafeInteger(resolution.profileId) || resolution.profileId <= 0) {
    throw new TRPCError({
      code: resolution.ambiguous ? "PRECONDITION_FAILED" : "FORBIDDEN",
      message: resolution.ambiguous
        ? "Your worker profile is ambiguous. Ask an administrator to resolve it before tracking time."
        : "An active worker profile is required",
    });
  }
}

export const activeWorkerProcedure = protectedProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;
    const user = ctx.user;

    if (!user || user.role !== "worker") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Operator access requires a worker role" });
    }

    await assertActiveWorkerProfile(user.id);
    return next({ ctx: { ...ctx, user } });
  }),
);

// Dashboard operations expose worker evidence and founder controls. Generic
// authenticated accounts must not be able to invoke those procedures.
export const operatorAccountProcedure = protectedProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;
    const user = ctx.user;

    if (!user || (user.role !== "admin" && user.role !== "worker")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Operator access requires an admin or worker account" });
    }

    if (user.role === "worker") await assertActiveWorkerProfile(user.id);

    return next({
      ctx: {
        ...ctx,
        user,
      },
    });
  }),
);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
