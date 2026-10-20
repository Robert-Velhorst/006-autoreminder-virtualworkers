import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { v4 as uuid } from 'uuid';
import * as aresDb from '../db-ares';

/**
 * ARES Configuration Router
 * Handles all ARES (Automated Requirement Evaluation System) configuration operations
 */

// Helper to safely convert user ID from string to number
function getUserIdOrThrow(userId: any): number {
  const numId = Number(userId);
  if (!Number.isFinite(numId)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid user ID' });
  }
  return numId;
}

export const aresRouter = router({
  // ─── Configuration Management ────────────────────────────────────────────────
  
  createConfiguration: protectedProcedure
    .input(z.object({
      name: z.string().min(1, 'Configuration name is required'),
      description: z.string().optional(),
      strictnessLevel: z.enum(['lenient', 'moderate', 'strict']).default('moderate'),
      confidenceThreshold: z.number().min(0).max(100).default(40),
      enableVaguenessCheck: z.boolean().default(true),
      enableMeasurabilityCheck: z.boolean().default(true),
      enableTimelineCheck: z.boolean().default(true),
      enableResourceCheck: z.boolean().default(false),
      enableDependencyCheck: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.createAresConfiguration({
          id: uuid(),
          userId,
          name: input.name,
          description: input.description,
          strictnessLevel: input.strictnessLevel,
          confidenceThreshold: input.confidenceThreshold,
          enableVaguenessCheck: input.enableVaguenessCheck,
          enableMeasurabilityCheck: input.enableMeasurabilityCheck,
          enableTimelineCheck: input.enableTimelineCheck,
          enableResourceCheck: input.enableResourceCheck,
          enableDependencyCheck: input.enableDependencyCheck,
          isDefault: false,
        });
        return config;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create ARES configuration',
          cause: error,
        });
      }
    }),

  getConfigurations: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        return await aresDb.getUserAresConfigurations(userId);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch ARES configurations',
          cause: error,
        });
      }
    }),

  getConfiguration: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }
        return config;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch ARES configuration',
          cause: error,
        });
      }
    }),

  updateConfiguration: protectedProcedure
    .input(z.object({
      configId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      strictnessLevel: z.enum(['lenient', 'moderate', 'strict']).optional(),
      confidenceThreshold: z.number().min(0).max(100).optional(),
      enableVaguenessCheck: z.boolean().optional(),
      enableMeasurabilityCheck: z.boolean().optional(),
      enableTimelineCheck: z.boolean().optional(),
      enableResourceCheck: z.boolean().optional(),
      enableDependencyCheck: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        const updated = await aresDb.updateAresConfiguration(input.configId, {
          name: input.name,
          description: input.description,
          strictnessLevel: input.strictnessLevel,
          confidenceThreshold: input.confidenceThreshold,
          enableVaguenessCheck: input.enableVaguenessCheck,
          enableMeasurabilityCheck: input.enableMeasurabilityCheck,
          enableTimelineCheck: input.enableTimelineCheck,
          enableResourceCheck: input.enableResourceCheck,
          enableDependencyCheck: input.enableDependencyCheck,
        });
        return updated;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update ARES configuration',
          cause: error,
        });
      }
    }),

  deleteConfiguration: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        await aresDb.deleteAresConfiguration(input.configId);
        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete ARES configuration',
          cause: error,
        });
      }
    }),

  setDefaultConfiguration: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        await aresDb.setDefaultAresConfiguration(userId, input.configId);
        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to set default ARES configuration',
          cause: error,
        });
      }
    }),

  // ─── Validation Rules Management ─────────────────────────────────────────────

  createValidationRule: protectedProcedure
    .input(z.object({
      configId: z.string(),
      ruleType: z.enum(['vagueness', 'measurability', 'timeline', 'resources', 'dependencies', 'clarity', 'specificity', 'actionability']),
      ruleName: z.string().min(1),
      description: z.string().optional(),
      severity: z.enum(['info', 'warning', 'error']).default('warning'),
      enabled: z.boolean().default(true),
      threshold: z.number().optional(),
      customLogic: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        const rule = await aresDb.createAresValidationRule({
          id: uuid(),
          configId: input.configId,
          ruleType: input.ruleType,
          ruleName: input.ruleName,
          description: input.description,
          severity: input.severity,
          enabled: input.enabled,
          threshold: input.threshold,
          customLogic: input.customLogic,
        });
        return rule;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create validation rule',
          cause: error,
        });
      }
    }),

  getValidationRules: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        return await aresDb.getAresValidationRules(input.configId);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch validation rules',
          cause: error,
        });
      }
    }),

  updateValidationRule: protectedProcedure
    .input(z.object({
      ruleId: z.string(),
      configId: z.string(),
      ruleName: z.string().optional(),
      description: z.string().optional(),
      severity: z.enum(['info', 'warning', 'error']).optional(),
      enabled: z.boolean().optional(),
      threshold: z.number().optional(),
      customLogic: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        const rule = await aresDb.getAresValidationRule(input.ruleId, config.id);
        if (!rule) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Validation rule not found' });
        }

        const updated = await aresDb.updateAresValidationRule(input.ruleId, config.id, {
          ruleName: input.ruleName,
          description: input.description,
          severity: input.severity,
          enabled: input.enabled,
          threshold: input.threshold,
          customLogic: input.customLogic,
        });
        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Validation rule not found' });
        }
        return updated;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update validation rule',
          cause: error,
        });
      }
    }),

  deleteValidationRule: protectedProcedure
    .input(z.object({ ruleId: z.string(), configId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        const rule = await aresDb.getAresValidationRule(input.ruleId, config.id);
        if (!rule) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Validation rule not found' });
        }

        const deleted = await aresDb.deleteAresValidationRule(input.ruleId, config.id);
        if (!deleted) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Validation rule not found' });
        }
        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete validation rule',
          cause: error,
        });
      }
    }),

  // ─── Validation History ─────────────────────────────────────────────────────

  getValidationHistory: protectedProcedure
    .input(z.object({
      configId: z.string(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        return await aresDb.getAresValidationHistory(input.configId, input.limit, input.offset);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch validation history',
          cause: error,
        });
      }
    }),

  getValidationStats: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const userId = getUserIdOrThrow(ctx.user.id);
        const config = await aresDb.getAresConfiguration(input.configId);
        if (!config || config.userId !== userId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Configuration not found',
          });
        }

        return await aresDb.getValidationStats(input.configId);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch validation stats',
          cause: error,
        });
      }
    }),
});
