import { pathToFileURL } from "node:url";

export function getProductionGateFailure(environment, ref) {
  if (!environment || typeof environment !== "object") {
    return "Could not validate the GitHub production environment response";
  }
  if (ref !== "refs/heads/main") {
    return "Dispatch this workflow from the protected main branch";
  }

  const reviewerRule = environment.protection_rules?.find(
    rule =>
      rule.type === "required_reviewers" &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.some(
        reviewer =>
          reviewer.type === "User" &&
          reviewer.reviewer?.login === "Robert-Velhorst"
      )
  );
  if (!reviewerRule) {
    return "Production must require Robert-Velhorst as a reviewer";
  }

  if (reviewerRule.prevent_self_review !== false) {
    return "Production must allow Robert Velhorst to approve his own deployment";
  }

  if (environment.can_admins_bypass !== true) {
    return "Production must retain the configured administrator bypass for emergency recovery";
  }

  if (environment.deployment_branch_policy?.protected_branches !== true) {
    return "Production deployments must be limited to protected branches";
  }

  return null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const environment = JSON.parse(input);
    const failure = getProductionGateFailure(
      environment,
      process.env.GITHUB_REF
    );
    if (failure) {
      console.error(failure);
      process.exitCode = 1;
    }
  } catch {
    console.error(
      "Could not validate the GitHub production environment response"
    );
    process.exitCode = 1;
  }
}
