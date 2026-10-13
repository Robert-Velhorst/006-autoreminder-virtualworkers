import path from "node:path";

const requiredShadowEnvironment = {
  NODE_ENV: "production",
  LOCAL_AUTH_BYPASS: "false",
  APTLSS_MANAGER_SHADOW_ONLY: "true",
  APTLSS_MANAGER_SCHEDULER: "true",
  APTLSS_SAFETY_ATTESTATION: "/app/pilot-proof/aptlss-safety.json",
};

export function assertAptlssPilotOperationAllowed(mode) {
  if (!["check", "stop", "resume", "migrate", "deploy", "rollback"].includes(mode)) {
    throw new Error("Unknown rollout operation");
  }
  // Shadow-image proof does not establish legacy compatibility with compact history.
  if (mode === "rollback") {
    throw new Error("Legacy rollback is disabled: a dedicated full-data compatibility and rollback rehearsal is required before recreating the production application");
  }
  return true;
}

export function assertSingleAptlssPilotWorkerId(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Set exactly one positive numeric worker ID for the APTLSS pilot");
  }
  return Number(value);
}

export const MIN_LIVE_BROWSER_SPECS = 3;

export function assertAptlssResumeConfiguration({
  container,
  imageDetails,
  image,
  proofDirectory,
  pilotWorkerId,
}) {
  if (!Array.isArray(container?.Config?.Env)) {
    throw new Error("Existing application environment is invalid; refusing to resume");
  }

  const configuredEnvironment = new Map();
  for (const entry of container.Config.Env) {
    if (typeof entry !== "string") {
      throw new Error("Existing application environment is invalid; refusing to resume");
    }
    const separator = entry.indexOf("=");
    if (separator < 1 || configuredEnvironment.has(entry.slice(0, separator))) {
      throw new Error("Existing application environment is ambiguous; refusing to resume");
    }
    configuredEnvironment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }

  const proofMounts = Array.isArray(container.Mounts)
    ? container.Mounts.filter(mount => mount.Destination === "/app/pilot-proof")
    : [];
  const selectedWorkerId = assertSingleAptlssPilotWorkerId(String(pilotWorkerId ?? ""));
  const hasRequiredEnvironment = Object.entries(requiredShadowEnvironment).every(
    ([key, value]) => configuredEnvironment.get(key) === value
  ) && configuredEnvironment.get("APTLSS_MANAGER_PILOT_WORKER_IDS") === String(selectedWorkerId);
  const hasReadOnlyProofMount =
    proofMounts.length === 1 &&
    proofMounts[0].Type === "bind" &&
    proofMounts[0].ReadOnly === true &&
    typeof proofMounts[0].Source === "string" &&
    path.resolve(proofMounts[0].Source) === path.resolve(proofDirectory);

  if (
    typeof imageDetails?.Id !== "string" ||
    container.Config.Image !== image ||
    container.Image !== imageDetails.Id ||
    !hasRequiredEnvironment ||
    !hasReadOnlyProofMount
  ) {
    throw new Error("Existing application is not the verified production shadow pilot; refusing to resume");
  }

  return true;
}

export function isAptlssImageSafetyProofValid(proof, verified) {
  return Boolean(
    proof?.success === true &&
      proof.scope === "shadow-pilot" &&
      proof.activeModeVerified === false &&
      proof.mysqlIntegration === true &&
      proof.browserIntegration === true &&
      Number.isSafeInteger(proof.regressionTests) &&
      proof.regressionTests >= 100 &&
      typeof verified?.version === "string" &&
      proof.version === verified.version &&
      proof.digest === verified.digest &&
      verified.bundleValid === true &&
      verified.collectorPackageValid === true
  );
}

export function hasMinimumLiveBrowserSpecs(browserResults) {
  const liveSuites = Array.isArray(browserResults?.suites)
    ? browserResults.suites.filter(
        suite =>
          typeof suite.file === "string" &&
          suite.file.replaceAll("\\", "/").endsWith("aptlss-manager-live.spec.ts")
      )
    : [];
  const countNestedSpecs = suite =>
    (Array.isArray(suite?.specs) ? suite.specs.length : 0) +
    (Array.isArray(suite?.suites)
      ? suite.suites.reduce((total, nestedSuite) => total + countNestedSpecs(nestedSuite), 0)
      : 0);
  const liveSpecCount = liveSuites.reduce(
    (total, suite) => total + countNestedSpecs(suite),
    0
  );

  return (
    Number.isSafeInteger(browserResults?.stats?.expected) &&
    browserResults.stats.expected >= MIN_LIVE_BROWSER_SPECS &&
    liveSuites.length === 1 &&
    liveSpecCount >= MIN_LIVE_BROWSER_SPECS
  );
}
