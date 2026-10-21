import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy founder time-entry ownership", () => {
  const source = readFileSync(resolve(process.cwd(), "server/routes/va-management.ts"), "utf8");

  it("validates that a started timer belongs to a worker profile managed by the signed-in founder", () => {
    const start = source.slice(source.indexOf("router.post('/time-entries/start'"), source.indexOf("router.put('/time-entries/:id/stop'"));

    expect(start).toContain("eq(vaProfiles.id, vaId)");
    expect(start).toContain("eq(vaProfiles.founderId, user.id)");
  });

  it("gates pilot timer starts only on stale or unverified sources cited by that card's next action", () => {
    const start = source.slice(source.indexOf("router.post('/time-entries/start'"), source.indexOf("router.put('/time-entries/:id/stop'"));

    expect(start).toContain("isManagerPilotWorker(worker[0].userId)");
    expect(start).toContain("await readCurrentManagerHistory(tx as any, worker[0].userId)");
    expect(start).toContain("if (!snapshot) throw new TimerConflict(409");
    expect(start).toContain("managerActionSourceRequirements(JSON.stringify(snapshot), cardId)");
    expect(start).toContain("managerActionNeedsSourceVerification(sourceRequirements");
    expect(start.indexOf("managerActionNeedsSourceVerification")).toBeLessThan(start.indexOf("insertCanonicalTimer(tx"));
  });

  it("does not let a founder stop another founder's time entry by numeric ID", () => {
    const stop = source.slice(source.indexOf("router.put('/time-entries/:id/stop'"), source.indexOf("router.get('/time-entries/:taskId'"));

    expect(stop).toContain("closeCanonicalTimer(db, user, entryId");
    expect(stop).toContain("founderManaged: true");
  });

  it("uses a founder-owned worker profile before assigning work or creating a handoff", () => {
    const assignment = source.slice(source.indexOf("router.post('/assignments'"), source.indexOf("router.get('/assignments/va/:vaId'"));
    const reassignment = source.slice(source.indexOf("router.post('/assignments/:id/assign'"), source.indexOf("router.post('/assignments/:id/priority'"));
    const handoff = source.slice(source.indexOf("router.post('/handoff'"), source.indexOf("router.get('/handoff/:taskId'"));

    expect(assignment).toContain("await assignTask(db, user, { taskId, workerProfileId: vaId");
    expect(reassignment).toContain("await reassignTask(db, user, { assignmentId, workerProfileId: vaId");
    expect(handoff).toContain("await getFounderWorker(db, user.id, fromVaId)");
    expect(handoff).toContain("await getFounderWorker(db, user.id, toVaId)");
    expect(handoff).toContain("withLockedAssignment(db, user, taskId");
    expect(handoff).toContain("workerProfileIds: toVaId === null ? [fromVaId] : [fromVaId, toVaId]");
  });
});
