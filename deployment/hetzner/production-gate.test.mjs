import assert from "node:assert/strict";
import test from "node:test";
import { getProductionGateFailure } from "./validate-production-environment.mjs";

const protectedEnvironment = {
  can_admins_bypass: true,
  protection_rules: [
    {
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "Robert-Velhorst" } }],
      prevent_self_review: false,
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

test("rejects missing, empty, or mismatched reviewer rules", () => {
  assert.match(getProductionGateFailure({}, "refs/heads/main"), /Robert-Velhorst/);
  assert.match(
    getProductionGateFailure(
      {
        ...protectedEnvironment,
        protection_rules: [{ type: "required_reviewers", reviewers: [] }],
      },
      "refs/heads/main"
    ),
    /Robert-Velhorst/
  );
  assert.match(
    getProductionGateFailure(
      {
        ...protectedEnvironment,
        protection_rules: [
          {
            ...protectedEnvironment.protection_rules[0],
            reviewers: [
              { type: "User", reviewer: { login: "another-reviewer" } },
            ],
          },
        ],
      },
      "refs/heads/main"
    ),
    /Robert-Velhorst/
  );
});

test("allows the configured reviewer to approve their own deployment", () => {
  const environment = structuredClone(protectedEnvironment);
  assert.equal(getProductionGateFailure(environment, "refs/heads/main"), null);
});

test("rejects production when self-approval is disabled", () => {
  const environment = structuredClone(protectedEnvironment);
  environment.protection_rules[0].prevent_self_review = true;
  assert.match(
    getProductionGateFailure(environment, "refs/heads/main"),
    /allow Robert Velhorst/
  );
});

test("retains the administrator bypass for emergency recovery", () => {
  const environment = structuredClone(protectedEnvironment);
  assert.equal(getProductionGateFailure(environment, "refs/heads/main"), null);
});

test("rejects production when the configured administrator bypass is removed", () => {
  const environment = structuredClone(protectedEnvironment);
  environment.can_admins_bypass = false;
  assert.match(
    getProductionGateFailure(environment, "refs/heads/main"),
    /retain the configured administrator bypass/
  );
});

test("rejects environments that allow unprotected branches", () => {
  const environment = structuredClone(protectedEnvironment);
  environment.deployment_branch_policy.protected_branches = false;
  assert.match(
    getProductionGateFailure(environment, "refs/heads/main"),
    /protected branches/
  );
});
