import { getDb } from '../db';
import { timeEntries } from '../../drizzle/schema.postgres';
import { eq } from 'drizzle-orm';

// Mocked learning engine functions for now
export async function trackEstimationAccuracy(taskId: string, actualDuration: number, estimatedDuration: number) {
  console.log(`Tracking estimation accuracy for task ${taskId}: Actual=${actualDuration}, Estimated=${estimatedDuration}`);
  // In the future: write to an analytics table
}

export async function calculateCalibrationFactor(taskType?: string): Promise<number> {
  // Always return 1.0 until enough data is collected
  return 1.0;
}

export async function applyCalibration(estimatedMinutes: number, taskType?: string): Promise<number> {
  const factor = await calculateCalibrationFactor(taskType);
  return Math.round(estimatedMinutes * factor);
}
