import { createServer } from "http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { isAllowedWebSocketOrigin, WebSocketService } from "./services/websocket";

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 2_000) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, data => {
      clearTimeout(timeout);
      resolve(data as T);
    });
  });
}

describe("WebSocket Service", () => {
  let wsService: WebSocketService;
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let clients: ClientSocket[];

  beforeEach(async () => {
    clients = [];
    httpServer = createServer();
    wsService = new WebSocketService({
      allowedOrigins: ["http://localhost"],
      authenticate: async socket => {
        const openId = socket.handshake.auth.openId as string | undefined;
        if (!openId) throw new Error("Unauthenticated");
        return {
          id: Number(socket.handshake.auth.userId || 1),
          openId,
          name: openId,
          role: socket.handshake.auth.role === "admin" ? "admin" : "worker",
        };
      },
      authorizeSession: async (user, sessionId) => user.role === "admin" || sessionId === `session-${user.id}`,
    });
    wsService.initialize(httpServer);

    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    port = address.port;
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    wsService.disconnectAll();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  function connect(openId?: string, userId = 1, role: "worker" | "admin" = "worker") {
    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/ws",
      transports: ["websocket"],
      autoConnect: false,
      auth: { openId, userId, role },
    });
    clients.push(client);
    return client;
  }

  it("rejects connections without an authenticated session", async () => {
    const client = connect();
    const errorPromise = waitForEvent<Error>(client, "connect_error");
    client.connect();

    await expect(errorPromise).resolves.toMatchObject({ message: "Authentication required" });
    expect(wsService.getConnectedClientsCount()).toBe(0);
  });

  it("authenticates and tracks the server-verified identity", async () => {
    const client = connect("worker-1");
    const authenticated = waitForEvent<{ success: boolean }>(client, "authenticated");
    client.connect();

    await expect(authenticated).resolves.toMatchObject({ success: true });
    expect(wsService.getConnectedClientsCount()).toBe(1);
    expect(wsService.getConnectedUsers()).toEqual(["worker-1"]);
  });

  it("broadcasts task events only to other clients for the same user", async () => {
    const sender = connect("worker-1");
    const recipient = connect("worker-1");
    const otherUser = connect("worker-2", 2);

    const authenticated = [sender, recipient, otherUser].map(client => waitForEvent(client, "authenticated"));
    for (const client of [sender, recipient, otherUser]) client.connect();
    await Promise.all(authenticated);

    const received = waitForEvent<{ taskId: string }>(recipient, "task:completed");
    let leaked = false;
    otherUser.once("task:completed", () => { leaked = true; });
    sender.emit("task:complete", { taskId: "task-1", isCompleted: true });

    await expect(received).resolves.toMatchObject({ taskId: "task-1" });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(leaked).toBe(false);
  });

  it("denies ATIS session rooms that the worker does not own", async () => {
    const client = connect("worker-1", 1);
    const authenticated = waitForEvent(client, "authenticated");
    client.connect();
    await authenticated;

    const denied = waitForEvent<{ sessionId: string; error: string }>(client, "session-error");
    client.emit("join-session", "session-2");
    await expect(denied).resolves.toEqual({ sessionId: "session-2", error: "Session access denied" });
  });

  it("allows an owner to join an ATIS session room", async () => {
    const client = connect("worker-1", 1);
    const authenticated = waitForEvent(client, "authenticated");
    client.connect();
    await authenticated;

    const joined = waitForEvent<{ sessionId: string }>(client, "session-joined");
    client.emit("join-session", "session-1");
    await expect(joined).resolves.toMatchObject({ sessionId: "session-1" });
  });

  it("emits server-side events through the user room", async () => {
    const client = connect("worker-1");
    const authenticated = waitForEvent(client, "authenticated");
    client.connect();
    await authenticated;

    const message = waitForEvent<{ message: string }>(client, "custom:event");
    wsService.emitToUser("worker-1", "custom:event", { message: "hello" });
    await expect(message).resolves.toEqual({ message: "hello" });
  });
});

describe("WebSocket origin policy", () => {
  it("accepts configured origins and rejects untrusted browser origins", () => {
    expect(isAllowedWebSocketOrigin("https://dashboard.example", ["https://dashboard.example/app"])).toBe(true);
    expect(isAllowedWebSocketOrigin("http://127.0.0.1:3025", ["http://127.0.0.1:3025"])).toBe(true);
    expect(isAllowedWebSocketOrigin("http://127.0.0.1:4040", ["http://127.0.0.1:3025"])).toBe(false);
    expect(isAllowedWebSocketOrigin("https://attacker.example", ["https://dashboard.example"])).toBe(false);
    expect(isAllowedWebSocketOrigin(undefined, [])).toBe(true);
  });
});
