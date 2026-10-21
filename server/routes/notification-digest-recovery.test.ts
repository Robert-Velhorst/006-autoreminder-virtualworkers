import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ db: vi.fn(), attention: vi.fn(), reconcile: vi.fn(), review: vi.fn() }));
vi.mock("../db", () => ({ getDb: controls.db }));
vi.mock("../services/digest-outbox", () => ({
  listDigestJobsNeedingAttention: controls.attention,
  reconcileDigestJob: controls.reconcile,
  getDigestJobForReview: controls.review,
}));
import routes from "./notification-history";

const app = express().use(express.json()).use((req, _res, next) => {
  const role = req.headers["x-test-role"];
  if (role) (req as any).user = { id: 17, openId: "operator-17", role };
  next();
}).use("/api/notifications", routes);
const input = { outcome: "retry", note: "Provider log reviewed before authorizing retry", evidenceReference: "provider-log:123", acknowledgeDuplicateRisk: true };

describe("digest recovery authorization through real HTTP routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    controls.attention.mockResolvedValue([]);
    controls.reconcile.mockResolvedValue({ id: 5, state: "prepared" });
    controls.review.mockResolvedValue({ id: 5, text: "Recorded message preview" });
  });
  it.each([undefined, "worker", "user"])("denies attention and reconciliation for %s", async role => {
    const read = request(app).get("/api/notifications/digest-jobs/attention");
    const write = request(app).post("/api/notifications/digest-jobs/5/reconcile").send(input);
    if (role) { read.set("x-test-role", role); write.set("x-test-role", role); }
    expect((await read).status).toBe(role ? 403 : 401);
    expect((await write).status).toBe(role ? 403 : 401);
    expect(controls.attention).not.toHaveBeenCalled();
    expect(controls.reconcile).not.toHaveBeenCalled();
  });
  it("derives the operator identity from authenticated context", async () => {
    expect((await request(app).get("/api/notifications/digest-jobs/attention").set("x-test-role", "admin")).status).toBe(200);
    expect(controls.attention).toHaveBeenCalledExactlyOnceWith(17);
    const response = await request(app).post("/api/notifications/digest-jobs/5/reconcile")
      .set("x-test-role", "admin").send(input);
    expect(response.status).toBe(200);
    expect(controls.reconcile).toHaveBeenCalledExactlyOnceWith(5, 17, input);
    const review = await request(app).get("/api/notifications/digest-jobs/5").set("x-test-role", "admin");
    expect(review.status).toBe(200);
    expect(controls.review).toHaveBeenCalledExactlyOnceWith(5, 17);
    expect(review.body.job).toEqual({ id: 5, text: "Recorded message preview" });
  });
  it("does not expose retained message content to workers", async () => {
    const response = await request(app).get("/api/notifications/digest-jobs/5").set("x-test-role", "worker");
    expect(response.status).toBe(403);
    expect(controls.review).not.toHaveBeenCalled();
  });
  it("preserves uniform not-found on a foreign recipient review", async () => {
    controls.review.mockRejectedValue(Object.assign(new Error("Private foreign recipient data"), { code: "NOT_FOUND" }));
    const response = await request(app).get("/api/notifications/digest-jobs/5").set("x-test-role", "admin");
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("Private foreign");
  });
  it.each([
    { ...input, actorUserId: 99 }, { ...input, outcome: "automatic-resend" },
    { ...input, note: "" }, { ...input, evidenceReference: "" }, { outcome: "sent" },
  ])("rejects malformed or forged reconciliation input %j", async body => {
    const response = await request(app).post("/api/notifications/digest-jobs/5/reconcile")
      .set("x-test-role", "admin").send(body);
    expect(response.status).toBe(400);
    expect(controls.reconcile).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "NaN", "1.5"])("rejects invalid operation ID %s", async id => {
    const response = await request(app).post(`/api/notifications/digest-jobs/${id}/reconcile`)
      .set("x-test-role", "admin").send(input);
    expect(response.status).toBe(400);
    expect(controls.reconcile).not.toHaveBeenCalled();
  });
  it.each([["NOT_FOUND", 404], ["FORBIDDEN", 403], ["CONFLICT", 409], ["BAD_REQUEST", 400]])(
    "preserves safe %s refusal without leaking source details", async (code, status) => {
      controls.reconcile.mockRejectedValue(Object.assign(new Error("private-connection-details"), { code }));
      const response = await request(app).post("/api/notifications/digest-jobs/5/reconcile")
        .set("x-test-role", "admin").send(input);
      expect(response.status).toBe(status);
      expect(JSON.stringify(response.body)).not.toContain("private-connection-details");
    });
  it("reports an unavailable read without pretending there are no pending jobs", async () => {
    controls.attention.mockRejectedValue(new Error("private-connection-details"));
    const response = await request(app).get("/api/notifications/digest-jobs/attention").set("x-test-role", "admin");
    expect(response.status).toBe(503);
    expect(response.body.jobs).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("private-connection-details");
  });
  it.each([{ code: "23503" }, { cause: { code: "23503" } }])("refuses deletion when the canonical membership foreign key retains history (%j)", async error => {
    controls.db.mockResolvedValue({ delete: () => ({ where: vi.fn().mockRejectedValue(error) }) });
    const response = await request(app).delete("/api/notifications/12").set("x-test-role", "worker");
    expect(response.status).toBe(409);
    expect(response.body.success).toBeUndefined();
  });
  it("does not fabricate a recorded acknowledgement from a skipped service result", async () => {
    controls.reconcile.mockResolvedValue({ state: "skipped", count: 0, reason: "Digest already finalized" });
    const response = await request(app).post("/api/notifications/digest-jobs/5/reconcile")
      .set("x-test-role", "admin").send(input);
    expect(response.status).toBe(200);
    expect(response.body.reconciled).toBeUndefined();
  });
});
