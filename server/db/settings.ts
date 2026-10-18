import { getDb } from '../db';
import {
  conflictDetectionSettings,
  batchOperationSettings,
  keyboardShortcutsSettings,
  performanceMetricsSettings,
  settingsSyncLog,
  type ConflictDetectionSettings,
  type BatchOperationSettings,
  type KeyboardShortcutsSettings,
  type PerformanceMetricsSettings,
  type InsertConflictDetectionSettings,
  type InsertBatchOperationSettings,
  type InsertKeyboardShortcutsSettings,
  type InsertPerformanceMetricsSettings,
  type InsertSettingsSyncLog,
} from '../../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';

// ============================================
// CONFLICT DETECTION SETTINGS
// ============================================

export async function getConflictDetectionSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select()
    .from(conflictDetectionSettings)
    .where(and(eq(conflictDetectionSettings.userId, userId), eq(conflictDetectionSettings.userOpenId, userOpenId)))
    .limit(1);
  return result[0] || null;
}

export async function saveConflictDetectionSettings(
  userId: number,
  userOpenId: string,
  data: Omit<InsertConflictDetectionSettings, 'userId' | 'userOpenId'>,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getConflictDetectionSettings(userId, userOpenId);

  if (existing) {
    // Update existing
    const updated = await db
      .update(conflictDetectionSettings)
      .set({
        ...data,
        version: existing.version + 1,
        lastModified: new Date(),
      })
      .where(eq(conflictDetectionSettings.id, existing.id));

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'conflict_detection', 'update', existing.version, existing.version + 1);

    return updated;
  } else {
    // Create new
    const created = await db.insert(conflictDetectionSettings).values({
      userId,
      userOpenId,
      ...data,
      version: 1,
    });

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'conflict_detection', 'create', undefined, 1);

    return created;
  }
}

export async function resetConflictDetectionSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getConflictDetectionSettings(userId, userOpenId);

  if (existing) {
    await db.delete(conflictDetectionSettings).where(eq(conflictDetectionSettings.id, existing.id));
    await logSettingsSync(userId, userOpenId, 'conflict_detection', 'delete', existing.version, undefined);
  }
}

// ============================================
// BATCH OPERATION SETTINGS
// ============================================

export async function getBatchOperationSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db
    .select()
    .from(batchOperationSettings)
    .where(and(eq(batchOperationSettings.userId, userId), eq(batchOperationSettings.userOpenId, userOpenId)))
    .limit(1);
  return result[0] || null;
}

export async function saveBatchOperationSettings(
  userId: number,
  userOpenId: string,
  data: Omit<InsertBatchOperationSettings, 'userId' | 'userOpenId'>,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getBatchOperationSettings(userId, userOpenId);

  if (existing) {
    // Update existing
    const updated = await db
      .update(batchOperationSettings)
      .set({
        ...data,
        version: existing.version + 1,
        lastModified: new Date(),
      })
      .where(eq(batchOperationSettings.id, existing.id));

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'batch_operation', 'update', existing.version, existing.version + 1);

    return updated;
  } else {
    // Create new
    const created = await db.insert(batchOperationSettings).values({
      userId,
      userOpenId,
      ...data,
      version: 1,
    });

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'batch_operation', 'create', undefined, 1);

    return created;
  }
}

export async function resetBatchOperationSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getBatchOperationSettings(userId, userOpenId);

  if (existing) {
    await db.delete(batchOperationSettings).where(eq(batchOperationSettings.id, existing.id));
    await logSettingsSync(userId, userOpenId, 'batch_operation', 'delete', existing.version, undefined);
  }
}

// ============================================
// KEYBOARD SHORTCUTS SETTINGS
// ============================================

export async function getKeyboardShortcutsSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db
    .select()
    .from(keyboardShortcutsSettings)
    .where(and(eq(keyboardShortcutsSettings.userId, userId), eq(keyboardShortcutsSettings.userOpenId, userOpenId)))
    .limit(1);
  return result[0] || null;
}

export async function saveKeyboardShortcutsSettings(
  userId: number,
  userOpenId: string,
  shortcuts: any[],
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getKeyboardShortcutsSettings(userId, userOpenId);

  const data: Omit<InsertKeyboardShortcutsSettings, 'userId' | 'userOpenId'> = {
    shortcuts: JSON.stringify(shortcuts),
  };

  if (existing) {
    // Update existing
    const updated = await db
      .update(keyboardShortcutsSettings)
      .set({
        ...data,
        version: existing.version + 1,
        lastModified: new Date(),
      })
      .where(eq(keyboardShortcutsSettings.id, existing.id));

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'keyboard_shortcuts', 'update', existing.version, existing.version + 1);

    return updated;
  } else {
    // Create new
    const created = await db.insert(keyboardShortcutsSettings).values({
      userId,
      userOpenId,
      ...data,
      version: 1,
    });

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'keyboard_shortcuts', 'create', undefined, 1);

    return created;
  }
}

export async function resetKeyboardShortcutsSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getKeyboardShortcutsSettings(userId, userOpenId);

  if (existing) {
    await db.delete(keyboardShortcutsSettings).where(eq(keyboardShortcutsSettings.id, existing.id));
    await logSettingsSync(userId, userOpenId, 'keyboard_shortcuts', 'delete', existing.version, undefined);
  }
}

// ============================================
// PERFORMANCE METRICS SETTINGS
// ============================================

export async function getPerformanceMetricsSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db
    .select()
    .from(performanceMetricsSettings)
    .where(and(eq(performanceMetricsSettings.userId, userId), eq(performanceMetricsSettings.userOpenId, userOpenId)))
    .limit(1);
  return result[0] || null;
}

export async function savePerformanceMetricsSettings(
  userId: number,
  userOpenId: string,
  data: Omit<InsertPerformanceMetricsSettings, 'userId' | 'userOpenId'>,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getPerformanceMetricsSettings(userId, userOpenId);

  if (existing) {
    // Update existing
    const updated = await db
      .update(performanceMetricsSettings)
      .set({
        ...data,
        version: existing.version + 1,
        lastModified: new Date(),
      })
      .where(eq(performanceMetricsSettings.id, existing.id));

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'performance_metrics', 'update', existing.version, existing.version + 1);

    return updated;
  } else {
    // Create new
    const created = await db.insert(performanceMetricsSettings).values({
      userId,
      userOpenId,
      ...data,
      version: 1,
    });

    // Log the sync
    await logSettingsSync(userId, userOpenId, 'performance_metrics', 'create', undefined, 1);

    return created;
  }
}

export async function resetPerformanceMetricsSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const existing = await getPerformanceMetricsSettings(userId, userOpenId);

  if (existing) {
    await db.delete(performanceMetricsSettings).where(eq(performanceMetricsSettings.id, existing.id));
    await logSettingsSync(userId, userOpenId, 'performance_metrics', 'delete', existing.version, undefined);
  }
}

// ============================================
// SETTINGS SYNC LOG
// ============================================

export async function logSettingsSync(
  userId: number,
  userOpenId: string,
  settingsType: string,
  action: 'create' | 'update' | 'delete',
  previousVersion?: number,
  newVersion?: number,
  deviceId?: string,
  clientVersion?: string,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(settingsSyncLog).values({
    userId,
    userOpenId,
    settingsType,
    action,
    previousVersion,
    newVersion,
    deviceId,
    clientVersion,
    hadConflict: 0,
  });
}

// ============================================
// BULK OPERATIONS
// ============================================

export async function getAllSettings(userId: number, userOpenId: string) {
  return {
    conflictDetection: await getConflictDetectionSettings(userId, userOpenId),
    batchOperation: await getBatchOperationSettings(userId, userOpenId),
    keyboardShortcuts: await getKeyboardShortcutsSettings(userId, userOpenId),
    performanceMetrics: await getPerformanceMetricsSettings(userId, userOpenId),
  };
}

export async function resetAllSettings(userId: number, userOpenId: string) {
  await Promise.all([
    resetConflictDetectionSettings(userId, userOpenId),
    resetBatchOperationSettings(userId, userOpenId),
    resetKeyboardShortcutsSettings(userId, userOpenId),
    resetPerformanceMetricsSettings(userId, userOpenId),
  ]);
}

// ============================================
// SYNC HELPERS
// ============================================

export async function getSyncLog(userId: number, userOpenId: string, limit = 100) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return await db
    .select()
    .from(settingsSyncLog)
    .where(and(eq(settingsSyncLog.userId, userId), eq(settingsSyncLog.userOpenId, userOpenId)))
    .orderBy((t: any) => t.createdAt)
    .limit(limit);
}

export async function checkForConflicts(
  userId: number,
  userOpenId: string,
  settingsType: string,
  clientVersion: number,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get the latest sync log entry for this settings type
  const latest = await db
    .select()
    .from(settingsSyncLog)
    .where(
      and(
        eq(settingsSyncLog.userId, userId),
        eq(settingsSyncLog.userOpenId, userOpenId),
        eq(settingsSyncLog.settingsType, settingsType),
      ),
    )
    .orderBy((t: any) => t.createdAt)
    .limit(1);

  if (!latest.length) return false;

  // If client version is older than server version, there's a conflict
  const serverVersion = latest[0].newVersion || 1;
  return clientVersion < serverVersion;
}
