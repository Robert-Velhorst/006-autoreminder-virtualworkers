import { pathToFileURL } from "node:url";

export function validateReleaseSource(releaseTag, release, comparison) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(releaseTag)) {
    throw new Error(
      "Only stable vMAJOR.MINOR.PATCH release tags can be deployed"
    );
  }
  if (
    release?.tag_name !== releaseTag ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw new Error("A published, non-prerelease GitHub release is required");
  }
  if (comparison?.status !== "ahead" && comparison?.status !== "identical") {
    throw new Error(
      "Release tag must point to a commit contained in protected main"
    );
  }

  const commit = comparison.base_commit?.sha;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Could not resolve the release tag to a source commit");
  }

  return { tag: releaseTag, commit };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const release = JSON.parse(process.env.RELEASE_METADATA ?? "");
    const comparison = JSON.parse(process.env.MAIN_COMPARISON ?? "");
    const result = validateReleaseSource(
      process.env.RELEASE_TAG ?? "",
      release,
      comparison
    );
    console.log(`tag=${result.tag}\ncommit=${result.commit}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid release metadata"
    );
    process.exitCode = 1;
  }
}
