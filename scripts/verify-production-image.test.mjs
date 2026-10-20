import { describe, expect, it, vi } from "vitest";
import { verifyProductionImage } from "./verify-production-image.mjs";

const ok = { status: 0, stdout: "", stderr: "" };
const configured = {
  ...ok,
  stdout: JSON.stringify([{ Config: { Env: ["NODE_ENV=production"] } }]),
};
const rejected = {
  status: 1,
  stdout: "Invalid production configuration",
  stderr: "",
};
function driver(overrides = {}) {
  let runs = 0;
  return vi.fn(args => {
    if (args[0] === "image") return overrides.inspect ?? configured;
    if (args[0] === "rm") return overrides.cleanup ?? ok;
    runs++;
    if (overrides.failure) throw overrides.failure;
    return runs === 1
      ? (overrides.runtime ?? ok)
      : (overrides.startup ?? rejected);
  });
}

describe("production image verification isolation", () => {
  it("accepts only all eight checks with no provider network", () => {
    const run = driver();
    expect(verifyProductionImage("fixture:release", run)).toMatchObject({
      passed: true,
      checks: expect.any(Array),
    });
    const containers = run.mock.calls
      .filter(([args]) => args[0] === "run")
      .map(([args]) => args);
    expect(containers).toHaveLength(2);
    const names = containers.map(args => args[args.indexOf("--name") + 1]);
    expect(new Set(names).size).toBe(2);
    for (const args of containers) {
      expect(args[args.indexOf("--network") + 1]).toBe("none");
      expect(args[args.indexOf("--memory") + 1]).toBe("256m");
      expect(args[args.indexOf("--cpus") + 1]).toBe("0.5");
    }
    expect(
      run.mock.calls.filter(([args]) => args[0] === "rm").map(([args]) => args)
    ).toEqual(names.map(name => ["rm", "--force", name]));
  });

  it("cleans up exactly the owned container on command timeout and retains the cause", () => {
    const failure = new Error("Fixture Docker deadline");
    const run = driver({ failure });
    expect(() => verifyProductionImage("fixture:release", run)).toThrow(
      failure
    );
    expect(run).toHaveBeenCalledTimes(3);
    const name =
      run.mock.calls[1][0][run.mock.calls[1][0].indexOf("--name") + 1];
    expect(run.mock.calls[2][0]).toEqual(["rm", "--force", name]);
  });

  it("accepts automatic removal but not other cleanup failures", () => {
    expect(
      verifyProductionImage(
        "fixture:release",
        driver({
          cleanup: { status: 1, stderr: "Error: No such container: fixture" },
        })
      ).passed
    ).toBe(true);
    expect(() =>
      verifyProductionImage(
        "fixture:release",
        driver({ cleanup: { status: 1, stderr: "Daemon unavailable" } })
      )
    ).toThrow(/cleanup not confirmed/);
  });

  it("does not run containers when the image is absent or not production-default", () => {
    const absent = driver({ inspect: { status: 1 } });
    expect(() => verifyProductionImage("fixture:release", absent)).toThrow(
      /unavailable/
    );
    expect(absent).toHaveBeenCalledTimes(1);
    const unsafe = driver({
      inspect: {
        ...ok,
        stdout: JSON.stringify([{ Config: { Env: ["NODE_ENV=development"] } }]),
      },
    });
    expect(() => verifyProductionImage("fixture:release", unsafe)).toThrow(
      /production/
    );
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it("rejects failed runtime checks without starting the application", () => {
    const run = driver({ runtime: { status: 1, stderr: "Assertion failed" } });
    expect(() => verifyProductionImage("fixture:release", run)).toThrow(
      /runtime failed/
    );
    expect(run.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(
      1
    );
  });

  it.each([
    { status: 0, stdout: "Invalid production configuration" },
    { status: 1, stdout: "Other error" },
  ])(
    "rejects startup that does not demonstrate fail-closed configuration: %j",
    startup => {
      expect(() =>
        verifyProductionImage("fixture:release", driver({ startup }))
      ).toThrow(/did not reject/);
    }
  );
});
