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
  PUBLIC_URL: "https://dashboard.example.com",
  APP_URL: "https://dashboard.example.com",
  VITE_FRONTEND_URL: "https://dashboard.example.com",
  HOST: "0.0.0.0",
  LOCAL_AUTH_BYPASS: "false",
};

describe("production configuration", () => {
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

  it("rejects a Vercel request-only production runtime", () => {
    expect(getProductionConfigurationErrors({
      ...validProductionEnvironment,
      VERCEL: "1",
    })).toEqual([
      "Vercel request-only runtime is unsupported; deploy the unified Docker container",
    ]);
  });
});
