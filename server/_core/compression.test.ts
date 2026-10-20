import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { configureCompression } from "./compression";

describe("response compression", () => {
  it("compresses a sizable text response when the client accepts gzip", async () => {
    const app = express();
    configureCompression(app);
    app.get("/bundle.js", (_req, res) => {
      res.type("application/javascript").send("export default 'dashboard';\n".repeat(300));
    });

    const response = await request(app)
      .get("/bundle.js")
      .set("Accept-Encoding", "gzip")
      .expect(200);

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers.vary).toContain("Accept-Encoding");
  });
});
