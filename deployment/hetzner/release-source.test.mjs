import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseSource } from "./validate-release-source.mjs";

const releaseTag = "v1.2.3";
const commit = "a".repeat(40);
const release = { tag_name: releaseTag, draft: false, prerelease: false };

test("accepts a stable release whose commit is contained in main", () => {
  assert.deepEqual(
    validateReleaseSource(releaseTag, release, {
      status: "ahead",
      base_commit: { sha: commit },
    }),
    { tag: releaseTag, commit }
  );
});

test("accepts a release at the current main commit", () => {
  assert.equal(
    validateReleaseSource(releaseTag, release, {
      status: "identical",
      base_commit: { sha: commit },
    }).commit,
    commit
  );
});

test("rejects prereleases, missing releases, and invalid tags", () => {
  assert.throws(
    () => validateReleaseSource("v1.2.3-rc.1", release, {}),
    /stable vMAJOR.MINOR.PATCH/
  );
  assert.throws(
    () =>
      validateReleaseSource(releaseTag, { ...release, prerelease: true }, {}),
    /published, non-prerelease/
  );
});

test("rejects tags outside protected main and invalid source commits", () => {
  assert.throws(
    () =>
      validateReleaseSource(releaseTag, release, {
        status: "diverged",
        base_commit: { sha: commit },
      }),
    /contained in protected main/
  );
  assert.throws(
    () =>
      validateReleaseSource(releaseTag, release, {
        status: "ahead",
        base_commit: { sha: "not-a-commit" },
      }),
    /resolve the release tag/
  );
});
