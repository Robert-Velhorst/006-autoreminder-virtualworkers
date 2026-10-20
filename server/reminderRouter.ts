import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { operatorAccountProcedure, router } from "./_core/trpc";
import {
  approveAndSendReminder,
  closeCommitment,
  confirmReminderRetry,
  createReminder,
  getReminderDashboard,
  processDueReminders,
  updateReminderPolicy,
} from "./reminderOrchestration";

const reminderProcedure = operatorAccountProcedure;

const reminderAdminProcedure = reminderProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "This maintenance action requires an admin account" });
  }
  return next({ ctx });
});

function operationalError(error: unknown): never {
  const message = error instanceof Error ? error.message : "Reminder operation failed";
  if (/not found/i.test(message)) throw new TRPCError({ code: "NOT_FOUND", message });
  if (/cannot|does not belong|not accessible|requires/i.test(message)) throw new TRPCError({ code: "FORBIDDEN", message });
  if (/required|disabled|quiet|limit|cooldown|state|email address/i.test(message)) throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().trim().min(1).max(64).refine(value => {
  // Intl also accepts numeric offsets; reminder policies require named zones.
  if (value.startsWith("+") || value.startsWith("-")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, { message: "Timezone must be a valid IANA time zone" });

export const reminderRouter = router({
  dashboard: reminderProcedure.query(async ({ ctx }) => {
    try {
      return await getReminderDashboard(ctx.user);
    } catch (error) {
      operationalError(error);
    }
  }),

  create: reminderProcedure.input(z.object({
    title: z.string().trim().min(3).max(500),
    context: z.string().trim().max(10_000).nullable().optional(),
    dueAt: z.coerce.date(),
    sourceType: z.enum(["manual", "trello", "gmail", "google_drive", "system"]).default("manual"),
    sourceId: z.string().trim().max(255).nullable().optional(),
    sourceUrl: z.string().url().max(1024).nullable().optional(),
    assignedUserId: z.number().int().positive().nullable().optional(),
    ruleName: z.string().trim().max(255).optional(),
    triggerType: z.enum(["before_due", "at_due", "after_due", "no_update", "manual"]).default("before_due"),
    offsetMinutes: z.number().int().min(0).max(525_600).default(60),
    channel: z.enum(["in_app", "email"]).default("in_app"),
    requireApproval: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    try {
      const reminderInput = ctx.user.role === "worker"
        ? { ...input, assignedUserId: ctx.user.id }
        : input;
      const result = await createReminder(ctx.user, reminderInput);
      if (ctx.user.role === "admin") await processDueReminders(new Date(), 50, ctx.user.id);
      return result;
    } catch (error) {
      operationalError(error);
    }
  }),

  updatePolicy: reminderProcedure.input(z.object({
    enabled: z.boolean(),
    inAppEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    maxPerDay: z.number().int().min(0).max(50),
    minIntervalMinutes: z.number().int().min(0).max(10_080),
    quietHoursStart: clock,
    quietHoursEnd: clock,
    timezone,
    allowWeekends: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await updateReminderPolicy(ctx.user, input);
    } catch (error) {
      operationalError(error);
    }
  }),

  approveAndSend: reminderProcedure.input(z.object({ scheduleId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    try {
      return await approveAndSendReminder(ctx.user, input.scheduleId);
    } catch (error) {
      operationalError(error);
    }
  }),

  confirmRetry: reminderProcedure.input(z.object({
    scheduleId: z.number().int().positive(),
    confirmation: z.string().trim().min(10).max(2_000),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await confirmReminderRetry(ctx.user, input.scheduleId, input.confirmation);
    } catch (error) {
      operationalError(error);
    }
  }),

  closeCommitment: reminderProcedure.input(z.object({
    commitmentId: z.number().int().positive(),
    status: z.enum(["completed", "cancelled"]),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await closeCommitment(ctx.user, input.commitmentId, input.status);
    } catch (error) {
      operationalError(error);
    }
  }),

  runDueNow: reminderAdminProcedure.mutation(async ({ ctx }) =>
    processDueReminders(new Date(), 50, ctx.user.id)),
});
