import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnPort, selectServerPort } from "./portSelection";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })
    )
  );
});

describe("server port selection", () => {
  it("keeps the configured port in production without probing alternatives", async () => {
    const findAvailablePort = vi.fn().mockResolvedValue(3100);

    await expect(
      selectServerPort(3000, true, findAvailablePort)
    ).resolves.toBe(3000);
    expect(findAvailablePort).not.toHaveBeenCalled();
  });

  it("allows development to select an available fallback port", async () => {
    const findAvailablePort = vi.fn().mockResolvedValue(3001);

    await expect(
      selectServerPort(3000, false, findAvailablePort)
    ).resolves.toBe(3001);
    expect(findAvailablePort).toHaveBeenCalledWith(3000);
  });

  it("rejects startup when the configured production port cannot bind", async () => {
    const occupied = createServer();
    const candidate = createServer();
    servers.push(occupied, candidate);
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the test server to have a TCP address");
    }

    await expect(
      listenOnPort(candidate, address.port, "127.0.0.1")
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
