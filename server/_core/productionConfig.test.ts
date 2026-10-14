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
      DATABASE_URL: "file://legacy",
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
});
