import { WebSocket } from 'ws';
import { getDb } from '../db';
import { batchOperations } from '../../drizzle/schema.postgres';
import { eq } from 'drizzle-orm';
import { batchQueueProcessor } from './batch-queue-processor.js';

interface ClientConnection {
  ws: WebSocket;
  jobId: string;
  userId: string;
  lastHeartbeat: number;
}

class BatchWebSocketHandler {
  private clients: Map<string, ClientConnection[]> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private updateCheckInFlight = false;

  constructor() {
    this.startHeartbeat();
    this.startUpdateCheck();
  }

  /**
   * Register a new WebSocket client for a batch operation
   */
  registerClient(jobId: string, userId: string, ws: WebSocket) {
    const key = `${jobId}:${userId}`;
    
    if (!this.clients.has(key)) {
      this.clients.set(key, []);
    }

    const client: ClientConnection = {
      ws,
      jobId,
      userId,
      lastHeartbeat: Date.now()
    };

    this.clients.get(key)!.push(client);

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as any;
        this.handleClientMessage(jobId, userId, message);
      } catch (err) {
        console.error('[BatchWebSocket] Failed to parse message:', err);
      }
    });

    // Handle client disconnect
    ws.on('close', () => {
      this.unregisterClient(jobId, userId, ws);
    });

    // Handle errors
    ws.on('error', (err: Error) => {
      console.error('[BatchWebSocket] Client error:', err);
      this.unregisterClient(jobId, userId, ws);
    });

    console.log(`[BatchWebSocket] Client registered for job ${jobId}`);
  }

  /**
   * Unregister a WebSocket client
   */
  private unregisterClient(jobId: string, userId: string, ws: WebSocket) {
    const key = `${jobId}:${userId}`;
    const clients = this.clients.get(key);

    if (clients) {
      const index = clients.findIndex(c => c.ws === ws);
      if (index !== -1) {
        clients.splice(index, 1);
      }

      if (clients.length === 0) {
        this.clients.delete(key);
      }
    }

    console.log(`[BatchWebSocket] Client unregistered for job ${jobId}`);
  }

  /**
   * Broadcast batch operation update to all connected clients
   */
  async broadcastUpdate(jobId: string, update: any) {
    const message = JSON.stringify(update);
    let broadcastCount = 0;

    this.clients.forEach((clients: ClientConnection[], key: string) => {
      if (key.startsWith(`${jobId}:`)) {
        for (const client of clients) {
          try {
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(message);
              broadcastCount++;
              client.lastHeartbeat = Date.now();
            }
          } catch (err) {
            console.error('[BatchWebSocket] Failed to send update:', err);
          }
        }
      }
    });

    if (broadcastCount > 0) {
      console.log(`[BatchWebSocket] Broadcasted update to ${broadcastCount} clients for job ${jobId}`);
    }
  }

  /**
   * Handle incoming client messages (e.g., pause, resume, cancel)
   */
  private handleClientMessage(jobId: string, userId: string, message: any) {
    const { action } = message;

    switch (action) {
      case 'ping':
        // Update heartbeat
        const key = `${jobId}:${userId}`;
        const clients = this.clients.get(key);
        if (clients) {
          clients.forEach(c => {
            c.lastHeartbeat = Date.now();
          });
        }
        break;

      case 'pause':
        console.log(`[BatchWebSocket] Pause requested for job ${jobId}`);
        void this.applyBatchAction(jobId, userId, 'pause');
        break;

      case 'resume':
        console.log(`[BatchWebSocket] Resume requested for job ${jobId}`);
        void this.applyBatchAction(jobId, userId, 'resume');
        break;

      case 'cancel':
        console.log(`[BatchWebSocket] Cancel requested for job ${jobId}`);
        void this.applyBatchAction(jobId, userId, 'cancel');
        break;

      default:
        console.warn(`[BatchWebSocket] Unknown action: ${action}`);
    }
  }

  /**
   * Apply a batch control action and send a small acknowledgement back to the caller.
   */
  private async applyBatchAction(
    jobId: string,
    userId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) {
    const key = `${jobId}:${userId}`;
    const clients = this.clients.get(key) || [];
    const ack = (payload: Record<string, any>) => {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'ack',
            action,
            jobId,
            ...payload,
          }));
        }
      }
    };

    try {
      switch (action) {
        case 'pause':
          await batchQueueProcessor.pauseJob(jobId);
          ack({ success: true, status: 'paused' });
          break;
        case 'resume':
          await batchQueueProcessor.resumeJob(jobId);
          ack({ success: true, status: 'running' });
          break;
        case 'cancel':
          await batchQueueProcessor.cancelJob(jobId);
          ack({ success: true, status: 'cancelled' });
          break;
      }
    } catch (error) {
      console.error(`[BatchWebSocket] Failed to ${action} job ${jobId}:`, error);
      ack({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start heartbeat to keep connections alive
   */
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 30000; // 30 seconds

      this.clients.forEach((clients: ClientConnection[]) => {
        const deadClients = clients.filter((c: ClientConnection) => now - c.lastHeartbeat > timeout);

        for (const client of deadClients) {
          try {
            client.ws.close(1000, 'Heartbeat timeout');
          } catch (err) {
            console.error('[BatchWebSocket] Failed to close connection:', err);
          }
        }

        // Send heartbeat to active clients
        const activeClients = clients.filter((c: ClientConnection) => now - c.lastHeartbeat <= timeout);
        for (const client of activeClients) {
          try {
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.ping();
            }
          } catch (err) {
            console.error('[BatchWebSocket] Failed to send heartbeat:', err);
          }
        }
      })
    }, 15000); // Check every 15 seconds
  }

  /**
   * Start periodic update check from database
   */
  private startUpdateCheck() {
    this.updateCheckInterval = setInterval(async () => {
      if (this.clients.size === 0 || this.updateCheckInFlight) return;
      this.updateCheckInFlight = true;
      try {
        const db = await getDb();
        if (!db) return;
        
        // Get all running batch operations
        const runningOps = await db
          .select()
          .from(batchOperations)
          .where(eq(batchOperations.status, 'running'));

        // Broadcast updates for each operation
        for (const op of runningOps) {
          const update = {
            jobId: op.id,
            progress: op.progress,
            status: op.status,
            completedTasks: op.completedTasks,
            failedTasks: op.failedTasks,
            currentTaskName: op.currentTaskName,
            currentTaskIndex: op.currentTaskIndex,
            elapsedTimeSeconds: op.elapsedTimeSeconds,
            estimatedTimeSeconds: op.estimatedTimeSeconds,
            errorLog: op.errorLog ? JSON.parse(op.errorLog as string) : []
          };

          await this.broadcastUpdate(op.id as string, update);
        }
      } catch (err) {
        console.error('[BatchWebSocket] Failed to check updates:', err);
      } finally {
        this.updateCheckInFlight = false;
      }
    }, 1000); // Check every second
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
    }

    // Close all client connections
    this.clients.forEach((clients: ClientConnection[]) => {
      for (const client of clients) {
        try {
          client.ws.close(1000, 'Server shutdown');
        } catch (err) {
          console.error('[BatchWebSocket] Failed to close connection:', err);
        }
      }
    });

    this.clients.clear();
  }

  /**
   * Get connection statistics
   */
  getStats() {
    let totalConnections = 0;
    let totalJobs = 0;

    this.clients.forEach((clients: ClientConnection[]) => {
      totalConnections += clients.length;
      totalJobs++;
    });

    return {
      totalConnections,
      totalJobs,
      clientGroups: this.clients.size
    };
  }
}

// Singleton instance
let instance: BatchWebSocketHandler | null = null;

export function getBatchWebSocketHandler(): BatchWebSocketHandler {
  if (!instance) {
    instance = new BatchWebSocketHandler();
  }
  return instance;
}

export function destroyBatchWebSocketHandler() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export default BatchWebSocketHandler;
