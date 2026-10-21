import type { Request } from "express";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  createSessionToken: vi.fn(),
  createWorkerInvitation: vi.fn(),
  markInvitationSent: vi.fn(),
  sendInvitationEmail: vi.fn(),
}));

vi.mock("./workerInvitations", () => ({
  getWorkerInvitation: mocks.getInvitation,
  acceptWorkerInvitation: mocks.acceptInvitation,
  createWorkerInvitation: mocks.createWorkerInvitation,
  markWorkerInvitationSent: mocks.markInvitationSent,
  WorkerInvitationError: class WorkerInvitationError extends Error {
    constructor(
      message: string,
      public readonly code: string
    ) {
      super(message);
    }
  },
}));
vi.mock("./_core/sdk", () => ({
  sdk: { createSessionToken: mocks.createSessionToken },
}));
vi.mock("./services/email", () => ({
  sendMorningBriefing: vi.fn(),
  sendEODReport: vi.fn(),
  sendWorkerInvitationEmail: mocks.sendInvitationEmail,
  validateEmailProvider: vi.fn(),
}));

import workerInvitationRoutes from "./workerInvitationRoutes";
import vaManagementRoutes from "./routes/va-management";

function publicInvitationApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/worker-invitations", workerInvitationRoutes);
  return app;
}

function managementApp(user?: User) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    (req as Request & { user?: User }).user = user;
    next();
  });
  app.use("/api/va", vaManagementRoutes);
  return app;
}

describe("worker invitation HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSessionToken.mockResolvedValue("session-cookie-value");
    mocks.sendInvitationEmail.mockResolvedValue(false);
  });

  it("returns only invitation display fields from the public token lookup", async () => {
    mocks.getInvitation.mockResolvedValue({
      id: 77,
      userId: 42,
      vaId: 21,
      founderId: 7,
      email: "worker@example.com",
      name: "Invited Worker",
      tokenHash: "stored-hash",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      acceptedAt: null,
      revokedAt: null,
    });

    const response = await request(publicInvitationApp())
      .get("/api/worker-invitations/bearer-token")
      .expect(200);

    expect(mocks.getInvitation).toHaveBeenCalledWith("bearer-token");
    expect(response.body).toEqual({
      name: "Invited Worker",
      email: "worker@example.com",
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
    expect(response.body).not.toHaveProperty("userId");
    expect(response.body).not.toHaveProperty("vaId");
    expect(response.body).not.toHaveProperty("founderId");
    expect(response.body).not.toHaveProperty("tokenHash");
  });

  it("creates the acceptance session only for the identity returned by the token-bound service", async () => {
    mocks.acceptInvitation.mockResolvedValue({
      userId: 42,
      sessionEpoch: "4",
      openId: "worker@example.com",
      name: "Invited Worker",
    });

    await request(publicInvitationApp())
      .post("/api/worker-invitations/bearer-token/accept")
      .send({
        password: "long-enough-password",
        openId: "attacker@example.com",
        email: "attacker@example.com",
        name: "Administrator",
        role: "admin",
        userId: 1,
        vaId: 1,
        founderId: 1,
      })
      .expect(200, {
        success: true,
        redirectTo: "/worker/settings?onboarding=1",
      });

    expect(mocks.acceptInvitation).toHaveBeenCalledWith(
      "bearer-token",
      "long-enough-password"
    );
    expect(mocks.createSessionToken).toHaveBeenCalledWith(
      "worker@example.com",
      expect.objectContaining({ name: "Invited Worker", expectedIdentity: { userId: 42, sessionEpoch: "4" } })
    );
    expect(mocks.createSessionToken).not.toHaveBeenCalledWith(
      "attacker@example.com",
      expect.anything()
    );
  });

  it.each([
    ["anonymous", undefined, 401],
    [
      "worker",
      { id: 42, openId: "worker", name: "Worker", role: "worker" },
      403,
    ],
    [
      "ordinary account",
      { id: 9, openId: "user", name: "User", role: "user" },
      403,
    ],
  ] as const)(
    "does not allow %s to create an invitation",
    async (_label, user, status) => {
      await request(managementApp(user as User | undefined))
        .post("/api/va/vas/invite")
        .send({ name: "Target Worker", email: "worker@example.com" })
        .expect(status);
      expect(mocks.createWorkerInvitation).not.toHaveBeenCalled();
      expect(mocks.sendInvitationEmail).not.toHaveBeenCalled();
    }
  );

  it("uses the authenticated admin as founder and ignores caller-supplied identity, role, and assignment fields", async () => {
    const admin = {
      id: 5,
      openId: "admin",
      name: "Founder",
      role: "admin",
    } as User;
    mocks.createWorkerInvitation.mockResolvedValue({
      userId: 42,
      vaId: 21,
      invitationId: 77,
      name: "Target Worker",
      email: "worker@example.com",
      token: "server-generated-token",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const response = await request(managementApp(admin))
      .post("/api/va/vas/invite")
      .send({
        name: "Target Worker",
        email: "worker@example.com",
        role: "admin",
        founderId: 1,
        userId: 1,
        vaId: 1,
        workerId: 1,
        token: "caller-token",
        tokenHash: "caller-hash",
      })
      .expect(201);

    expect(mocks.createWorkerInvitation).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        name: "Target Worker",
        email: "worker@example.com",
      })
    );
    const [, profileInput] = mocks.createWorkerInvitation.mock.calls[0];
    expect(profileInput).not.toHaveProperty("role");
    expect(profileInput).not.toHaveProperty("founderId");
    expect(profileInput).not.toHaveProperty("userId");
    expect(profileInput).not.toHaveProperty("vaId");
    expect(profileInput).not.toHaveProperty("workerId");
    expect(profileInput).not.toHaveProperty("token");
    expect(profileInput).not.toHaveProperty("tokenHash");
    expect(response.body.workerId).toBe(21);
    expect(mocks.sendInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "worker@example.com" })
    );
  });
});
