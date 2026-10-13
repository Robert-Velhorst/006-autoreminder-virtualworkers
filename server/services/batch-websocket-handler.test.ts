import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import BatchWebSocketHandler from "./batch-websocket-handler";

class FakeSocket {
  readyState = WebSocket.OPEN;
  readonly sent: string[] = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, handler: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {}
  ping() {}
}

const handlers: BatchWebSocketHandler[] = [];

afterEach(() => {
  handlers.splice(0).forEach((handler) => handler.destroy());
});

describe("BatchWebSocketHandler", () => {
  it("does not broadcast a job update to a different job sharing its prefix", async () => {
    const handler = new BatchWebSocketHandler();
    handlers.push(handler);
    const first = new FakeSocket();
    const second = new FakeSocket();

    handler.registerClient("job-1", "worker-1", first as unknown as WebSocket);
    handler.registerClient("job-10", "worker-1", second as unknown as WebSocket);

    await handler.broadcastUpdate("job-1", { status: "running" });

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });
});
