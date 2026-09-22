/**
 * Database helpers for ATIS Phases 3-10
 * Handles all database operations for advanced task analysis
 */

import { getDb } from '../db';
import {
  taskSubtasks,
  subtaskDependencies,
  criticalPathAnalysis,
  taskRisks,
  riskMitigations,
  taskResourceRequirements,
  taskTimeline,
  taskMilestones,
  taskQAStrategy,
  taskDocumentationRequirements,
  taskExternalDependencies,
  taskExecutionPlan,
  atisAnalysisSessions,
} from '../../drizzle/schema';
import { desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

/**
 * Phase 3: Task Decomposition
 */
export async function createSubtask(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskSubtasks).values({
    id,
    taskId,
    userId,
    title: data.title,
    description: data.description,
    estimatedHours: data.estimatedHours,
    sequence: data.sequence || 0,
    status: 'pending',
  });
  return id;
}

export async function getSubtasks(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskSubtasks).where(eq(taskSubtasks.taskId, taskId));
}

export async function createSubtaskDependency(subtaskId: string, dependsOnSubtaskId: string, dependencyType: string) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(subtaskDependencies).values({
    id,
    subtaskId,
    dependsOnSubtaskId,
    dependencyType: dependencyType as any,
  });
  return id;
}

export async function getSubtaskDependencies(subtaskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(subtaskDependencies).where(eq(subtaskDependencies.subtaskId, subtaskId));
}

export async function createCriticalPathAnalysis(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(criticalPathAnalysis).values({
    id,
    taskId,
    userId,
    criticalPath: JSON.stringify(data.criticalPath),
    totalDurationHours: data.totalDurationHours,
    parallelizationOpportunities: data.parallelizationOpportunities || 0,
    analysisData: JSON.stringify(data.analysisData),
  });
  return id;
}

export async function getCriticalPathAnalysis(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(criticalPathAnalysis).where(eq(criticalPathAnalysis.taskId, taskId));
}

/**
 * Phase 4: Risk Assessment
 */
export async function createRisk(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const priority = data.probability * data.impact;
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskRisks).values({
    id,
    taskId,
    userId,
    title: data.title,
    description: data.description,
    category: data.category as any,
    probability: data.probability,
    impact: data.impact,
    priority,
    status: 'identified',
  });
  return id;
}

export async function getRisks(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskRisks).where(eq(taskRisks.taskId, taskId));
}

export async function createRiskMitigation(riskId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(riskMitigations).values({
    id,
    riskId,
    strategy: data.strategy,
    effort: data.effort,
    owner: data.owner,
  });
  return id;
}

export async function getRiskMitigations(riskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(riskMitigations).where(eq(riskMitigations.riskId, riskId));
}

/**
 * Phase 5: Resource Estimation
 */
export async function createResourceRequirement(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskResourceRequirements).values({
    id,
    taskId,
    userId,
    resourceType: data.resourceType as any,
    resourceName: data.resourceName,
    proficiencyLevel: data.proficiencyLevel,
    estimatedCost: data.estimatedCost,
  });
  return id;
}

export async function getResourceRequirements(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskResourceRequirements).where(eq(taskResourceRequirements.taskId, taskId));
}

/**
 * Phase 6: Timeline Optimization
 */
export async function createTimeline(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskTimeline).values({
    id,
    taskId,
    userId,
    startDate: data.startDate,
    endDate: data.endDate,
    bufferDays: data.bufferDays || 0,
    totalDays: data.totalDays,
    optimizationData: JSON.stringify(data.optimizationData),
  });
  return id;
}

export async function getTimeline(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskTimeline).where(eq(taskTimeline.taskId, taskId));
}

export async function createMilestone(taskId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskMilestones).values({
    id,
    taskId,
    name: data.name,
    description: data.description,
    dueDate: data.dueDate,
    status: 'pending',
  });
  return id;
}

export async function getMilestones(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskMilestones).where(eq(taskMilestones.taskId, taskId));
}

/**
 * Phase 7: QA Strategy
 */
export async function createQAStrategy(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskQAStrategy).values({
    id,
    taskId,
    userId,
    strategy: data.strategy,
    testingPhases: JSON.stringify(data.testingPhases),
    qualityMetrics: JSON.stringify(data.qualityMetrics),
    acceptanceCriteria: JSON.stringify(data.acceptanceCriteria),
  });
  return id;
}

export async function getQAStrategy(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskQAStrategy).where(eq(taskQAStrategy.taskId, taskId));
}

/**
 * Phase 8: Documentation Requirements
 */
export async function createDocumentationRequirement(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskDocumentationRequirements).values({
    id,
    taskId,
    userId,
    docType: data.docType,
    audience: data.audience,
    estimatedEffort: data.estimatedEffort,
    contentOutline: JSON.stringify(data.contentOutline),
  });
  return id;
}

export async function getDocumentationRequirements(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskDocumentationRequirements).where(eq(taskDocumentationRequirements.taskId, taskId));
}

/**
 * Phase 9: External Dependencies
 */
export async function createExternalDependency(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskExternalDependencies).values({
    id,
    taskId,
    userId,
    dependencyType: data.dependencyType as any,
    description: data.description,
    owner: data.owner,
    dueDate: data.dueDate,
    status: 'pending',
  });
  return id;
}

export async function getExternalDependencies(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskExternalDependencies).where(eq(taskExternalDependencies.taskId, taskId));
}

/**
 * Phase 10: Execution Plan
 */
export async function createExecutionPlan(taskId: string, userId: string, data: any) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(taskExecutionPlan).values({
    id,
    taskId,
    userId,
    roadmap: JSON.stringify(data.roadmap),
    successMetrics: JSON.stringify(data.successMetrics),
    communicationPlan: data.communicationPlan,
    escalationPath: JSON.stringify(data.escalationPath),
    preExecutionChecklist: JSON.stringify(data.preExecutionChecklist),
    aptlssChecklist: JSON.stringify(data.aptlssChecklist),
    confidenceScore: data.confidenceScore,
  });
  return id;
}

export async function getExecutionPlan(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskExecutionPlan).where(eq(taskExecutionPlan.taskId, taskId));
}

/**
 * ATIS Analysis Session Management
 */
export async function createAnalysisSession(taskId: string, userId: string) {
  const id = uuidv4();
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(atisAnalysisSessions).values({
    id,
    taskId,
    userId,
    status: 'pending',
    currentPhase: 3,
    phasesCompleted: 0,
    sessionData: JSON.stringify({}),
  });
  return id;
}

export async function getAnalysisSession(id: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(atisAnalysisSessions).where(eq(atisAnalysisSessions.id, id));
}

export async function getAnalysisSessionByTask(taskId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select()
    .from(atisAnalysisSessions)
    .where(eq(atisAnalysisSessions.taskId, taskId))
    .orderBy(desc(atisAnalysisSessions.updatedAt));
}

export async function updateAnalysisSession(id: string, data: any) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(atisAnalysisSessions).set({
    status: data.status,
    currentPhase: data.currentPhase,
    phasesCompleted: data.phasesCompleted,
    sessionData: JSON.stringify(data.sessionData),
    completedAt: data.completedAt,
  }).where(eq(atisAnalysisSessions.id, id));
}

/**
 * Get all analysis data for a task
 */
export async function getAllAnalysisData(taskId: string) {
  const [subtasks, risks, resources, timeline, qa, docs, dependencies, executionPlan] = await Promise.all([
    getSubtasks(taskId),
    getRisks(taskId),
    getResourceRequirements(taskId),
    getTimeline(taskId),
    getQAStrategy(taskId),
    getDocumentationRequirements(taskId),
    getExternalDependencies(taskId),
    getExecutionPlan(taskId),
  ] as const);

  return {
    subtasks,
    risks,
    resources,
    timeline,
    qa,
    docs,
    dependencies,
    executionPlan,
  };
}
