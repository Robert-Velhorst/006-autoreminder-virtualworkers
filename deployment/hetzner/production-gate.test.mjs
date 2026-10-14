import assert from "node:assert/strict";
import test from "node:test";
import { getProductionGateFailure } from "./validate-production-environment.mjs";

const protectedEnvironment = {
  protection_rules: [
    {
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "release-reviewer" } }],
      prevent_self_review: true,
    },
  ],
  deployment_branch_policy: {
    protected_branches: true,
    custom_branch_policies: false,
  },
};

test("allows a protected production environment dispatched from main", () => {
  assert.equal(
    getProductionGateFailure(protectedEnvironment, "refs/heads/main"),
    null
  );
});

test("rejects dispatch from any branch other than main", () => {
  assert.match(
    getProductionGateFailure(protectedEnvironment, "refs/heads/release"),
    /protected main branch/
  );
});

test("rejects missing or empty reviewer rules", () => {
  assert.match(getProductionGateFailure({}, "refs/heads/main"), /reviewer/);
  assert.match(
    getProductionGateFailure(
      {
        ...protectedEnvironment,
        protection_rules: [{ type: "required_reviewers", reviewers: [] }],
      },
      "refs/heads/main"
    ),
    /reviewer/
  );
});

test("allows the configured reviewer to approve their own deployment", () => {
  const environment = structuredClone(protectedEnvironment);
  environment.protection_rules[0].prevent_self_review = false;
  assert.equal(getProductionGateFailure(environment, "refs/heads/main"), null);
});

test("rejects environments that allow unprotected branches", () => {
  const environment = structuredClone(protectedEnvironment);
  environment.deployment_branch_policy.protected_branches = false;
  assert.match(
    getProductionGateFailure(environment, "refs/heads/main"),
    /protected branches/
  );
});
