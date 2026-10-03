import type { Request } from "express";
import type { Server as HTTPServer } from "http";
import { and, eq, or } from "drizzle-orm";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { atisAnalysisSessions, type User } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { getDb } from "../db";
import { getRedisPubClient, getRedisSubClient, isRedisAvailable } from "./redis";

type SocketUser = Pick<User, "id" | "openId" | "name" | "role">;
type SocketAuthenticator = (socket: Socket) => Promise<SocketUser>;
type SessionAuthorizer = (user: SocketUser, sessionId: string) => Promise<boolean>;

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
    process.env.WEBHOOK_BASE_URL,
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
        socket.data.user = await this.authenticate(socket);
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
      // Install once before sockets join. The dedicated subscriber retains
      // channel subscriptions across delayed startup and reconnects.
      this.io.adapter(createAdapter(adapterPublisher, subClient));
      console.log("[WebSocket] Redis adapter configured");
    }
    if (!isRedisAvailable()) {
      console.log("[WebSocket] Redis not ready - cross-instance delivery unavailable");
    }

    this.io.on("connection", socket => {
      const user = socket.data.user as SocketUser;
      this.clients.set(socket.id, { socket, user, connectedAt: new Date() });
      void socket.join(this.userRoom(user.openId));

      socket.emit("authenticated", {
        success: true,
        connectedClients: this.getConnectedClientsCount(),
      });

      socket.on("join-session", async (sessionId: unknown) => {
        if (typeof sessionId !== "string" || !sessionId.trim()) return;

        try {
          if (!(await this.authorizeSession(user, sessionId))) {
            socket.emit("session-error", { sessionId, error: "Session access denied" });
            return;
          }

          await socket.join(this.sessionRoom(sessionId));
          socket.emit("session-joined", { sessionId, socketId: socket.id });
        } catch {
          socket.emit("session-error", { sessionId, error: "Unable to verify session access" });
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

  private broadcastTaskUpdate(socket: Socket, event: string, data: unknown): void {
    const client = this.clients.get(socket.id);
    if (!client) return;

    socket.to(this.userRoom(client.user.openId)).emit(event, {
      ...(typeof data === "object" && data ? data : {}),
      timestamp: new Date().toISOString(),
      sourceSocketId: socket.id,
    });
  }

  private broadcastCacheInvalidation(socket: Socket): void {
    const client = this.clients.get(socket.id);
    if (!client) return;

    socket.to(this.userRoom(client.user.openId)).emit("cache:invalidated", {
      timestamp: new Date().toISOString(),
    });
  }

  emitToUser(userOpenId: string, event: string, data: unknown): void {
    this.io?.to(this.userRoom(userOpenId)).emit(event, data);
  }

  emitToAll(event: string, data: unknown): void {
    this.io?.emit(event, data);
  }

  emitToSession(sessionId: string, event: string, data: unknown): void {
    this.io?.to(this.sessionRoom(sessionId)).emit(event, data);
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
