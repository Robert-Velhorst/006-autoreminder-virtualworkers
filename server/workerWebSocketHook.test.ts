import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  identity: "worker-one" as string | undefined,
  effects: [] as Array<() => void | (() => void)>,
  dependencies: [] as unknown[][],
  socket: { on: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn(), off: vi.fn() } },
  connect: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    fixture.effects.push(effect);
    fixture.dependencies.push(dependencies);
  },
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({
  user: fixture.identity ? { openId: fixture.identity } : null,
}) }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => {
  fixture.connect(...args);
  return fixture.socket;
} }));
import { useWebSocket } from "../client/src/hooks/useWebSocket";

describe("worker websocket lifecycle registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.identity = "worker-one";
    fixture.effects.length = 0;
    fixture.dependencies.length = 0;
  });

  it("registers reconnect events on the manager and business events on the socket", () => {
    useWebSocket();
    fixture.effects[0]();
    for (const event of ["reconnect", "reconnect_error", "reconnect_failed"]) {
      expect(fixture.socket.io.on).toHaveBeenCalledWith(event, expect.any(Function));
      expect(fixture.socket.on.mock.calls.some(([name]) => name === event)).toBe(false);
    }
    expect(fixture.socket.on).toHaveBeenCalledWith("aptlss:manager-updated", expect.any(Function));
    expect(fixture.connect).toHaveBeenCalledWith(expect.objectContaining({ path: "/ws" }));
  });

  it("disconnects the previous identity on effect cleanup", () => {
    useWebSocket();
    expect(fixture.dependencies[0]).toEqual(["worker-one"]);
    const cleanup = fixture.effects[0]();
    expect(cleanup).toBeTypeOf("function");
    cleanup!();
    for (const [event, listener] of fixture.socket.io.on.mock.calls) {
      expect(fixture.socket.io.off).toHaveBeenCalledWith(event, listener);
    }
    expect(fixture.socket.io.off).toHaveBeenCalledTimes(3);
    expect(fixture.socket.disconnect).toHaveBeenCalledOnce();
  });

  it("does not connect an unauthenticated worker", () => {
    fixture.identity = undefined;
    useWebSocket();
    expect(fixture.effects[0]()).toBeUndefined();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
