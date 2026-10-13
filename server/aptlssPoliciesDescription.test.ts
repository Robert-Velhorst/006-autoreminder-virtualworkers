import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: fixture.getDb }));

import { getAllPolicies } from "./aptlssPoliciesDb";

const oldDescription = "0=Read only, 1=Internal Trello actions, 2=Internal execution support, 3=Draft external comms, 4=Send low-risk follow-ups, 5=Full operational automation.";
const currentDescription = "0=Read only, 1=Internal Trello actions, 2=Internal execution support, 3=Prepare external message drafts, 4–5=Expanded internal automation. External messages are always sent manually by the worker.";
const oldConfidenceDescription = "Plans with confidence below this threshold are flagged for assigned-worker review.";
const currentConfidenceDescription = "Plans with confidence below this threshold are flagged for worker review.";

function createDatabase(description: string, includeLegacyConfidence = false) {
  const rows = [{
    id: 10,
    vaId: 7,
    ruleKey: "autopilot_level",
    label: "Autopilot Level (0–5)",
    description,
    value: "4",
    category: "autopilot",
    enabled: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }];
  if (includeLegacyConfidence) rows.push({
    ...rows[0],
    id: 11,
    ruleKey: "confidence_flag_threshold",
    label: "Confidence Flag-for-Review Threshold (%)",
    description: oldConfidenceDescription,
    value: "65",
    category: "scheduling",
  });
  const orderBy = vi.fn().mockResolvedValue(rows);
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ orderBy }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set }),
  };
  return { db, set };
}

beforeEach(() => vi.clearAllMocks());

describe("APTLSS message-sending policy description", () => {
  it("corrects the obsolete send-enabled text without changing the configured level", async () => {
    const { db, set } = createDatabase(oldDescription, true);
    fixture.getDb.mockResolvedValue(db);

    const policies = await getAllPolicies(7);

    expect(policies.find(policy => policy.ruleKey === "autopilot_level")?.description).toBe(currentDescription);
    expect(policies.find(policy => policy.ruleKey === "autopilot_level")?.value).toBe("4");
    expect(policies.find(policy => policy.ruleKey === "confidence_flag_threshold")?.description).toBe(currentConfidenceDescription);
    expect(policies.find(policy => policy.ruleKey === "confidence_flag_threshold")?.value).toBe("65");
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ description: currentDescription }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ description: currentConfidenceDescription }));
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a customized policy explanation", async () => {
    const custom = "Robert approved this internal-only policy wording.";
    const { db, set } = createDatabase(custom);
    fixture.getDb.mockResolvedValue(db);

    const policies = await getAllPolicies(7);

    expect(policies[0].description).toBe(custom);
    expect(set).not.toHaveBeenCalled();
  });
});
