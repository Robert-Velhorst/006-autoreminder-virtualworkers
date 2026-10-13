import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RedisOptions } from "ioredis";

type Client = {
  status: string;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  options?: RedisOptions;
};
const state = vi.hoisted(() => ({ clients: [] as Client[] }));
vi.mock("ioredis", () => ({
  default: vi.fn(function (_url: string, options: RedisOptions) {
    const client = state.clients.shift();
    if (!client) throw new Error("Unexpected fixture Redis connection");
    client.options = options;
    return client;
  }),
}));

let service: typeof import("./redis") | undefined;
function clients(pubStatus = "ready", subStatus = "ready") {
  const make = (status: string): Client => ({
    status,
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  });
  const pub = make(pubStatus), sub = make(subStatus);
  state.clients.push(pub, sub);
  return { pub, sub };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await service?.closeRedis();
  service = undefined;
  state.clients.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("requires both publisher and subscriber to be ready", async () => {
  clients();
  service = await import("./redis");
  await service.initializeRedis();
  expect(service.isRedisAvailable()).toBe(true);
});
it("fails availability when the subscriber connection rejects", async () => {
  const { sub } = clients("ready", "reconnecting");
  sub.connect.mockRejectedValue(new Error("Fixture subscriber unavailable"));
  service = await import("./redis");
  await service.initializeRedis();
  expect(service.getRedisSubClient()).toBe(sub);
  expect(service.isRedisAvailable()).toBe(false);
  sub.status = "ready";
  expect(service.isRedisAvailable()).toBe(true);
});
it("fails availability when the publisher connection rejects", async () => {
  const { pub } = clients("reconnecting", "ready");
  pub.connect.mockRejectedValue(new Error("Fixture publisher unavailable"));
  service = await import("./redis");
  await service.initializeRedis();
  expect(service.isRedisAvailable()).toBe(false);
  expect(service.getRedisPubClient()).toBe(pub);
  pub.status = "ready";
  expect(service.isRedisAvailable()).toBe(true);
});
it("does not report success while the subscriber is still connecting", async () => {
  const { sub } = clients("ready", "connecting");
  sub.connect.mockReturnValue(new Promise(() => {}));
  service = await import("./redis");
  const initializing = service.initializeRedis();
  await vi.advanceTimersByTimeAsync(2000);
  await initializing;
  expect(service.isRedisAvailable()).toBe(false);
  expect(console.log).not.toHaveBeenCalledWith("[Redis] Both pub/sub clients connected successfully");
});
it("marks a later subscriber disconnect unavailable", async () => {
  const { sub } = clients();
  service = await import("./redis");
  await service.initializeRedis();
  sub.status = "reconnecting";
  expect(service.isRedisAvailable()).toBe(false);
});
it("continues reconnecting after a prolonged outage with a capped delay", async () => {
  const { pub, sub } = clients();
  service = await import("./redis");
  await service.initializeRedis();
  for (const client of [pub, sub]) {
    const retry = client.options!.retryStrategy!;
    for (const attempt of [1, 2, 3, 4, 10, 100, 1000]) {
      const delay = retry(attempt);
      expect(delay).toBeTypeOf("number");
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  }
  expect(pub.options!.enableOfflineQueue).toBe(false);
  expect(pub.options!.maxRetriesPerRequest).toBe(1);
  expect(sub.options!.enableOfflineQueue).toBe(true);
  expect(sub.options!.maxRetriesPerRequest).toBeNull();
});
it("recovers availability only after both retained connections become ready", async () => {
  const { pub, sub } = clients();
  service = await import("./redis");
  await service.initializeRedis();
  pub.status = sub.status = "reconnecting";
  expect(service.isRedisAvailable()).toBe(false);
  pub.status = "ready";
  expect(service.isRedisAvailable()).toBe(false);
  sub.status = "ready";
  expect(service.isRedisAvailable()).toBe(true);
  expect(service.getRedisPubClient()).toBe(pub);
  expect(service.getRedisSubClient()).toBe(sub);
});
it("does not mark an unready publisher available", async () => {
  clients("connecting", "ready");
  service = await import("./redis");
  await service.initializeRedis();
  expect(service.isRedisAvailable()).toBe(false);
});
it("keeps an unconfigured Redis service unavailable", async () => {
  vi.stubEnv("REDIS_URL", "");
  service = await import("./redis");
  await service.initializeRedis();
  expect(service.isRedisAvailable()).toBe(false);
});
it("closes both connections and resets availability", async () => {
  const { pub, sub } = clients();
  service = await import("./redis");
  await service.initializeRedis();
  await service.closeRedis();
  expect(pub.quit).toHaveBeenCalledTimes(1);
  expect(sub.quit).toHaveBeenCalledTimes(1);
  expect(service.isRedisAvailable()).toBe(false);
});
it("disconnects unavailable clients without queuing a shutdown command", async () => {
  const { pub, sub } = clients("reconnecting", "connecting");
  service = await import("./redis");
  await service.initializeRedis();
  await service.closeRedis();
  expect(pub.quit).not.toHaveBeenCalled();
  expect(sub.quit).not.toHaveBeenCalled();
  expect(pub.disconnect).toHaveBeenCalledTimes(1);
  expect(sub.disconnect).toHaveBeenCalledTimes(1);
});
it("bounds shutdown when a ready client's quit never settles", async () => {
  const { pub, sub } = clients();
  pub.quit.mockReturnValue(new Promise(() => {}));
  service = await import("./redis");
  await service.initializeRedis();
  const closing = service.closeRedis();
  expect(service.isRedisAvailable()).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  await closing;
  expect(pub.disconnect).toHaveBeenCalledTimes(1);
  expect(sub.disconnect).toHaveBeenCalledTimes(1);
});
it("does not let an old connection rejection discard replacement clients", async () => {
  const old = clients("connecting", "connecting");
  let reject: (error: Error) => void = () => {};
  old.pub.connect.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  service = await import("./redis");
  const initializing = service.initializeRedis();
  await vi.advanceTimersByTimeAsync(2000);
  await initializing;
  await service.closeRedis();
  const current = clients();
  await service.initializeRedis();
  reject(new Error("Old fixture connection rejected"));
  await Promise.resolve();
  expect(service.getRedisPubClient()).toBe(current.pub);
  expect(service.getRedisSubClient()).toBe(current.sub);
  expect(service.isRedisAvailable()).toBe(true);
});
