import { router, protectedProcedure, operatorAccountProcedure } from '../_core/trpc';
import { z } from 'zod';
import * as settingsDb from '../db/settings';
import { readPersonalSetting, writePersonalSetting } from '../personalAppSettings';
import { TRPCError } from '@trpc/server';
import { normalizeDailySchedule } from '../dailySchedule';

// Validation schemas
const conflictDetectionSettingsSchema = z.object({
  enabled: z.boolean(),
  warningThresholdMinutes: z.number().min(5).max(120),
  autoResolve: z.boolean(),
  notifyOnConflict: z.boolean(),
  conflictTypes: z.object({
    timeOverlap: z.boolean(),
    resourceConflict: z.boolean(),
    dependencyConflict: z.boolean(),
  }),
});

const batchOperationSettingsSchema = z.object({
  defaultOperationType: z.enum(['re_analyze', 'reschedule']),
  defaultPriority: z.enum(['low', 'normal', 'high', 'critical']),
  autoStartOnQueue: z.boolean(),
  maxConcurrentOperations: z.number().min(1).max(10),
  retryFailedTasks: z.boolean(),
  maxRetries: z.number().min(0).max(5),
  notifyOnCompletion: z.boolean(),
  notifyOnFailure: z.boolean(),
});

const keyboardShortcutSchema = z.object({
  action: z.string(),
  keys: z.string(),
  description: z.string(),
  category: z.enum(['navigation', 'scheduling', 'batch', 'general']),
  isCustom: z.boolean().optional(),
});

const performanceMetricsSchema = z.object({
  totalOperations: z.number(),
  successfulOperations: z.number(),
  failedOperations: z.number(),
  averageExecutionTime: z.number(),
  averageTasksPerOperation: z.number(),
  conflictsDetected: z.number(),
  conflictsResolved: z.number(),
  trends: z.object({
    successRate: z.number(),
    executionTimeTrend: z.enum(['improving', 'declining', 'stable']),
    operationsTrend: z.enum(['increasing', 'decreasing', 'stable']),
  }),
});

export const settingsRouter = router({
  getReplyMonitorBadge: operatorAccountProcedure.query(async ({ ctx }) => {
    const value = await readPersonalSetting(ctx.user.id, "reply_monitor_badge_enabled");
    return { enabled: value === null ? true : value === "true" };
  }),

  setReplyMonitorBadge: operatorAccountProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await writePersonalSetting(ctx.user.id, "reply_monitor_badge_enabled", String(input.enabled));
      return { success: true, enabled: input.enabled };
    }),

  // ============================================
  // CONFLICT DETECTION SETTINGS
  // ============================================

  getConflictDetectionSettings: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await settingsDb.getConflictDetectionSettings(ctx.user.id, ctx.user.openId);
      if (!settings) {
        return null;
      }
      return {
        ...settings,
        conflictTypes: JSON.parse(settings.conflictTypes),
      };
    } catch (error) {
      console.error('Failed to get conflict detection settings:', error);
      throw error;
    }
  }),

  saveConflictDetectionSettings: protectedProcedure
    .input(conflictDetectionSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await settingsDb.saveConflictDetectionSettings(ctx.user.id, ctx.user.openId, {
          enabled: input.enabled ? 1 : 0,
          warningThresholdMinutes: input.warningThresholdMinutes,
          autoResolve: input.autoResolve ? 1 : 0,
          notifyOnConflict: input.notifyOnConflict ? 1 : 0,
          conflictTypes: JSON.stringify(input.conflictTypes),
        });
        return { success: true };
      } catch (error) {
        console.error('Failed to save conflict detection settings:', error);
        throw error;
      }
    }),

  resetConflictDetectionSettings: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await settingsDb.resetConflictDetectionSettings(ctx.user.id, ctx.user.openId);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset conflict detection settings:', error);
      throw error;
    }
  }),

  // ============================================
  // BATCH OPERATION SETTINGS
  // ============================================

  getBatchOperationSettings: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await settingsDb.getBatchOperationSettings(ctx.user.id, ctx.user.openId);
      if (!settings) {
        return null;
      }
      return {
        ...settings,
        autoStartOnQueue: settings.autoStartOnQueue === 1,
        retryFailedTasks: settings.retryFailedTasks === 1,
        notifyOnCompletion: settings.notifyOnCompletion === 1,
        notifyOnFailure: settings.notifyOnFailure === 1,
      };
    } catch (error) {
      console.error('Failed to get batch operation settings:', error);
      throw error;
    }
  }),

  saveBatchOperationSettings: protectedProcedure
    .input(batchOperationSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await settingsDb.saveBatchOperationSettings(ctx.user.id, ctx.user.openId, {
          defaultOperationType: input.defaultOperationType,
          defaultPriority: input.defaultPriority,
          autoStartOnQueue: input.autoStartOnQueue ? 1 : 0,
          maxConcurrentOperations: input.maxConcurrentOperations,
          retryFailedTasks: input.retryFailedTasks ? 1 : 0,
          maxRetries: input.maxRetries,
          notifyOnCompletion: input.notifyOnCompletion ? 1 : 0,
          notifyOnFailure: input.notifyOnFailure ? 1 : 0,
        });
        return { success: true };
      } catch (error) {
        console.error('Failed to save batch operation settings:', error);
        throw error;
      }
    }),

  resetBatchOperationSettings: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await settingsDb.resetBatchOperationSettings(ctx.user.id, ctx.user.openId);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset batch operation settings:', error);
      throw error;
    }
  }),

  // ============================================
  // KEYBOARD SHORTCUTS SETTINGS
  // ============================================

  getKeyboardShortcuts: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await settingsDb.getKeyboardShortcutsSettings(ctx.user.id, ctx.user.openId);
      if (!settings) {
        return [];
      }
      return JSON.parse(settings.shortcuts);
    } catch (error) {
      console.error('Failed to get keyboard shortcuts:', error);
      throw error;
    }
  }),

  saveKeyboardShortcuts: protectedProcedure
    .input(z.array(keyboardShortcutSchema))
    .mutation(async ({ ctx, input }) => {
      try {
        await settingsDb.saveKeyboardShortcutsSettings(ctx.user.id, ctx.user.openId, input);
        return { success: true };
      } catch (error) {
        console.error('Failed to save keyboard shortcuts:', error);
        throw error;
      }
    }),

  resetKeyboardShortcuts: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await settingsDb.resetKeyboardShortcutsSettings(ctx.user.id, ctx.user.openId);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset keyboard shortcuts:', error);
      throw error;
    }
  }),

  // ============================================
  // PERFORMANCE METRICS SETTINGS
  // ============================================

  getPerformanceMetrics: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await settingsDb.getPerformanceMetricsSettings(ctx.user.id, ctx.user.openId);
      if (!settings) {
        return null;
      }
      return {
        ...settings,
        averageExecutionTime: parseFloat(settings.averageExecutionTime as any),
        averageTasksPerOperation: parseFloat(settings.averageTasksPerOperation as any),
        trends: JSON.parse(settings.trends),
      };
    } catch (error) {
      console.error('Failed to get performance metrics:', error);
      throw error;
    }
  }),

  savePerformanceMetrics: protectedProcedure
    .input(performanceMetricsSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await settingsDb.savePerformanceMetricsSettings(ctx.user.id, ctx.user.openId, {
          totalOperations: input.totalOperations,
          successfulOperations: input.successfulOperations,
          failedOperations: input.failedOperations,
          averageExecutionTime: input.averageExecutionTime.toString() as any,
          averageTasksPerOperation: input.averageTasksPerOperation.toString() as any,
          conflictsDetected: input.conflictsDetected,
          conflictsResolved: input.conflictsResolved,
          trends: JSON.stringify(input.trends),
        });
        return { success: true };
      } catch (error) {
        console.error('Failed to save performance metrics:', error);
        throw error;
      }
    }),

  resetPerformanceMetrics: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await settingsDb.resetPerformanceMetricsSettings(ctx.user.id, ctx.user.openId);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset performance metrics:', error);
      throw error;
    }
  }),

  // ============================================
  // BULK OPERATIONS
  // ============================================

  getAllSettings: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await settingsDb.getAllSettings(ctx.user.id, ctx.user.openId);
      return {
        conflictDetection: settings.conflictDetection
          ? {
              ...settings.conflictDetection,
              conflictTypes: JSON.parse(settings.conflictDetection.conflictTypes),
            }
          : null,
        batchOperation: settings.batchOperation
          ? {
              ...settings.batchOperation,
              autoStartOnQueue: settings.batchOperation.autoStartOnQueue === 1,
              retryFailedTasks: settings.batchOperation.retryFailedTasks === 1,
              notifyOnCompletion: settings.batchOperation.notifyOnCompletion === 1,
              notifyOnFailure: settings.batchOperation.notifyOnFailure === 1,
            }
          : null,
        keyboardShortcuts: settings.keyboardShortcuts ? JSON.parse(settings.keyboardShortcuts.shortcuts) : [],
        performanceMetrics: settings.performanceMetrics
          ? {
              ...settings.performanceMetrics,
              averageExecutionTime: settings.performanceMetrics.averageExecutionTime as unknown as number,
              averageTasksPerOperation: settings.performanceMetrics.averageTasksPerOperation as unknown as number,
              trends: JSON.parse(settings.performanceMetrics.trends),
            }
          : null,
      };
    } catch (error) {
      console.error('Failed to get all settings:', error);
      throw error;
    }
  }),

  resetAllSettings: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await settingsDb.resetAllSettings(ctx.user.id, ctx.user.openId);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset all settings:', error);
      throw error;
    }
  }),

  // ============================================
  // SYNC OPERATIONS
  // ============================================

  getSyncLog: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      try {
        return await settingsDb.getSyncLog(ctx.user.id, ctx.user.openId, input.limit);
      } catch (error) {
        console.error('Failed to get sync log:', error);
        throw error;
      }
    }),

  checkForConflicts: protectedProcedure
    .input(
      z.object({
        settingsType: z.string(),
        clientVersion: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const hasConflict = await settingsDb.checkForConflicts(
          ctx.user.id,
          ctx.user.openId,
          input.settingsType,
          input.clientVersion,
        );
        return { hasConflict };
      } catch (error) {
        console.error('Failed to check for conflicts:', error);
        throw error;
      }
    }),

  getDailyGoal: operatorAccountProcedure.query(async ({ ctx }) => {
    const parsed = Number(await readPersonalSetting(ctx.user.id, "daily_hour_goal"));
    return { hours: Number.isFinite(parsed) && parsed > 0 ? parsed : 9 };
  }),

  setDailyGoal: operatorAccountProcedure
    .input(z.object({ hours: z.number().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      await writePersonalSetting(ctx.user.id, "daily_hour_goal", String(input.hours));
      return { hours: input.hours };
    }),

  getSchedule: operatorAccountProcedure.query(async ({ ctx }) => {
    const defaultSchedule = {
      startTime: "08:00",
      endTime: "23:00",
      breaks: [
        { name: "Breakfast", startTime: "09:00", durationMinutes: 30 },
        { name: "Lunch", startTime: "14:30", durationMinutes: 45 },
        { name: "Dinner", startTime: "19:15", durationMinutes: 90 },
      ],
      typingPractice: true,
      typingPracticeMinutes: 30,
    };
    const value = await readPersonalSetting(ctx.user.id, "daily_schedule");
    if (!value) return defaultSchedule;

    try {
      const savedSchedule = { ...defaultSchedule, ...JSON.parse(value) };
      const normalized = normalizeDailySchedule(savedSchedule);
      return normalized.ok ? normalized.value : defaultSchedule;
    } catch {
      return defaultSchedule;
    }
  }),

  setSchedule: operatorAccountProcedure
    .input(z.object({
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
      breaks: z.array(z.object({
        name: z.string().min(1),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        durationMinutes: z.number().int().min(5).max(240),
        icon: z.string().optional(),
      })),
      typingPractice: z.boolean().optional(),
      typingPracticeMinutes: z.number().int().min(0).max(180).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const normalized = normalizeDailySchedule(input);
      if (!normalized.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: normalized.error });
      }
      await writePersonalSetting(ctx.user.id, "daily_schedule", JSON.stringify(normalized.value));
      return normalized.value;
    }),
});
