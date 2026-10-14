import { describe, expect, it } from "vitest";
import { requirePostgresDatabaseUrl } from "./databaseUrl";

describe("requirePostgresDatabaseUrl", () => {
  it.each([
    "postgres://user:password@localhost:5432/dashboard",
    "postgresql://user:password@localhost:5432/dashboard",
  ])("accepts %s", url => {
    expect(requirePostgresDatabaseUrl(url)).toBe(url);
  });

  it("rejects missing, malformed, and legacy MySQL URLs", () => {
    expect(() => requirePostgresDatabaseUrl(undefined)).toThrow(
      "DATABASE_URL is required"
    );
    expect(() => requirePostgresDatabaseUrl("not a url")).toThrow(
      "valid PostgreSQL connection URL"
    );
    expect(() =>
      requirePostgresDatabaseUrl("mysql://user:password@localhost:3306/app")
    ).toThrow("PostgreSQL protocol");
  });

  it("requires verified TLS when requested by production callers", () => {
    expect(() =>
      requirePostgresDatabaseUrl("postgresql://worker:secret@db.example/app", {
        requireVerifiedTls: true,
      })
    ).toThrow("sslmode=verify-full");
    expect(() =>
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@db.example/app?sslmode=verify-full&ssl=false",
        { requireVerifiedTls: true }
      )
    ).toThrow("ssl override");
    expect(() =>
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@db.example/app?sslmode=verify-full&sslmode=disable",
        { requireVerifiedTls: true }
      )
    ).toThrow("sslmode=verify-full");
    expect(
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@db.example/app?sslmode=verify-full",
        { requireVerifiedTls: true }
      )
    ).toContain("sslmode=verify-full");
  });
});
