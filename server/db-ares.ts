import { getDb } from './db';
import { 
  aresConfigurations, 
  aresValidationRules, 
  aresValidationHistory,
  InsertAresConfiguration,
  InsertAresValidationRule,
  InsertAresValidationHistory,
  AresConfiguration,
  AresValidationRule,
  AresValidationHistoryRecord
} from '../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';

const getDatabase = async () => {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db;
};

/**
 * ARES Database Operations
 * Handles CRUD operations for ARES configurations, validation rules, and history
 */

// ─── Configuration Operations ────────────────────────────────────────────────

export async function createAresConfiguration(
  config: InsertAresConfiguration
): Promise<AresConfiguration> {
  const db = await getDatabase();
  const result = await db.insert(aresConfigurations).values(config);
  const inserted = await db.query.aresConfigurations.findFirst({
    where: eq(aresConfigurations.id, config.id),
  });
  if (!inserted) throw new Error('Failed to create ARES configuration');
  return inserted;
}

export async function getAresConfiguration(
  configId: string
): Promise<AresConfiguration | null> {
  const db = await getDatabase();
  return (await db.query.aresConfigurations.findFirst({
    where: eq(aresConfigurations.id, configId),
  })) ?? null;
}

export async function getUserAresConfigurations(
  userId: number
): Promise<AresConfiguration[]> {
  const db = await getDatabase();
  return db.query.aresConfigurations.findMany({
    where: eq(aresConfigurations.userId, userId),
  });
}

export async function getDefaultAresConfiguration(
  userId: number
): Promise<AresConfiguration | null> {
  const db = await getDatabase();
  return (await db.query.aresConfigurations.findFirst({
    where: and(
      eq(aresConfigurations.userId, userId),
      eq(aresConfigurations.isDefault, true)
    ),
  })) ?? null;
}

export async function updateAresConfiguration(
  configId: string,
  updates: Partial<InsertAresConfiguration>
): Promise<AresConfiguration> {
  const db = await getDatabase();
  await db.update(aresConfigurations)
    .set(updates)
    .where(eq(aresConfigurations.id, configId));
  
  const updated = await db.query.aresConfigurations.findFirst({
    where: eq(aresConfigurations.id, configId),
  });
  if (!updated) throw new Error('Failed to update ARES configuration');
  return updated;
}

export async function deleteAresConfiguration(configId: string): Promise<void> {
  const db = await getDatabase();
  // Delete associated rules and history first
  await db.delete(aresValidationRules)
    .where(eq(aresValidationRules.configId, configId));
  
  await db.delete(aresValidationHistory)
    .where(eq(aresValidationHistory.configId, configId));
  
  await db.delete(aresConfigurations)
    .where(eq(aresConfigurations.id, configId));
}

export async function setDefaultAresConfiguration(
  userId: number,
  configId: string
): Promise<void> {
  // Unset all other defaults for this user
  const allConfigs = await getUserAresConfigurations(userId);
  for (const config of allConfigs) {
    if (config.id !== configId && config.isDefault) {
      await updateAresConfiguration(config.id, { isDefault: false });
    }
  }
  
  // Set the new default
  await updateAresConfiguration(configId, { isDefault: true });
}

// ─── Validation Rule Operations ──────────────────────────────────────────────

export async function createAresValidationRule(
  rule: InsertAresValidationRule
): Promise<AresValidationRule> {
  const db = await getDatabase();
  const result = await db.insert(aresValidationRules).values(rule);
  const inserted = await db.query.aresValidationRules.findFirst({
    where: eq(aresValidationRules.id, rule.id),
  });
  if (!inserted) throw new Error('Failed to create ARES validation rule');
  return inserted;
}

export async function getAresValidationRules(
  configId: string
): Promise<AresValidationRule[]> {
  const db = await getDatabase();
  return db.query.aresValidationRules.findMany({
    where: eq(aresValidationRules.configId, configId),
  });
}

export async function getAresValidationRule(
  ruleId: string
): Promise<AresValidationRule | null> {
  const db = await getDatabase();
  return ((await db.query.aresValidationRules.findFirst({
    where: eq(aresValidationRules.id, ruleId),
  })) ?? null) as AresValidationRule | null;
}

export async function updateAresValidationRule(
  ruleId: string,
  updates: Partial<InsertAresValidationRule>
): Promise<AresValidationRule> {
  const db = await getDatabase();
  await db.update(aresValidationRules)
    .set(updates)
    .where(eq(aresValidationRules.id, ruleId));
  
  const updated = await db.query.aresValidationRules.findFirst({
    where: eq(aresValidationRules.id, ruleId),
  });
  if (!updated) throw new Error('Failed to update ARES validation rule');
  return updated;
}

export async function deleteAresValidationRule(ruleId: string): Promise<void> {
  const db = await getDatabase();
  await db.delete(aresValidationRules)
    .where(eq(aresValidationRules.id, ruleId));
}

// ─── Validation History Operations ──────────────────────────────────────────

export async function recordAresValidation(
  record: InsertAresValidationHistory
): Promise<AresValidationHistoryRecord> {
  const db = await getDatabase();
  const result = await db.insert(aresValidationHistory).values(record);
  const inserted = await db.query.aresValidationHistory.findFirst({
    where: eq(aresValidationHistory.id, record.id),
  });
  if (!inserted) throw new Error('Failed to record ARES validation');
  return inserted;
}

export async function getAresValidationHistory(
  configId: string,
  limit: number = 50,
  offset: number = 0
): Promise<AresValidationHistoryRecord[]> {
  const db = await getDatabase();
  return db.query.aresValidationHistory.findMany({
    where: eq(aresValidationHistory.configId, configId),
    limit,
    offset,
  });
}

export async function getCardValidationHistory(
  cardId: string
): Promise<AresValidationHistoryRecord[]> {
  const db = await getDatabase();
  return db.query.aresValidationHistory.findMany({
    where: eq(aresValidationHistory.cardId, cardId),
  });
}

export async function getValidationStats(configId: string): Promise<{
  totalValidations: number;
  passedValidations: number;
  failedValidations: number;
  passRate: number;
  averageConfidence: number;
}> {
  const history = await getAresValidationHistory(configId, 1000, 0);
  
  const totalValidations = history.length;
  const passedValidations = history.filter((h: any) => h.passed).length;
  const failedValidations = totalValidations - passedValidations;
  const passRate = totalValidations > 0 ? (passedValidations / totalValidations) * 100 : 0;
  const averageConfidence = totalValidations > 0 
    ? history.reduce((sum: number, h: any) => sum + h.confidenceScore, 0) / totalValidations 
    : 0;
  
  return {
    totalValidations,
    passedValidations,
    failedValidations,
    passRate,
    averageConfidence,
  };
}
