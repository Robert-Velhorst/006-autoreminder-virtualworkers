import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processFixture = vi.hoisted(() => ({ spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })) }));
vi.mock("node:child_process", () => ({ spawn: processFixture.spawn }));
vi.mock("node:fs", () => ({ existsSync: () => false, readFileSync: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  processFixture.spawn.mockClear();
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.stubEnv("APTLSS_UI_ONLY", "false");
  vi.stubEnv("APTLSS_TEST_DATABASE_URL", "mysql://fixture:fixture@127.0.0.1:33317/recovery_test");
  vi.stubEnv("APTLSS_TEST_PILOT_WORKER_IDS", "100000001,100000002,100000003,100000004,100000005");
  for (const key of ["PUBLIC_URL", "APP_URL", "VITE_FRONTEND_URL", "WEBHOOK_BASE_URL", "LOCAL_ACCESS_ORIGINS"]) {
    vi.stubEnv(key, "https://operator.example");
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("isolated browser server origin configuration", () => {
  it.each([["", "3035"], ["3037", "3037"]])("allows only its own loopback origin with port %s", async (configured, expected) => {
    vi.stubEnv("APTLSS_TEST_PORT", configured);
    await import("../scripts/start-aptlss-test-server");
    const options = (processFixture.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2];
    expect(options.env.LOCAL_ACCESS_ORIGINS).toBe(`http://127.0.0.1:${expected}`);
    expect(options.env.PORT).toBe(expected);
    for (const key of ["PUBLIC_URL", "APP_URL", "VITE_FRONTEND_URL", "WEBHOOK_BASE_URL"]) expect(options.env[key]).toBe("");
  });

  it("rejects an invalid test port before spawning a backend", async () => {
    vi.stubEnv("APTLSS_TEST_PORT", "3035/path");
    await expect(import("../scripts/start-aptlss-test-server")).rejects.toThrow(/port/i);
    expect(processFixture.spawn).not.toHaveBeenCalled();
  });
});
