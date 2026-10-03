import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { io, type Socket } from "socket.io-client";

const state = vi.hoisted(() => ({
  pub: null as unknown as ReturnType<typeof redisClient>,
  sub: null as unknown as ReturnType<typeof redisClient>,
}));
vi.mock("./services/redis", () => ({
  getRedisPubClient: () => state.pub,
  getRedisSubClient: () => state.sub,
  isRedisAvailable: () => state.pub?.status === "ready" && state.sub?.status === "ready",
}));
vi.mock("@socket.io/redis-adapter", async importOriginal => {
  const actual = await importOriginal<typeof import("@socket.io/redis-adapter")>();
  return { ...actual, createAdapter: vi.fn(actual.createAdapter) };
});

import { createAdapter } from "@socket.io/redis-adapter";
import { WebSocketService } from "./services/websocket";

function redisClient() {
  return Object.assign(new EventEmitter(), {
    status: "reconnecting",
    publish: vi.fn().mockResolvedValue(1),
    psubscribe: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(1),
    punsubscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
  });
}
let service: WebSocketService;
let server: ReturnType<typeof createServer>;
const connected: Socket[] = [];
beforeEach(async () => {
  vi.mocked(createAdapter).mockClear();
  state.pub = redisClient(); state.sub = redisClient();
  server = createServer();
  service = new WebSocketService({
    authenticate: async socket => ({ id: socket.handshake.auth.id, openId: `worker-${socket.handshake.auth.id}`, name: "Fixture", role: "worker" }),
    authorizeSession: async (user, session) => session === `owned-${user.id}`,
  });
  service.initialize(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
});
afterEach(async () => {
  for (const client of connected.splice(0)) client.disconnect();
  await new Promise<void>(resolve => service.getIO()!.close(() => resolve()));
});
function event<T>(client: Socket, name: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture event deadline: ${name}`)), 2000);
    client.once(name, value => { clearTimeout(timeout); resolve(value); });
  });
}
async function connect(id: number) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server not bound");
  const client = io(`http://127.0.0.1:${address.port}`, { path: "/ws", transports: ["websocket"], reconnection: false, autoConnect: false, auth: { id } });
  connected.push(client);
  const authenticated = event(client, "authenticated");
  client.connect(); await authenticated;
  return client;
}
it("installs a stable Redis adapter before readiness and does not replace it on reconnect", () => {
  const adapter = service.getIO()!.sockets.adapter;
  expect(createAdapter).toHaveBeenCalledTimes(1);
  state.pub.status = "ready"; state.pub.emit("ready");
  expect(createAdapter).toHaveBeenCalledTimes(1);
  state.sub.status = "ready"; state.sub.emit("ready");
  expect(createAdapter).toHaveBeenCalledTimes(1);
  state.pub.emit("ready"); state.sub.emit("ready");
  expect(createAdapter).toHaveBeenCalledTimes(1);
  expect(service.getIO()!.sockets.adapter).toBe(adapter);
});
it("preserves existing worker rooms and authorized ATIS sessions through Redis recovery", async () => {
  const worker = await connect(1), other = await connect(2);
  const joined = event(worker, "session-joined");
  worker.emit("join-session", "owned-1"); await joined;
  state.pub.status = state.sub.status = "ready";
  state.sub.emit("ready");
  expect(createAdapter).toHaveBeenCalledTimes(1);
  let leaked = false;
  other.on("fixture:worker", () => { leaked = true; });
  other.on("fixture:session", () => { leaked = true; });
  const received = event(worker, "fixture:worker");
  service.emitToUser("worker-1", "fixture:worker", { preserved: true });
  await expect(received).resolves.toEqual({ preserved: true });
  const session = event(worker, "fixture:session");
  service.emitToSession("owned-1", "fixture:session", { preserved: true });
  await expect(session).resolves.toEqual({ preserved: true });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(leaked).toBe(false);
  const denied = event(other, "session-error");
  other.emit("join-session", "owned-1");
  await expect(denied).resolves.toMatchObject({ error: "Session access denied" });
});
it("closes its subscription adapter when the server shuts down before Redis is ready", async () => {
  await new Promise<void>(resolve => service.getIO()!.close(() => resolve()));
  expect(state.sub.punsubscribe).toHaveBeenCalled();
  expect(state.sub.unsubscribe).toHaveBeenCalled();
  expect(state.pub.listenerCount("ready")).toBe(0);
  expect(state.sub.listenerCount("ready")).toBe(0);
  state.pub.status = state.sub.status = "ready";
  state.pub.emit("ready"); state.sub.emit("ready");
  expect(createAdapter).toHaveBeenCalledTimes(1);
});
it("delivers locally without queuing publications while Redis is unavailable", async () => {
  state.pub.publish.mockRejectedValue(new Error("Fixture publisher unavailable"));
  const worker = await connect(1), other = await connect(2);
  let leaked = false;
  other.on("fixture:offline", () => { leaked = true; });
  const received = event(worker, "fixture:offline");
  service.emitToUser("worker-1", "fixture:offline", { local: true });
  await expect(received).resolves.toEqual({ local: true });
  expect(state.pub.publish).not.toHaveBeenCalled();
  state.pub.status = state.sub.status = "ready";
  state.pub.publish.mockResolvedValue(1);
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(state.pub.publish).not.toHaveBeenCalled();
  expect(leaked).toBe(false);
});
it("handles a publish failure after readiness without losing local delivery or logging provider details", async () => {
  state.pub.status = state.sub.status = "ready";
  state.pub.publish.mockRejectedValue(new Error("Fixture sensitive connection detail"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const worker = await connect(1);
    const received = event(worker, "fixture:race");
    service.emitToUser("worker-1", "fixture:race", { local: true });
    await expect(received).resolves.toEqual({ local: true });
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("[WebSocket] Redis publication unavailable; local delivery retained"));
    expect(warning.mock.calls.flat().join(" ")).not.toContain("Fixture sensitive");
  } finally { warning.mockRestore(); }
});
