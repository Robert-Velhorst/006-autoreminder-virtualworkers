import type { Request } from "express";
import type { Server as HTTPServer } from "http";
import { and, eq, or } from "drizzle-orm";
import { Server as SocketIOServer, type Namespace, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { atisAnalysisSessions, type User } from "../../drizzle/schema.postgres";
import { sdk } from "../_core/sdk";
import { getDb } from "../db";
import { getRedisPubClient, getRedisSubClient, isRedisAvailable } from "./redis";

type SocketUser = Pick<User, "id" | "openId" | "name" | "role">;
type SocketAuthenticator = (socket: Socket) => Promise<SocketUser>;
type SessionAuthorizer = (user: SocketUser, sessionId: string) => Promise<boolean>;

const GUARDED_DELIVERY_EVENT = 'guarded-delivery:v1';
const DELIVERY_NAMESPACE = '/_guarded-delivery';
type GuardedDelivery = {
  target: 'user' | 'session' | 'all';
  targetId?: string;
  event: string;
  data: unknown;
  excludeSocketId?: string;
};

export interface WebSocketServiceOptions {
  authenticate?: SocketAuthenticator;
  authorizeSession?: SessionAuthorizer;
  allowedOrigins?: string[];
}

interface ConnectedClient {
  socket: Socket;
  user: SocketUser;
  connectedAt: Date;
}

function configuredOrigins() {
  const directOrigins = [
    process.env.PUBLIC_URL,
    process.env.TRELLO_WEBHOOK_CALLBACK_URL,
    process.env.APP_URL,
    process.env.VITE_FRONTEND_URL,
  ].filter((value): value is string => Boolean(value?.trim()));
  const localOrigins = (process.env.LOCAL_ACCESS_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return [...directOrigins, ...localOrigins];
}

export function isAllowedWebSocketOrigin(origin: string | undefined, allowedOrigins = configuredOrigins()) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return allowedOrigins.some(candidate => {
      try {
        return new URL(candidate).origin === url.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function authenticateSocket(socket: Socket): Promise<SocketUser> {
  return sdk.authenticateRequest(socket.request as unknown as Request);
}

async function authorizeATISSession(user: SocketUser, sessionId: string) {
  if (user.role === "admin") return true;

  const db = await getDb();
  if (!db) return false;

  const [session] = await db
    .select({ id: atisAnalysisSessions.id })
    .from(atisAnalysisSessions)
    .where(and(
      eq(atisAnalysisSessions.id, sessionId),
      or(
        eq(atisAnalysisSessions.userId, String(user.id)),
        eq(atisAnalysisSessions.userId, user.openId),
      ),
    ))
    .limit(1);

  return Boolean(session);
}

export class WebSocketService {
  private io: SocketIOServer | null = null;
  private clients = new Map<string, ConnectedClient>();
  private readonly authenticate: SocketAuthenticator;
  private readonly authorizeSession: SessionAuthorizer;
  private readonly allowedOrigins: string[];
  private deliveryNamespace: Namespace | null = null;

  constructor(options: WebSocketServiceOptions = {}) {
    this.authenticate = options.authenticate ?? authenticateSocket;
    this.authorizeSession = options.authorizeSession ?? authorizeATISSession;
    this.allowedOrigins = options.allowedOrigins ?? configuredOrigins();
  }

  getIO(): SocketIOServer | null {
    return this.io;
  }

  initialize(httpServer: HTTPServer): void {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (isAllowedWebSocketOrigin(origin, this.allowedOrigins)) callback(null, true);
          else callback(new Error("Origin not allowed"));
        },
        methods: ["GET", "POST"],
        credentials: true,
      },
      path: "/ws",
    });

    this.io.use(async (socket, next) => {
      try {
        const user = await this.authenticate(socket);
        socket.data.user = Object.freeze({ id: user.id, openId: user.openId, name: user.name, role: user.role });
        next();
      } catch {
        next(new Error("Authentication required"));
      }
    });

    const pubClient = getRedisPubClient();
    const subClient = getRedisSubClient();
    if (pubClient && subClient) {
      // The adapter does not await publish(). Keep application events local
      // during an outage and handle disconnect races without an unhandled rejection.
      const adapterPublisher = new Proxy(pubClient, {
        get(target, property) {
          if (property === "publish") return (channel: string, message: string | Buffer) => {
            if (target.status !== "ready") return Promise.resolve(0);
            return target.publish(channel, message).catch(() => {
              console.warn("[WebSocket] Redis publication unavailable; local delivery retained");
              return 0;
            });
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      // Keep Redis off the client namespace entirely: raw adapter broadcasts
      // (including legacy nodes) must never deliver to unchecked recipients.
      this.deliveryNamespace = this.io.of(DELIVERY_NAMESPACE);
      this.deliveryNamespace.use((_socket, next) => next(new Error('Server-only namespace')));
      this.deliveryNamespace.adapter = createAdapter(adapterPublisher, subClient)(this.deliveryNamespace);
      console.log("[WebSocket] Guarded Redis delivery configured");
    }
    if (!isRedisAvailable()) {
      console.log("[WebSocket] Redis not ready - cross-instance delivery unavailable");
    }

    // Redis distributes only a server-side envelope. The receiving node must
    // authorize each local recipient; adapter room broadcasts bypass that check.
    this.deliveryNamespace?.on(GUARDED_DELIVERY_EVENT, (delivery: GuardedDelivery) => {
      if (!delivery || !['user', 'session', 'all'].includes(delivery.target)
        || typeof delivery.event !== 'string'
        || (delivery.target !== 'all' && typeof delivery.targetId !== 'string')) return;
      this.deliverLocally(delivery);
    });

    this.io.on("connection", socket => {
      const user = socket.data.user as SocketUser;
      this.clients.set(socket.id, { socket, user, connectedAt: new Date() });
      void socket.join(this.userRoom(user.openId));

      socket.emit("authenticated", {
        success: true,
        connectedClients: this.getConnectedClientsCount(),
      });

      socket.use((_packet, next) => {
        void this.reauthenticate(this.clients.get(socket.id)).then(valid => {
          if (valid) next();
        }).catch(() => socket.disconnect(true));
      });

      socket.on("join-session", async (sessionId: unknown) => {
        if (typeof sessionId !== "string" || !sessionId.trim()) return;

        try {
          if (!(await this.authorizeSession(user, sessionId))) {
            if (await this.reauthenticate(this.clients.get(socket.id))) {
              socket.emit("session-error", { sessionId, error: "Session access denied" });
            }
            return;
          }

          if (!(await this.reauthenticate(this.clients.get(socket.id)))) return;
          await socket.join(this.sessionRoom(sessionId));
          if (await this.reauthenticate(this.clients.get(socket.id))) {
            socket.emit("session-joined", { sessionId, socketId: socket.id });
          }
        } catch {
          if (await this.reauthenticate(this.clients.get(socket.id))) {
            socket.emit("session-error", { sessionId, error: "Unable to verify session access" });
          }
        }
      });

      socket.on("leave-session", (sessionId: unknown) => {
        if (typeof sessionId === "string" && sessionId.trim()) {
          void socket.leave(this.sessionRoom(sessionId));
        }
      });

      socket.on("disconnect", () => this.clients.delete(socket.id));
      socket.on("task:complete", data => this.broadcastTaskUpdate(socket, "task:completed", data));
      socket.on("task:reschedule", data => this.broadcastTaskUpdate(socket, "task:rescheduled", data));
      socket.on("cache:invalidate", () => this.broadcastCacheInvalidation(socket));
    });

    console.log("[WebSocket] Server initialized");
  }

  private userRoom(userOpenId: string) {
    return `user:${userOpenId}`;
  }

  private sessionRoom(sessionId: string) {
    return `session:${sessionId}`;
  }

  private async reauthenticate(client: ConnectedClient | undefined): Promise<boolean> {
    if (!client || !client.socket.connected || this.clients.get(client.socket.id) !== client) return false;
    try {
      const current = await this.authenticate(client.socket);
      // Never upgrade or replace the claims established by the original handshake.
      if (current.id !== client.user.id || current.openId !== client.user.openId || current.role !== client.user.role) {
        client.socket.disconnect(true);
        return false;
      }
      return client.socket.connected && this.clients.get(client.socket.id) === client;
    } catch {
      client.socket.disconnect(true);
      return false;
    }
  }

  private deliverLocally(delivery: GuardedDelivery): void {
    for (const client of this.clients.values()) {
      if (client.socket.id === delivery.excludeSocketId) continue;
      if (delivery.target === 'user' && client.user.openId !== delivery.targetId) continue;
      if (delivery.target === 'session' && !client.socket.rooms.has(this.sessionRoom(delivery.targetId!))) continue;
      void (async () => {
        if (!(await this.reauthenticate(client))) return;
        if (delivery.target === 'session') {
          if (!(await this.authorizeSession(client.user, delivery.targetId!))) {
            await client.socket.leave(this.sessionRoom(delivery.targetId!));
            return;
          }
          if (!(await this.reauthenticate(client))
            || !client.socket.rooms.has(this.sessionRoom(delivery.targetId!))) return;
        }
        if (client.socket.connected) client.socket.emit(delivery.event, delivery.data);
      })().catch(() => {
        client.socket.disconnect(true);
        console.warn('[WebSocket] Recipient authorization unavailable; delivery withheld');
      });
    }
  }

  private dispatch(delivery: GuardedDelivery): void {
    this.deliverLocally(delivery);
    if (!this.deliveryNamespace || !isRedisAvailable()) return;
    try {
      this.deliveryNamespace.serverSideEmit(GUARDED_DELIVERY_EVENT, delivery);
    } catch {
      console.warn('[WebSocket] Cross-instance delivery unavailable; local delivery retained');
    }
  }

  private broadcastTaskUpdate(socket: Socket, event: string, data: unknown): void {
    const client = this.clients.get(socket.id);
    if (!client) return;

    this.dispatch({
      target: 'user', targetId: client.user.openId, event, excludeSocketId: socket.id,
      data: {
        ...(typeof data === "object" && data ? data : {}),
        timestamp: new Date().toISOString(),
        sourceSocketId: socket.id,
      },
    });
  }

  private broadcastCacheInvalidation(socket: Socket): void {
    const client = this.clients.get(socket.id);
    if (!client) return;

    this.dispatch({
      target: 'user', targetId: client.user.openId, event: 'cache:invalidated', excludeSocketId: socket.id,
      data: { timestamp: new Date().toISOString() },
    });
  }

  emitToUser(userOpenId: string, event: string, data: unknown): void {
    this.dispatch({ target: 'user', targetId: userOpenId, event, data });
  }

  emitToAll(event: string, data: unknown): void {
    this.dispatch({ target: 'all', event, data });
  }

  emitToSession(sessionId: string, event: string, data: unknown): void {
    this.dispatch({ target: 'session', targetId: sessionId, event, data });
  }

  emitATISProgress(
    sessionId: string,
    taskId: string,
    phase: number,
    status: "started" | "in_progress" | "completed" | "failed",
    confidence?: number,
    error?: string,
    progress?: number,
  ): void {
    this.emitToSession(sessionId, "progress-update", {
      sessionId,
      taskId,
      phase,
      status,
      confidence,
      progress,
      error,
      timestamp: Date.now(),
    });
  }

  emitPhaseCompleted(sessionId: string, phase: number, duration: number, confidence: number): void {
    this.emitToSession(sessionId, "phase-completed", {
      sessionId,
      phase,
      duration,
      confidence,
      timestamp: Date.now(),
    });
  }

  emitAnalysisComplete(
    sessionId: string,
    taskId: string,
    overallConfidence: number,
    completedPhases: number,
    totalPhases: number,
    totalDuration: number,
  ): void {
    this.emitToSession(sessionId, "analysis-complete", {
      sessionId,
      taskId,
      overallConfidence,
      completedPhases,
      totalPhases,
      totalDuration,
      timestamp: Date.now(),
    });
  }

  emitAnalysisError(sessionId: string, phase: number, error: string): void {
    this.emitToSession(sessionId, "analysis-error", { sessionId, phase, error, timestamp: Date.now() });
  }

  emitConfidenceUpdate(sessionId: string, phase: number, confidence: number): void {
    this.emitToSession(sessionId, "confidence-update", { phase, confidence, timestamp: Date.now() });
  }

  getConnectedClientsCount(): number {
    return this.clients.size;
  }

  getUserClientsCount(userOpenId: string): number {
    return Array.from(this.clients.values()).filter(client => client.user.openId === userOpenId).length;
  }

  getConnectedUsers(): string[] {
    return Array.from(new Set(Array.from(this.clients.values()).map(client => client.user.openId)));
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.socket.disconnect(true);
    this.clients.clear();
  }
}

export const websocketService = new WebSocketService();
