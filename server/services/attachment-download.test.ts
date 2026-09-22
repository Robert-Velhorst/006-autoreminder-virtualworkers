import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { httpsRequest } = vi.hoisted(() => ({ httpsRequest: vi.fn() }));

vi.mock("node:https", () => ({ request: httpsRequest }));

import { downloadPinnedHttpsAttachment, readResponseBufferWithinLimit } from "./attachment-download";

describe("attachment download limits", () => {
  it("returns an allowed response body", async () => {
    const result = await readResponseBufferWithinLimit(new Response("safe"), 10);
    expect(result?.toString()).toBe("safe");
  });

  it("rejects a streamed response once it exceeds the configured byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
    });

    await expect(readResponseBufferWithinLimit(new Response(stream), 6)).resolves.toBeNull();
  });

  it("connects using the already validated DNS answer", async () => {
    const response = new EventEmitter() as EventEmitter & {
      headers: Record<string, string>;
      resume: () => void;
      statusCode: number;
    };
    response.headers = { "content-length": "4" };
    response.resume = vi.fn();
    response.statusCode = 200;

    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
    };
    request.destroy = vi.fn();
    request.end = vi.fn();
    httpsRequest.mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => {
        callback(response);
        response.emit("data", Buffer.from("safe"));
        response.emit("end");
      });
      return request;
    });

    await expect(downloadPinnedHttpsAttachment(
      new URL("https://files.example.com/brief.txt"),
      [{ address: "8.8.8.8", family: 4 }],
      { Accept: "*/*" },
    )).resolves.toEqual(Buffer.from("safe"));

    expect(httpsRequest).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ lookup: expect.any(Function), timeout: 15_000 }),
      expect.any(Function),
    );
    const lookup = httpsRequest.mock.calls[0][1].lookup;
    await expect(new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("files.example.com", {}, (error: Error | null, address: string, family: number) => {
        if (error) return reject(error);
        resolve({ address, family });
      });
    })).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });
});
