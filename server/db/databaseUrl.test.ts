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

  it("allows explicitly insecure TLS only for loopback CI databases", () => {
    const url =
      "postgresql://worker:secret@127.0.0.1:5432/dashboard?sslmode=disable";
    expect(
      requirePostgresDatabaseUrl(url, {
        requireVerifiedTls: true,
        allowInsecureLoopback: true,
      })
    ).toBe(url);
    expect(
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@[::1]:5432/dashboard?sslmode=disable",
        { requireVerifiedTls: true, allowInsecureLoopback: true }
      )
    ).toContain("[::1]");
  });

  it("does not allow the loopback CI exception for remote hosts or TLS overrides", () => {
    expect(() =>
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@db.example/dashboard?sslmode=disable",
        { requireVerifiedTls: true, allowInsecureLoopback: true }
      )
    ).toThrow("sslmode=verify-full");
    expect(() =>
      requirePostgresDatabaseUrl(
        "postgresql://worker:secret@127.0.0.1/dashboard?sslmode=disable&ssl=true",
        { requireVerifiedTls: true, allowInsecureLoopback: true }
      )
    ).toThrow("sslmode=verify-full");
  });
});
