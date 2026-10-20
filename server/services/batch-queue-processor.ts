/**
 * Batch Queue Processor Service
 * 
 * Handles processing of batch operations (re-analyze, reschedule, conflict resolution)
 * with real-time progress updates via WebSocket.
 * 
 * Features:
 * - Queue-based processing with concurrency control
 * - Real-time progress streaming via WebSocket
 * - Error handling and retry logic
 * - Task result aggregation
 * - Automatic cleanup of completed jobs
 */

import { EventEmitter } from 'events';
import * as schedulingDb from '../db/scheduling.js';
import { websocketService } from './websocket.js';
import { invokeLLM } from '../_core/llm.js';
import { resolveBatchSchedule } from '../schedulingApi.js';

export function calculateBatchProgress(completedTasks: number, failedTasks: number, totalTasks: number): number {
  if (totalTasks <= 0) return 0;
  const processed = Math.max(0, completedTasks) + Math.max(0, failedTasks);
  return Math.min(100, Math.round((processed / totalTasks) * 100));
}

export function calculateBatchTerminalStatus(
  completedTasks: number,
  failedTasks: number,
  totalTasks: number,
): 'completed' | 'failed' {
  return totalTasks > 0 && completedTasks === 0 && failedTasks >= totalTasks
    ? 'failed'
    : 'completed';
}

export function estimateBatchDuration(
  elapsedSeconds: number,
  completedTasks: number,
  failedTasks: number,
  totalTasks: number,
): number | undefined {
  const processed = Math.max(0, completedTasks) + Math.max(0, failedTasks);
  if (processed <= 0 || totalTasks <= 0) return undefined;

  const averageTaskSeconds = Math.max(1, elapsedSeconds) / processed;
  return Math.max(1, Math.round(averageTaskSeconds * totalTasks));
}

interface QueuedJob {
  jobId: string;
  userId: string;
  operationType: 're_analyze' | 'reschedule' | 'conflict_resolution' | 'optimization';
  taskIds: string[];
  parameters?: Record<string, any>;
  createdAt: Date;
}

interface JobProgress {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  currentTaskIndex: number;
  currentTaskName?: string;
  completedTasks: number;
  failedTasks: number;
  totalTasks: number;
  elapsedSeconds: number;
  estimatedTimeSeconds?: number;
  results?: Record<string, any>;
  errorLog?: string[];
  startedAt?: Date;
  completedAt?: Date;
  isPaused?: boolean;
  pausedAt?: Date;
}

class BatchQueueProcessor extends EventEmitter {
  private queue: QueuedJob[] = [];
  private activeJobs: Map<string, QueuedJob> = new Map();
  private jobProgress: Map<string, JobProgress> = new Map();
  private maxConcurrentJobs = 3;
  private isProcessing = false;
  private jobStartTimes: Map<string, number> = new Map();
  private cancelledJobs: Set<string> = new Set();
  private pausedJobs: Set<string> = new Set();

  private getJobOwner(jobId: string): string | undefined {
    return this.activeJobs.get(jobId)?.userId ?? this.queue.find(job => job.jobId === jobId)?.userId;
  }

  constructor() {
    super();
  }

  /**
   * Add a job to the queue
   */
  public async enqueueJob(
    jobId: string,
    userId: string,
    operationType: 're_analyze' | 'reschedule' | 'conflict_resolution' | 'optimization',
    taskIds: string[],
    parameters?: Record<string, any>
  ): Promise<void> {
    const job: QueuedJob = {
      jobId,
      userId,
      operationType,
      taskIds,
      parameters,
      createdAt: new Date()
    };

    this.queue.push(job);
    this.initializeJobProgress(jobId, taskIds.length);
    void this.persistProgress(jobId);
    void this.processQueue();
  }

  /**
   * Initialize job progress tracking
   */
  private initializeJobProgress(jobId: string, totalTasks: number): void {
    this.jobProgress.set(jobId, {
      jobId,
      status: 'pending',
      progress: 0,
      currentTaskIndex: 0,
      completedTasks: 0,
      failedTasks: 0,
      totalTasks,
      elapsedSeconds: 0,
      isPaused: false,
      errorLog: []
    });
  }

  /**
   * Get job progress
   */
  public getJobProgress(jobId: string): JobProgress | undefined {
    return this.jobProgress.get(jobId);
  }

  /**
   * Pause a job between task boundaries.
   */
  public async pauseJob(jobId: string): Promise<void> {
    const progress = this.jobProgress.get(jobId);
    if (!progress || progress.status !== 'running') return;

    this.pausedJobs.add(jobId);
    progress.isPaused = true;
    progress.pausedAt = new Date();
    await this.persistProgress(jobId, progress);
    const owner = this.getJobOwner(jobId);
    if (owner) websocketService.emitToUser(owner, 'batch:paused', {
      ...progress,
      jobId,
    });
  }

  /**
   * Resume a paused job.
   */
  public async resumeJob(jobId: string): Promise<void> {
    const progress = this.jobProgress.get(jobId);
    if (!progress || !this.pausedJobs.has(jobId)) return;

    this.pausedJobs.delete(jobId);
    progress.isPaused = false;
    progress.pausedAt = undefined;
    await this.persistProgress(jobId, progress);
    const owner = this.getJobOwner(jobId);
    if (owner) websocketService.emitToUser(owner, 'batch:resumed', {
      ...progress,
      jobId,
    });
  }



  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.activeJobs.size >= this.maxConcurrentJobs) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0 && this.activeJobs.size < this.maxConcurrentJobs) {
      const job = this.queue.shift();
      if (!job) break;

      this.activeJobs.set(job.jobId, job);
      this.jobStartTimes.set(job.jobId, Date.now());

      // Process job asynchronously
      this.processJob(job).catch((error: Error) => {
        console.error(`[Batch] Error processing job ${job.jobId}:`, error);
        const progress = this.jobProgress.get(job.jobId);
        if (progress) {
          progress.status = 'failed';
          progress.errorLog?.push(error.message);
          void this.persistProgress(job.jobId, progress);
        }
      }).finally(() => {
        this.activeJobs.delete(job.jobId);
        this.processQueue();
      });
    }

    this.isProcessing = false;
  }

  /**
   * Process a single job
   */
  private async processJob(job: QueuedJob): Promise<void> {
    const progress = this.jobProgress.get(job.jobId);
    if (!progress) return;

    progress.status = 'running';
    progress.isPaused = false;
    progress.startedAt = new Date();
    await this.persistProgress(job.jobId, progress);

    try {
      for (let i = 0; i < job.taskIds.length; i++) {
        if (this.cancelledJobs.has(job.jobId)) {
          progress.status = 'cancelled';
          break;
        }

        while (this.pausedJobs.has(job.jobId)) {
          progress.isPaused = true;
          await this.persistProgress(job.jobId, progress);
          await new Promise(resolve => setTimeout(resolve, 500));

          if (this.cancelledJobs.has(job.jobId)) {
            progress.status = 'cancelled';
            break;
          }
        }

        if (progress.status === 'cancelled') {
          break;
        }

        progress.isPaused = false;

        const taskId = job.taskIds[i];
        progress.currentTaskIndex = i + 1;
        progress.currentTaskName = `Task ${i + 1}/${job.taskIds.length}`;

        try {
          let result: Record<string, any> | undefined;
          // Process based on operation type
          switch (job.operationType) {
            case 're_analyze':
              result = await this.reAnalyzeTask(taskId, job.parameters);
              break;
            case 'reschedule':
              result = await this.rescheduleTask(taskId, job.userId, job.parameters);
              break;
            case 'conflict_resolution':
            case 'optimization':
              throw new Error(`${job.operationType} is not implemented`);
          }

          progress.completedTasks++;
          if (result) {
            progress.results = {
              ...(progress.results || {}),
              [taskId]: result,
            };
          }
        } catch (error) {
          progress.failedTasks++;
          progress.errorLog?.push(`Task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Update progress percentage
        progress.progress = calculateBatchProgress(
          progress.completedTasks,
          progress.failedTasks,
          progress.totalTasks,
        );

        // Update elapsed time
        const startTime = this.jobStartTimes.get(job.jobId);
        if (startTime) {
          progress.elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
        }
        progress.estimatedTimeSeconds = estimateBatchDuration(
          progress.elapsedSeconds,
          progress.completedTasks,
          progress.failedTasks,
          progress.totalTasks,
        );

        // Emit progress update
        this.emit('progress', progress);
        websocketService.emitToUser(job.userId, 'batch:progress', {
          ...progress,
          jobId: job.jobId,
        });
        await this.persistProgress(job.jobId, progress);
      }

      if (progress.status !== 'cancelled') {
        progress.status = calculateBatchTerminalStatus(
          progress.completedTasks,
          progress.failedTasks,
          progress.totalTasks,
        );
      }
    } catch (error) {
      progress.status = 'failed';
      progress.errorLog?.push(error instanceof Error ? error.message : String(error));
    }

      // Emit final progress
      this.emit('complete', progress);
      const finalEvent =
        progress.status === 'cancelled'
          ? 'batch:cancelled'
          : progress.status === 'failed'
            ? 'batch:failed'
            : 'batch:complete';

      websocketService.emitToUser(job.userId, finalEvent, {
        ...progress,
        jobId: job.jobId,
      });
      await this.persistProgress(job.jobId, progress);
  }

  /**
   * Re-analyze a task using LLM
   */
  private async reAnalyzeTask(taskId: string, parameters?: Record<string, any>): Promise<Record<string, any>> {
    try {
      // Prepare task context for LLM
      const taskContext = `Task ID: ${taskId}\nParameters: ${JSON.stringify(parameters || {})}`;

      // Call LLM for re-analysis
      const response = await invokeLLM({
        messages: [
          {
            role: 'system',
            content: 'You are a task analysis expert. Analyze the task and provide insights on decomposition, risks, resources, timeline, and quality metrics.'
          },
          {
            role: 'user',
            content: `Analyze: ${taskContext}`
          }
        ]
      });

      // Parse LLM response
      const content = response.choices[0].message.content;
      const analysis = typeof content === 'string' ? JSON.parse(content) : content;

      return {
        taskId,
        analyzed: true,
        timestamp: new Date().toISOString(),
        analysis: analysis
      };
    } catch (error) {
      console.error(`[Batch] Error re-analyzing task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Reschedule a task
   */
  private async rescheduleTask(
    taskId: string,
    userOpenId: string,
    parameters?: Record<string, any>,
  ): Promise<Record<string, any>> {
    try {
      const schedule = resolveBatchSchedule(parameters, taskId);
      if (!schedule) {
        throw new Error('A valid start/end time or preferredDate/duration is required');
      }
      const actor = await schedulingDb.getScheduleActorByOpenId(userOpenId);
      if (!actor) throw new Error('Batch operation owner not found');
      const result = await schedulingDb.rescheduleTaskForActor(
        actor,
        taskId,
        schedule.startTime,
        schedule.endTime,
        { reason: 'Batch reschedule', source: 'batch' },
      );
      if (!result) throw new Error('Task assignment not found or not owned by this user');

      return {
        taskId,
        rescheduled: true,
        historyId: result.historyId,
        previousStartTime: result.previousStartTime,
        previousEndTime: result.previousEndTime,
        newStartTime: result.newStartTime,
        newEndTime: result.newEndTime,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error(`[Batch] Error rescheduling task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel a job
   */
  public async cancelJob(jobId: string): Promise<void> {
    const progress = this.jobProgress.get(jobId);
    if (progress) {
      progress.status = 'cancelled';
      progress.isPaused = false;
      this.cancelledJobs.add(jobId);
      this.pausedJobs.delete(jobId);
      this.emit('cancelled', progress);
      const owner = this.getJobOwner(jobId);
      if (owner) websocketService.emitToUser(owner, 'batch:cancelled', {
        ...progress,
        jobId,
      });
      await this.persistProgress(jobId, progress);
    }
  }

  /**
   * Persist job progress to the database
   */
  private async persistProgress(jobId: string, progress?: JobProgress): Promise<void> {
    const currentProgress = progress ?? this.jobProgress.get(jobId);
    if (!currentProgress) return;

    try {
      await schedulingDb.updateBatchOperation(jobId, {
        status: currentProgress.status,
        progress: currentProgress.progress,
        completedTasks: currentProgress.completedTasks,
        failedTasks: currentProgress.failedTasks,
        currentTaskIndex: currentProgress.currentTaskIndex,
        currentTaskName: currentProgress.currentTaskName,
        results: currentProgress.results,
        errorLog: currentProgress.errorLog,
        startedAt: this.jobStartTimes.has(jobId) ? new Date(this.jobStartTimes.get(jobId)!) : undefined,
        completedAt: currentProgress.status === 'completed' || currentProgress.status === 'failed' || currentProgress.status === 'cancelled'
          ? new Date()
          : undefined,
        elapsedTimeSeconds: currentProgress.elapsedSeconds,
        estimatedTimeSeconds: currentProgress.estimatedTimeSeconds,
      });
    } catch (error) {
      console.error(`[Batch] Failed to persist progress for job ${jobId}:`, error);
    }
  }
}

// Export singleton instance
export const batchQueueProcessor = new BatchQueueProcessor();
