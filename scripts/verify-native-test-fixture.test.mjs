import { describe, expect, it } from "vitest";
import { verifyNativeTestFixture } from "./verify-native-test-fixture.mjs";

const fixture = "postgresql://fixture:fixture@127.0.0.1:5432/recovery_test?sslmode=disable";
const env = { DATABASE_URL: fixture, APTLSS_TEST_DATABASE_URL: fixture,
  OWNER_PROVISIONING_TEST_DATABASE_URL: fixture, APTLSS_TEST_DISABLE_BACKGROUND_JOBS: "true", NOTIFICATIONS_ENABLED: "false" };

describe("required native PostgreSQL test fixture", () => {
  it("accepts explicit safe fixtures without returning credentials", () => {
    expect(verifyNativeTestFixture(env)).toEqual({ passed: true, nativePostgresConfigured: true });
  });
  it.each(["DATABASE_URL", "APTLSS_TEST_DATABASE_URL", "OWNER_PROVISIONING_TEST_DATABASE_URL"])("rejects a missing %s", key => {
    expect(() => verifyNativeTestFixture({ ...env, [key]: undefined })).toThrow();
  });
  it.each(["postgresql://fixture:fixture@remote.example/recovery_test", fixture.replace("recovery_test", "release_test"),
    fixture.replace("sslmode=disable", "sslmode=verify-full"), `${fixture}&sslmode=disable`])("rejects unsafe fixture targets", value => {
    expect(() => verifyNativeTestFixture({ ...env, APTLSS_TEST_DATABASE_URL: value })).toThrow();
  });
  it("rejects mismatched safe fixtures", () => {
    expect(() => verifyNativeTestFixture({ ...env, OWNER_PROVISIONING_TEST_DATABASE_URL: fixture.replace("5432", "5433") })).toThrow(/same isolated/);
  });
  it("rejects production and enabled side effects", () => {
    for (const override of [{ NODE_ENV: "production" }, { APTLSS_TEST_DISABLE_BACKGROUND_JOBS: "false" }, { NOTIFICATIONS_ENABLED: "true" }]) {
      expect(() => verifyNativeTestFixture({ ...env, ...override })).toThrow();
    }
  });
});
