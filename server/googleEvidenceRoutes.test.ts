import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import googleEvidenceRoutes from "./googleEvidenceRoutes";

describe("Google evidence route authentication", () => {
  it("returns 401, rather than a role error, for anonymous OAuth and delivery requests", async () => {
    const app = express();
    app.use("/api/google-evidence", googleEvidenceRoutes);

    for (const path of [
      "/api/google-evidence/connect",
      "/api/google-evidence/disconnect",
      "/api/google-evidence/mail-delivery/status",
      "/api/google-evidence/mail-delivery/connect",
      "/api/google-evidence/mail-delivery/disconnect",
    ]) {
      const response = path.includes("disconnect")
        ? await request(app).post(path)
        : await request(app).get(path);
      expect(response.status).toBe(401);
    }
  });
});
