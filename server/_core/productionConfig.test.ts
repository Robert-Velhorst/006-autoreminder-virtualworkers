import { describe, expect, it } from "vitest";
import {
  assertProductionConfiguration,
  getProductionConfigurationErrors,
} from "./productionConfig";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "mysql://worker:secret@mysql:3306/va_dashboard",
  JWT_SECRET: "a".repeat(32),
  TRELLO_API_KEY: "trello-key",
  TRELLO_TOKEN: "trello-token",
  OPENAI_API_KEY: "openai-key",
  HOST: "0.0.0.0",
  PUBLIC_URL: "https://dashboard.example",
  LOCAL_AUTH_BYPASS: "false",
};

describe("production configuration", () => {
  it("accepts the canonical production contract", () => {
    expect(getProductionConfigurationErrors(validProductionEnvironment)).toEqual([]);
    expect(() => assertProductionConfiguration(validProductionEnvironment)).not.toThrow();
  });

  it("does not enforce production-only requirements in development", () => {
    expect(getProductionConfigurationErrors({ NODE_ENV: "development" })).toEqual([]);
  });

  it("reports missing or unsafe production configuration without values", () => {
    const errors = getProductionConfigurationErrors({
      NODE_ENV: "production",
      DATABASE_URL: "mongodb://legacy",
      JWT_SECRET: "short",
      HOST: "127.0.0.1",
      LOCAL_AUTH_BYPASS: "true",
    });

    expect(errors).toEqual([
      "DATABASE_URL must be a MySQL connection URL",
      "JWT_SECRET must contain at least 32 characters",
      "TRELLO_API_KEY is required",
      "TRELLO_TOKEN is required",
      "OPENAI_API_KEY is required",
      "HOST must bind to a non-loopback interface in production",
      "PUBLIC_URL, WEBHOOK_BASE_URL, or APP_URL must provide an HTTPS public origin in production",
      "LOCAL_AUTH_BYPASS cannot be enabled in production",
    ]);
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

  it("requires an HTTPS public origin for production cookies and callbacks", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      PUBLIC_URL: "http://dashboard.example",
    })).toContain("PUBLIC_URL, WEBHOOK_BASE_URL, or APP_URL must provide an HTTPS public origin in production");
    const { PUBLIC_URL: _publicUrl, ...withoutPublicUrl } = validProductionEnvironment;
    expect(getProductionConfigurationErrors(withoutPublicUrl)).toContain(
      "PUBLIC_URL, WEBHOOK_BASE_URL, or APP_URL must provide an HTTPS public origin in production",
    );
  });

  it("requires webhook verification when a Trello callback is configured", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      TRELLO_WEBHOOK_CALLBACK_URL: "https://dashboard.example/api/trello-webhook",
    })).toEqual([
      "TRELLO_WEBHOOK_SECRET is required when Trello webhooks are enabled",
    ]);
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      TRELLO_WEBHOOK_CALLBACK_URL: "https://dashboard.example/api/trello-webhook",
      TRELLO_WEBHOOK_SECRET: "secret",
    })).toEqual([]);
  });
});
