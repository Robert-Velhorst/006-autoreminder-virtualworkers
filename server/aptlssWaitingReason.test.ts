import { describe, expect, it } from "vitest";
import { interpretWaitingReason, mergeWaitingReasonInterpretation } from "./aptlssWaitingReason";

const nowMs = Date.parse("2026-07-11T07:00:00.000Z");

describe("APTLSS free-form waiting reason interpretation", () => {
  it("extracts a bounded Robert approval and its explicit follow-up", () => {
    const result = interpretWaitingReason(
      "Waiting for Robert to approve the $350 ad budget by Friday at 2pm.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "approval",
      waitingOn: "robert",
      waitingOnName: "Robert",
      requestedItem: "approve the $350 ad budget",
      nextStepType: "request_approval",
      requiresRobert: true,
      followUpSource: "explicit",
    });
    expect(result.nextAction).toContain("bounded approval request for Robert");
    expect(result.followUpAt).toBe("2026-07-17T11:00:00.000Z");
    expect(result.confidenceScore).toBeGreaterThanOrEqual(85);
  });

  it("understands an external asset request and prior contact age", () => {
    const result = interpretWaitingReason(
      "Client Sarah still needs to send the final logo files; I emailed her yesterday.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "asset",
      waitingOn: "external_party",
      waitingOnName: "Client Sarah",
      requestedItem: "send the final logo files",
      followUpSource: "derived_contact_age",
      nextStepType: "request_information",
      isActionableNow: true,
    });
    expect(result.nextAction).toContain("Follow up with Client Sarah now");
  });

  it("recognizes a Trello dependency and requires completion evidence", () => {
    const result = interpretWaitingReason(
      "Blocked until Trello card abc123 deploys the API; check again in 4 hours.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "dependency",
      waitingOn: "dependency",
      waitingOnName: "card abc123",
      nextStepType: "monitor_dependency",
      followUpSource: "explicit",
      followUpAt: "2026-07-11T11:00:00.000Z",
    });
    expect(result.nextAction).toContain("completion evidence");
  });

  it("extracts an access request from natural first-person text", () => {
    const result = interpretWaitingReason("I need access to Google Analytics from Mark.", { nowMs });

    expect(result).toMatchObject({
      category: "access",
      waitingOn: "external_party",
      waitingOnName: "Mark",
      requestedItem: "grant access to Google Analytics",
      nextStepType: "schedule_follow_up",
      followUpSource: "default_policy",
    });
    expect(result.nextAction).toContain("Mark");
  });

  it("uses a role-based worker actor for internal blockers", () => {
    const result = interpretWaitingReason("The virtual worker still needs to upload the signed brief.", { nowMs });

    expect(result).toMatchObject({
      category: "asset",
      waitingOn: "worker",
      waitingOnName: "Worker",
      nextStepType: "complete_internal_action",
      isActionableNow: true,
    });
    expect(result.nextAction).toContain("assigned worker");
    expect(result.nextAction).not.toContain("Joyce");
  });

  it("understands a Dutch Robert approval with an explicit weekday and time", () => {
    const result = interpretWaitingReason(
      "Wacht op Robert om de betalingsregeling goed te keuren voor maandag om 10:00. Gisteren gevraagd.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "payment",
      waitingOn: "robert",
      waitingOnName: "Robert",
      requestedItem: "approve de betalingsregeling",
      nextStepType: "request_approval",
      requiresRobert: true,
      followUpSource: "explicit",
      followUpAt: "2026-07-13T07:00:00.000Z",
    });
    expect(result.nextAction).toContain("bounded approval request for Robert");
    expect(result.confidenceScore).toBeGreaterThanOrEqual(85);
  });

  it("extracts a Dutch client deliverable and recognizes stale prior contact", () => {
    const result = interpretWaitingReason(
      "Klant Sarah moet de getekende overeenkomst te sturen; gisteren gemaild.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "asset",
      waitingOn: "external_party",
      waitingOnName: "Sarah",
      requestedItem: "send de getekende overeenkomst",
      followUpSource: "derived_contact_age",
      nextStepType: "request_information",
      isActionableNow: true,
    });
    expect(result.nextAction).toContain("Follow up with Sarah now and ask them to send");
  });

  it("parses a Dutch explicit deadline instead of applying the stale-contact policy", () => {
    const result = interpretWaitingReason(
      "Klant Sarah moet de getekende overeenkomst te sturen uiterlijk vrijdag om 14:30; gisteren gemaild.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("explicit");
    expect(result.followUpAt).toBe("2026-07-17T11:30:00.000Z");
    expect(result.isActionableNow).toBe(false);
    expect(result.nextAction).toContain("Schedule a follow-up with Sarah for Fri 17 Jul 14:30 EAT");
  });

  it("supports a Dutch relative-hour follow-up", () => {
    const result = interpretWaitingReason(
      "Wacht op leverancier om bestanden te sturen; opvolgen over 4 uur.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "asset",
      waitingOn: "external_party",
      waitingOnName: "Leverancier",
      requestedItem: "send bestanden",
      followUpSource: "explicit",
      followUpAt: "2026-07-11T11:00:00.000Z",
      isActionableNow: false,
    });
  });

  it("understands Dutch relative days and half-hour clock language", () => {
    const result = interpretWaitingReason(
      "Wacht op Sarah om het contract te sturen uiterlijk overmorgen om half 3.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("explicit");
    expect(result.followUpAt).toBe("2026-07-12T23:30:00.000Z");
    expect(result.requestedItem).toBe("send het contract");
  });

  it("skips weekends for a Dutch business-day checkpoint", () => {
    const result = interpretWaitingReason(
      "Wacht op leverancier om documenten te sturen; controleer na 2 werkdagen.",
      { nowMs },
    );

    expect(result.followUpAt).toBe("2026-07-14T06:00:00.000Z");
  });

  it("treats an emailed weekday as contact history, not as a future deadline", () => {
    const result = interpretWaitingReason(
      "Client Sarah still needs to send the final logo files; I emailed her Friday.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("derived_contact_age");
    expect(result.followUpAt).toBe("2026-07-11T07:00:00.000Z");
    expect(result.isActionableNow).toBe(true);
  });

  it("schedules 24 hours after contact made today instead of escalating immediately", () => {
    const result = interpretWaitingReason(
      "Client Sarah still needs to send the final logo files; I emailed her today.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("derived_contact_age");
    expect(result.followUpAt).toBe("2026-07-12T07:00:00.000Z");
    expect(result.isActionableNow).toBe(false);
  });

  it("recognizes a promised delivery weekday as a future checkpoint", () => {
    const result = interpretWaitingReason(
      "Client Sarah will send the final logo files Friday at 14:00.",
      { nowMs },
    );

    expect(result).toMatchObject({
      category: "asset",
      waitingOn: "external_party",
      waitingOnName: "Client Sarah",
      requestedItem: "send the final logo files",
      followUpSource: "explicit",
      followUpAt: "2026-07-17T11:00:00.000Z",
      isActionableNow: false,
    });
  });

  it("parses a written month deadline after the follow-up directive", () => {
    const result = interpretWaitingReason(
      "Waiting for Sarah to send the signed contract by 13 July at 11:00.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("explicit");
    expect(result.followUpAt).toBe("2026-07-13T08:00:00.000Z");
  });

  it("ignores an incidental note date that appears before the waiting evidence", () => {
    const result = interpretWaitingReason(
      "QA note 2026-07-11: Waiting for Sarah to send the signed contract.",
      { nowMs },
    );

    expect(result.followUpSource).toBe("default_policy");
    expect(result.followUpAt).toBe("2026-07-12T07:00:00.000Z");
  });

  it("uses a named contacted person as supported actor evidence", () => {
    const result = interpretWaitingReason(
      "I emailed Sarah Friday and am still waiting for the signed contract.",
      { nowMs },
    );

    expect(result).toMatchObject({
      waitingOn: "external_party",
      waitingOnName: "Sarah",
      category: "asset",
      followUpSource: "derived_contact_age",
    });
  });

  it("routes unclear Robert direction to the Decisions flow", () => {
    const result = interpretWaitingReason("Not sure what Robert wants for the pricing page.", { nowMs });

    expect(result).toMatchObject({
      category: "decision",
      waitingOn: "robert",
      requestedItem: "clarify Robert's direction for the pricing page",
      nextStepType: "request_decision",
      isActionableNow: true,
    });
  });

  it("does not fabricate a blocker from ambiguous text", () => {
    const result = interpretWaitingReason("Still waiting, not sure what is happening.", { nowMs });

    expect(result.waitingOn).toBe("unknown");
    expect(result.confidenceScore).toBeLessThanOrEqual(55);
    expect(result.nextStepType).toBe("clarify_waiting_reason");
    expect(result.missingInformation).toEqual(expect.arrayContaining([
      expect.stringContaining("Who or what"),
      expect.stringContaining("deliverable"),
    ]));
  });

  it("prioritizes an explicit follow-up directive over an incidental earlier date", () => {
    const result = interpretWaitingReason(
      "QA note 2026-07-11: Waiting for Robert to approve the arrangement by Monday at 10am.",
      { nowMs },
    );

    expect(result.followUpAt).toBe("2026-07-13T07:00:00.000Z");
    expect(result.summary).toBe("Waiting on Robert to approve the arrangement.");
  });

  it("does not let AI refinement override an explicit actor or invent a name", () => {
    const base = interpretWaitingReason("Waiting for Robert to approve the budget.", { nowMs });
    const merged = mergeWaitingReasonInterpretation(base, {
      waitingOn: "external_party",
      waitingOnName: "Sarah",
      nextAction: "Sarah has already posted the approval and moved the card.",
      confidenceScore: 100,
    });

    expect(merged.waitingOn).toBe("robert");
    expect(merged.waitingOnName).toBe("Robert");
    expect(merged.nextAction).toBe(base.nextAction);
    expect(merged.confidenceScore).toBeLessThanOrEqual(96);
  });

  it("rebuilds a policy-consistent next step when AI resolves supported ambiguity", () => {
    const base = interpretWaitingReason("Pending Acme confirmation.", { nowMs });
    const merged = mergeWaitingReasonInterpretation(base, {
      waitingOn: "external_party",
      waitingOnName: "Acme",
      requestedItem: "confirmation",
      nextStepType: "request_approval",
      nextAction: "Unrelated unsupported action that should be rejected.",
      confidenceScore: 82,
    }, nowMs);

    expect(merged).toMatchObject({
      waitingOn: "external_party",
      waitingOnName: "Acme",
      requestedItem: "confirmation",
      nextStepType: "request_information",
      isActionableNow: true,
    });
    expect(merged.nextAction).toContain("Follow up with Acme now");
    expect(merged.signals).toEqual(expect.arrayContaining(["actor:explicit", "deliverable:explicit", "semantic_refinement:ai"]));
    expect(merged.signals).not.toContain("actor:missing");
  });
});
