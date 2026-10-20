import { describe, expect, it } from "vitest";
import {
  assertProductionConfiguration,
  getProductionConfigurationErrors,
} from "./productionConfig";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://worker:secret@postgres:5432/va_dashboard?sslmode=verify-full",
  JWT_SECRET: "a".repeat(32),
  TRELLO_API_KEY: "trello-key",
  TRELLO_TOKEN: "trello-token",
  OPENAI_API_KEY: "openai-key",
  PUBLIC_URL: "https://dashboard.example.com",
  APP_URL: "https://dashboard.example.com",
  VITE_FRONTEND_URL: "https://dashboard.example.com",
  HOST: "0.0.0.0",
  LOCAL_AUTH_BYPASS: "false",
};

describe("production configuration", () => {
  it("rejects template credentials while keeping the PostgreSQL TLS contract", () => {
    const errors = getProductionConfigurationErrors({
      ...validProductionEnvironment,
      DATABASE_URL: "postgresql://worker:URL_ENCODED_PASSWORD@postgres:5432/va_dashboard?sslmode=verify-full",
      JWT_SECRET: "replace-with-at-least-32-random-characters",
      TRELLO_TOKEN: "replace-with-your-scoped-trello-token",
    });
    expect(errors).toEqual([
      "DATABASE_URL must not contain template placeholder values",
      "JWT_SECRET must not contain template placeholder values",
      "TRELLO_TOKEN must not contain template placeholder values",
    ]);
  });

  it("rejects a request-only Vercel production runtime", () => {
    expect(getProductionConfigurationErrors({ ...validProductionEnvironment, VERCEL: "1" })).toEqual([
      "Vercel request-only runtime is unsupported; deploy the unified Docker container",
    ]);
  });

  it("accepts the production contract without a paid LLM API key", () => {
    expect(getProductionConfigurationErrors(validProductionEnvironment)).toEqual([]);
    expect(() => assertProductionConfiguration(validProductionEnvironment)).not.toThrow();
  });

  it("does not enforce production-only requirements in development", () => {
    expect(getProductionConfigurationErrors({ NODE_ENV: "development" })).toEqual([]);
  });

  it("requires certificate and hostname verification for production PostgreSQL", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      DATABASE_URL: "postgresql://worker:secret@postgres:5432/va_dashboard?sslmode=require",
    })).toContain("DATABASE_URL must enable verified TLS with one sslmode=verify-full option and no ssl override");
  });

  it("reports missing or unsafe production configuration without values", () => {
    const errors = getProductionConfigurationErrors({
      NODE_ENV: "production",
      DATABASE_URL: "file://legacy",
      JWT_SECRET: "short",
      HOST: "127.0.0.1",
      LOCAL_AUTH_BYPASS: "true",
    });

    expect(errors).toEqual([
      "DATABASE_URL must be a PostgreSQL connection URL",
      "JWT_SECRET must contain at least 32 characters",
      "TRELLO_API_KEY is required",
      "TRELLO_TOKEN is required",
      "PUBLIC_URL must be set to the public HTTPS origin in production",
      "APP_URL must be set to the public HTTPS origin in production",
      "VITE_FRONTEND_URL must be set to the public HTTPS origin in production",
      "HOST must bind to a non-loopback interface in production",
      "PUBLIC_URL, WEBHOOK_BASE_URL, or APP_URL must provide an HTTPS public origin in production",
      "LOCAL_AUTH_BYPASS cannot be enabled in production",
    ]);
  });

  it("rejects MySQL URLs after the PostgreSQL runtime migration", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      DATABASE_URL: "mysql://worker:secret@mysql:3306/va_dashboard",
    })).toEqual(["DATABASE_URL must be a PostgreSQL connection URL"]);
  });

  it("requires all public application URLs to use the same HTTPS origin", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      VITE_FRONTEND_URL: "http://localhost:3000",
    })).toEqual([
      "VITE_FRONTEND_URL must be an HTTPS origin without a path, credentials, query, or fragment",
    ]);
  });

  it("requires the Trello webhook callback and secret as a matching production pair", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      TRELLO_WEBHOOK_CALLBACK_URL: "https://other.example.com/api/trello-webhook",
      TRELLO_WEBHOOK_SECRET: "test-secret",
    })).toEqual([
      "TRELLO_WEBHOOK_CALLBACK_URL must be the exact HTTPS /api/trello-webhook URL on the public origin",
    ]);
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      TRELLO_WEBHOOK_SECRET: "test-secret",
    })).toContain("TRELLO_WEBHOOK_CALLBACK_URL and TRELLO_WEBHOOK_SECRET must be configured together");
  });

});

describe("provider and operator production guards", () => {
it.each([undefined, "", "  ", "codex-subscription", " codex-subscription "])(
    "does not require a paid API key for subscription mode (%s)", provider => {
      const env = { ...validProductionEnvironment, OPENAI_API_KEY: "", APTLSS_MANAGER_PROVIDER: provider };
      expect(getProductionConfigurationErrors(env)).toEqual([]);
      expect(() => assertProductionConfiguration(env)).not.toThrow();
    },
  );
it.each([undefined, "", "  "])("requires a nonempty key when the paid provider is explicitly selected (%s)", key => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment, APTLSS_MANAGER_PROVIDER: " openai-api ", OPENAI_API_KEY: key,
    })).toEqual(["OPENAI_API_KEY is required"]);
  });
it("accepts an explicitly configured API provider and rejects unknown providers without leaking their values", () => {
    expect(getProductionConfigurationErrors({ ...validProductionEnvironment, APTLSS_MANAGER_PROVIDER: "openai-api" })).toEqual([]);
    const env = { ...validProductionEnvironment, APTLSS_MANAGER_PROVIDER: "invalid-private-value" };
    expect(getProductionConfigurationErrors(env)).toEqual(["APTLSS_MANAGER_PROVIDER must be codex-subscription or openai-api"]);
    expect(() => assertProductionConfiguration(env)).toThrow("APTLSS_MANAGER_PROVIDER must be codex-subscription or openai-api");
    expect(() => assertProductionConfiguration(env)).not.toThrow("invalid-private-value");
  });
it("rejects a Vercel request-only production runtime", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      VERCEL: "1",
    })).toEqual([
      "Vercel request-only runtime is unsupported; deploy the unified Docker container",
    ]);
  });
it("rejects a weak owner bootstrap token when recovery is configured", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      OWNER_BOOTSTRAP_TOKEN: "too-short",
    })).toContain("OWNER_BOOTSTRAP_TOKEN must contain at least 24 characters when configured");
  });
it("does not allow scheduled email briefings while delivery is disabled", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      BRIEFING_SCHEDULER_ENABLED: "true",
      NOTIFICATIONS_ENABLED: "false",
    })).toEqual([
      "BRIEFING_SCHEDULER_ENABLED requires NOTIFICATIONS_ENABLED=true",
    ]);
  });
});
