import { describe, expect, it } from "vitest";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";

describe("disposable PostgreSQL acceptance boundary", () => {
  it.each([
    "postgresql://test:test@127.0.0.1:5432/recovery_test?sslmode=disable",
    "postgres://test:test@localhost/aptlss_test",
    "postgresql://test:test@[::1]/aptlss_test?sslmode=disable",
  ])("accepts the dedicated loopback database: %s", value => {
    expect(requireIsolatedPostgresTestDatabase(value)).toBe(new URL(value).href);
    expect(() => requireIsolatedPostgresTestDatabase(value, true)).toThrow();
  });
  it.each([
    undefined, "", "not a URL", "mysql://test:test@localhost/aptlss_test",
    "postgresql://test:test@db.example.test/aptlss_test",
    "postgresql://test:test@localhost/production",
    "postgresql://test:test@localhost/aptlss_test?host=production",
    "postgresql://test:test@localhost/aptlss_test?sslmode=disable&host=production",
    "postgresql://test:test@localhost/aptlss_test?sslmode=disable&sslmode=disable",
    "postgresql://test:test@localhost/aptlss_test#other",
  ])("rejects ambiguous or non-disposable targets", value => {
    expect(() => requireIsolatedPostgresTestDatabase(value)).toThrow();
  });
});
