import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { securityHeaders } from "./security";

afterEach(() => vi.unstubAllEnvs());

async function headers(mode: string | undefined, hostname = "127.0.0.1") {
  vi.stubEnv("NODE_ENV", mode);
  const app = express();
  app.use(securityHeaders);
  app.get("/", (_req, res) => res.type("html").send('<script type="module">/* Vite React refresh preamble */</script>'));
  return (await request(app).get("/").set("Host", hostname).expect(200)).headers;
}

function directives(policy: string) {
  return Object.fromEntries(policy.split(";").map(value => {
    const [name, ...sources] = value.trim().split(/\s+/);
    return [name, sources];
  }));
}

describe("environment-scoped Vite CSP compatibility", () => {
  it("permits local Vite development requirements only on loopback", async () => {
    const response = await headers("development");
    const csp = directives(response["content-security-policy"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
    expect(csp["connect-src"]).toEqual(["'self'", "wss:", "ws:"]);
    const exposed = directives(
      (await headers("development", "dashboard.example"))["content-security-policy"]
    );
    expect(exposed["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(exposed["connect-src"]).toEqual(["'self'", "wss:"]);
    expect(JSON.stringify(exposed)).not.toContain("unsafe-eval");
  });

  it.each(["production", "test", "staging", "Development", "", undefined])(
    "retains strict script restrictions when NODE_ENV is %s", async mode => {
      const response = await headers(mode);
      const csp = directives(response["content-security-policy"]);
      expect(csp["script-src"]).toEqual(["'self'"]);
      expect(csp["connect-src"]).toEqual(["'self'", "wss:"]);
      expect(csp["script-src"]).not.toContain("'unsafe-inline'");
      expect(response["content-security-policy"]).not.toContain("'unsafe-eval'");
    },
  );

  it("changes no other production CSP directives or security headers", async () => {
    const production = await headers("production");
    const development = await headers("development", "dashboard.example");
    const prodCsp = directives(production["content-security-policy"]);
    const devCsp = directives(development["content-security-policy"]);
    for (const directive of Object.keys(prodCsp).filter(name => !["script-src", "connect-src"].includes(name))) {
      expect(devCsp[directive]).toEqual(prodCsp[directive]);
    }
    expect(devCsp["default-src"]).toEqual(["'self'"]);
    expect(devCsp["object-src"]).toEqual(["'none'"]);
    expect(devCsp["frame-ancestors"]).toEqual(["'none'"]);
    for (const name of ["x-content-type-options", "x-frame-options", "permissions-policy", "referrer-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "origin-agent-cluster", "x-dns-prefetch-control"]) {
      expect(development[name]).toBe(production[name]);
      expect(development[name]).toBeDefined();
    }
  });
});
