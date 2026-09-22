/**
 * Batch Operation Templates
 * Pre-configured batch operation profiles for quick access
 */

export interface BatchTemplate {
  id: string;
  name: string;
  description: string;
  operationType:
    | "reanalyze"
    | "reschedule"
    | "conflict_resolution"
    | "optimization";
  icon?: string;
  config: {
    taskFilter?: {
      status?: string[];
      priority?: string[];
      complexity?: string[];
      assignedTo?: string[];
      dateRange?: {
        start: string;
        end: string;
      };
    };
    options?: {
      parallelLimit?: number;
      retryOnFailure?: boolean;
      maxRetries?: number;
      timeoutMs?: number;
      notifyOnCompletion?: boolean;
    };
  };
  estimatedDuration?: number; // in minutes
  tags?: string[];
}

export type BatchTemplatePeriod = "all" | "daily" | "weekly" | "monthly";

const RUNNABLE_BATCH_TEMPLATE_OPERATION_TYPES = new Set<
  BatchTemplate["operationType"]
>(["reanalyze", "reschedule"]);

/**
 * Predefined batch operation templates
 */
export const BATCH_TEMPLATES: BatchTemplate[] = [
  {
    id: "daily-optimization",
    name: "Daily Optimization",
    description: "Optimize all tasks scheduled for today",
    operationType: "optimization",
    icon: "⚡",
    config: {
      taskFilter: {
        dateRange: {
          start: "today",
          end: "today",
        },
      },
      options: {
        parallelLimit: 5,
        retryOnFailure: true,
        maxRetries: 2,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 10,
    tags: ["daily", "optimization", "quick"],
  },
  {
    id: "weekly-reanalysis",
    name: "Weekly Re-analysis",
    description: "Re-analyze all tasks for the upcoming week",
    operationType: "reanalyze",
    icon: "📊",
    config: {
      taskFilter: {
        dateRange: {
          start: "today",
          end: "+7d",
        },
      },
      options: {
        parallelLimit: 3,
        retryOnFailure: true,
        maxRetries: 3,
        timeoutMs: 60000,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 30,
    tags: ["weekly", "reanalysis", "comprehensive"],
  },
  {
    id: "high-priority-reanalyze",
    name: "High Priority Re-analysis",
    description: "Re-analyze all high-priority tasks",
    operationType: "reanalyze",
    icon: "🔴",
    config: {
      taskFilter: {
        priority: ["high", "critical"],
      },
      options: {
        parallelLimit: 2,
        retryOnFailure: true,
        maxRetries: 3,
        timeoutMs: 120000,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 20,
    tags: ["priority", "urgent", "reanalysis"],
  },
  {
    id: "overbooked-resolution",
    name: "Overbooked Resolution",
    description: "Resolve all overbooked scheduling conflicts",
    operationType: "conflict_resolution",
    icon: "⚠️",
    config: {
      options: {
        parallelLimit: 1,
        retryOnFailure: true,
        maxRetries: 2,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 15,
    tags: ["conflict", "resolution", "scheduling"],
  },
  {
    id: "batch-reschedule",
    name: "Batch Reschedule",
    description: "Reschedule all pending tasks",
    operationType: "reschedule",
    icon: "📅",
    config: {
      taskFilter: {
        status: ["pending", "unscheduled"],
      },
      options: {
        parallelLimit: 5,
        retryOnFailure: true,
        maxRetries: 2,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 25,
    tags: ["reschedule", "pending", "batch"],
  },
  {
    id: "complex-task-analysis",
    name: "Complex Task Analysis",
    description: "Deep analysis of complex tasks (complexity >= 7)",
    operationType: "reanalyze",
    icon: "🧠",
    config: {
      taskFilter: {
        complexity: ["7", "8", "9", "10"],
      },
      options: {
        parallelLimit: 1,
        retryOnFailure: true,
        maxRetries: 3,
        timeoutMs: 180000,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 45,
    tags: ["complex", "analysis", "deep"],
  },
  {
    id: "worker-load-balance",
    name: "Worker Load Balance",
    description: "Rebalance task assignments across workers",
    operationType: "optimization",
    icon: "⚖️",
    config: {
      options: {
        parallelLimit: 2,
        retryOnFailure: true,
        maxRetries: 2,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 20,
    tags: ["load-balance", "workers", "optimization"],
  },
  {
    id: "month-end-analysis",
    name: "Month-End Analysis",
    description: "Comprehensive analysis of all tasks for month-end review",
    operationType: "reanalyze",
    icon: "📈",
    config: {
      taskFilter: {
        dateRange: {
          start: "month-start",
          end: "today",
        },
      },
      options: {
        parallelLimit: 3,
        retryOnFailure: true,
        maxRetries: 3,
        timeoutMs: 300000,
        notifyOnCompletion: true,
      },
    },
    estimatedDuration: 60,
    tags: ["month-end", "review", "comprehensive"],
  },
];

/**
 * Get template by ID
 */
export const getTemplate = (templateId: string): BatchTemplate | undefined => {
  return BATCH_TEMPLATES.find(t => t.id === templateId);
};

/**
 * Get templates by operation type
 */
export const getTemplatesByType = (operationType: string): BatchTemplate[] => {
  return BATCH_TEMPLATES.filter(t => t.operationType === operationType);
};

/**
 * Get templates by tag
 */
export const getTemplatesByTag = (tag: string): BatchTemplate[] => {
  return BATCH_TEMPLATES.filter(t => t.tags?.includes(tag));
};

/**
 * Search templates
 */
export const searchTemplates = (query: string): BatchTemplate[] => {
  const lowerQuery = query.toLowerCase();
  return BATCH_TEMPLATES.filter(
    t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
};

/** Filter templates by their explicit planning cadence tag. */
export const filterTemplatesByPeriod = (
  templates: readonly BatchTemplate[],
  period: BatchTemplatePeriod
): BatchTemplate[] => {
  if (period === "all") return [...templates];
  return templates.filter(template => template.tags?.includes(period));
};

/** Mirrors the server batch-operation allowlist so the UI cannot offer a 501 action. */
export const isBatchTemplateRunnable = (template: BatchTemplate): boolean =>
  RUNNABLE_BATCH_TEMPLATE_OPERATION_TYPES.has(template.operationType);

/**
 * Get frequently used templates
 */
export const getFrequentTemplates = (limit: number = 3): BatchTemplate[] => {
  // In a real app, this would be based on usage history
  return BATCH_TEMPLATES.slice(0, limit);
};

export default BATCH_TEMPLATES;
