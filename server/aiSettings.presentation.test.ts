import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: () => [fixture.values[fixture.index++], vi.fn()],
  useEffect: () => {}, useCallback: (callback: unknown) => callback,
}));
import { AISettings } from "../client/src/components/AISettings";
const previousReact = (globalThis as any).React;
(globalThis as any).React = React;
afterAll(() => { if (previousReact === undefined) delete (globalThis as any).React; else (globalThis as any).React = previousReact; });
const configuration = { provider: "codex-subscription", configured: true, model: "gpt-5.6-luna" };
function render(status: unknown) {
  fixture.index = 0; fixture.values = [status, false, false, null, null];
  return renderToStaticMarkup(React.createElement(AISettings));
}
describe("admin AI subscription presentation", () => {
  it("distinguishes configured queue from connected inference and exposes no credential editor", () => {
    const html = render(configuration);
    expect(html).toContain("Codex subscription"); expect(html).toContain("Configured; not checked"); expect(html).toContain("gpt-5.6-luna");
    expect(html).toContain("do not verify live inference"); expect(html).toContain("may consume subscription usage");
    expect(html).not.toMatch(/Connected|OPENAI_API_KEY|OPENAI_MODEL|<input/);
    expect(html).toContain("Authentication stays in the private host runner");
  });
  it("labels heartbeat readiness without claiming provider acceptance", () => {
    const html = render({ ...configuration, available: true });
    expect(html).toContain("Bridge responding"); expect(html).not.toContain("Connected");
  });
  it("keeps an unavailable bridge explicit and disables its inference test", () => {
    const html = render({ ...configuration, available: false });
    expect(html).toContain("Bridge unavailable");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Test subscription connection<\/button>/);
    expect(html).toContain("Refresh status");
  });
  it("does not equate a fixed policy model with configured transport", () => {
    const html = render({ ...configuration, configured: false, available: false });
    expect(html).toContain("Setup required"); expect(html).not.toContain("Bridge responding");
  });
});
