import { describe, expect, it } from "vitest";
import {
  assertProductionConfiguration,
  getExpressTrustProxySetting,
  getProductionConfigurationErrors,
} from "./productionConfig";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "mysql://worker:secret@mysql:3306/va_dashboard",
  REDIS_URL: "redis://:secret@redis:6379",
  JWT_SECRET: "a".repeat(32),
  TRELLO_API_KEY: "trello-key",
  TRELLO_TOKEN: "trello-token",
  PUBLIC_URL: "https://dashboard.noodzakelijkonline.nl",
  WEBHOOK_BASE_URL: "https://dashboard.noodzakelijkonline.nl",
  HOST: "0.0.0.0",
  LOCAL_AUTH_BYPASS: "false",
};

describe("production configuration", () => {
  it("trusts only the single configured production ingress proxy", () => {
    expect(getExpressTrustProxySetting(validProductionEnvironment)).toBe(1);
    expect(getExpressTrustProxySetting({ NODE_ENV: "development" })).toBe(false);
  });

  it("accepts the canonical production contract", () => {
    expect(getProductionConfigurationErrors(validProductionEnvironment)).toEqual([]);
    expect(() => assertProductionConfiguration(validProductionEnvironment)).not.toThrow();
  });

  it("does not require a paid OpenAI API key to start production", () => {
    expect(getProductionConfigurationErrors(validProductionEnvironment)).toEqual([]);
  });

  it("does not enforce production-only requirements in development", () => {
    expect(getProductionConfigurationErrors({ NODE_ENV: "development" })).toEqual([]);
  });

  it("reports missing or unsafe production configuration without values", () => {
    const unsafeEnvironment = {
      NODE_ENV: "production",
      DATABASE_URL: "mongodb://legacy",
      REDIS_URL: "",
      JWT_SECRET: "short-secret-value",
      TRELLO_API_KEY: "private-trello-key",
      TRELLO_TOKEN: "private-trello-token",
      HOST: "127.0.0.1",
      LOCAL_AUTH_BYPASS: "true",
    };
    const errors = getProductionConfigurationErrors({
      ...unsafeEnvironment,
    });

    expect(errors).toEqual([
      "DATABASE_URL must be a complete MySQL URL with host, database, username, and password",
      "REDIS_URL must be a Redis URL with host and password",
      "JWT_SECRET must contain at least 32 characters",
      "TRELLO_API_KEY must be configured with a non-placeholder value",
      "TRELLO_TOKEN must be configured with a non-placeholder value",
      "PUBLIC_URL must be a valid public HTTPS URL",
      "WEBHOOK_BASE_URL must be a valid public HTTPS URL",
      "HOST must bind to a non-loopback interface in production",
      "LOCAL_AUTH_BYPASS cannot be enabled in production",
    ]);
    let thrownMessage = "";
    try {
      assertProductionConfiguration(unsafeEnvironment);
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("Invalid production configuration");
    expect(thrownMessage).not.toContain("private-trello");
  });

  it("rejects example values even when they satisfy the variable's shape", () => {
    const errors = getProductionConfigurationErrors({
      ...validProductionEnvironment,
      DATABASE_URL: "mysql://worker:URL_ENCODED_APP_PASSWORD@mysql:3306/va_dashboard",
      REDIS_URL: "redis://:URL_ENCODED_REDIS_PASSWORD@redis:6379",
      JWT_SECRET: "replace-with-at-least-32-random-characters",
      TRELLO_API_KEY: "replace-with-your-trello-app-key",
      TRELLO_TOKEN: "replace-with-a-scoped-trello-token",
      PUBLIC_URL: "https://dashboard.example.com",
      WEBHOOK_BASE_URL: "https://dashboard.example.com",
    });

    expect(errors).toEqual([
      "DATABASE_URL must not contain template placeholder values",
      "REDIS_URL must not contain template placeholder values",
      "JWT_SECRET must not contain template placeholder values",
      "TRELLO_API_KEY must be configured with a non-placeholder value",
      "TRELLO_TOKEN must be configured with a non-placeholder value",
      "PUBLIC_URL must not contain template placeholder values",
      "WEBHOOK_BASE_URL must not contain template placeholder values",
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
});
