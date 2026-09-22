import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./_core/trpc";
import {
  getMaintenanceCenterStatus,
  runMaintenanceJob,
  updateMaintenanceSetting,
  type MaintenanceJobKey,
} from "./maintenanceCenter";

const jobKeySchema = z.enum([
  "google_evidence",
  "trello_commitments",
  "communication_evidence",
  "eod_compliance",
  "weekly_analysis",
  "aptlss_queue",
  "webhook_sync",
  "database_preload",
]);

export const maintenanceRouter = router({
  status: adminProcedure.query(() => getMaintenanceCenterStatus()),

  update: adminProcedure
    .input(z.object({
      jobKey: jobKeySchema,
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1).max(43_200),
    }))
    .mutation(({ input }) => updateMaintenanceSetting(input.jobKey, input.enabled, input.intervalMinutes)),

  run: adminProcedure
    .input(z.object({ jobKey: jobKeySchema }))
    .mutation(async ({ input }) => {
      const status = await getMaintenanceCenterStatus();
      if (status.find((job) => job.key === input.jobKey)?.active) {
        throw new TRPCError({ code: "CONFLICT", message: "This maintenance run is already active" });
      }
      void runMaintenanceJob(input.jobKey as MaintenanceJobKey, "manual").catch((error) => {
        console.error(`[MaintenanceCenter] Manual ${input.jobKey} run failed`, error);
      });
      return { started: true, jobKey: input.jobKey, startedAt: new Date().toISOString() };
    }),
});
