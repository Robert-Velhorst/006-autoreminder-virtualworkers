import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const deploymentScript = await readFile(
  new URL("./deploy.sh", import.meta.url),
  "utf8"
);
const image = `ghcr.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:${"a".repeat(64)}`;

const fakeCommand = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
if [[ "$(basename "$0")" == docker ]]; then
  if [[ "$1" == compose ]]; then
    action=""
    for arg in "$@"; do
      case "$arg" in
        config|ps|port|pull|up|rm) action="$arg"; break ;;
      esac
    done
    case "$action" in
      config)
        [[ "\${FAIL_CONFIG:-0}" != 1 ]] || exit 23
        ;;
      ps)
        printf 'existing-container\\n'
        ;;
      port)
        printf '127.0.0.1:3025\\n'
        ;;
      pull)
        [[ "\${FAIL_PULL:-0}" != 1 ]] || exit 24
        ;;
      up)
        if [[ "\${APP_IMAGE:-}" == va-dashboard-rollback:* ]]; then
          printf 'old\\n' > "$DEPLOY_TEST_STATE"
        else
          printf 'new\\n' > "$DEPLOY_TEST_STATE"
        fi
        ;;
    esac
  elif [[ "$1" == inspect ]]; then
    if [[ "$*" == *"{{.Image}}"* ]]; then
      printf 'sha256:previous-image\\n'
    elif [[ "$(cat "$DEPLOY_TEST_STATE")" == new && "\${FAIL_NEW_HEALTH:-0}" == 1 ]]; then
      printf 'unhealthy\\n'
    else
      printf 'healthy\\n'
    fi
  fi
elif [[ "$(basename "$0")" == curl ]]; then
  exit 0
fi
`;

async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), "va-dashboard-deploy-test-"));
  const appDir = join(root, "app");
  const binDir = join(root, "bin");
  await mkdir(appDir);
  await mkdir(binDir);
  await writeFile(join(appDir, ".env"), "NODE_ENV=production\n");
  await writeFile(join(appDir, "docker-compose.yml"), "image: previous\n");
  const candidate = join(appDir, ".docker-compose.yml.candidate");
  await writeFile(candidate, "image: candidate\n");
  const state = join(root, "active-image");
  const log = join(root, "commands.log");
  await writeFile(state, "old\n");
  await writeFile(log, "");

  const scriptPath = join(root, "deploy.sh");
  const sandboxScript = deploymentScript.replace(
    'if [[ "$APP_DIR" != "/opt/va-dashboard" ]]; then',
    'if [[ "$APP_DIR" != "$EXPECTED_APP_DIR" ]]; then'
  );
  assert.notEqual(
    sandboxScript,
    deploymentScript,
    "sandbox path guard replaced"
  );
  await writeFile(scriptPath, sandboxScript);
  await chmod(scriptPath, 0o700);

  for (const command of ["docker", "curl", "flock", "sleep"]) {
    const commandPath = join(binDir, command);
    await writeFile(commandPath, fakeCommand);
    await chmod(commandPath, 0o700);
  }

  return { root, appDir, binDir, candidate, state, log, scriptPath };
}

function runDeployment(sandbox, failure) {
  return spawnSync("bash", [sandbox.scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      APP_DIR: sandbox.appDir,
      APP_IMAGE: image,
      COMPOSE_CANDIDATE: sandbox.candidate,
      EXPECTED_APP_DIR: sandbox.appDir,
      DEPLOY_TEST_STATE: sandbox.state,
      DEPLOY_TEST_LOG: sandbox.log,
      ...failure,
    },
    timeout: 10_000,
  });
}

test(
  "configuration failure before activation preserves the current deployment",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const sandbox = await makeSandbox();
    try {
      const result = runDeployment(sandbox, { FAIL_CONFIG: "1" });
      assert.equal(result.status, 23, result.stderr);
      assert.match(result.stderr, /before activation/);
      assert.equal(
        await readFile(join(sandbox.appDir, "docker-compose.yml"), "utf8"),
        "image: previous\n"
      );
      await assert.rejects(readFile(sandbox.candidate, "utf8"), {
        code: "ENOENT",
      });
      assert.equal((await readFile(sandbox.state, "utf8")).trim(), "old");
      assert.doesNotMatch(
        await readFile(sandbox.log, "utf8"),
        /force-recreate app/
      );
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
);

test(
  "an unhealthy new container restores and health-checks the previous image",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const sandbox = await makeSandbox();
    try {
      const result = runDeployment(sandbox, { FAIL_NEW_HEALTH: "1" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /restoring the previous application state/);
      assert.match(
        result.stderr,
        /Previous application image restored and healthy/
      );
      assert.equal((await readFile(sandbox.state, "utf8")).trim(), "old");
      assert.equal(
        await readFile(join(sandbox.appDir, "docker-compose.yml"), "utf8"),
        "image: previous\n"
      );
      assert.equal(
        await readFile(join(sandbox.appDir, ".env"), "utf8"),
        "NODE_ENV=production\n"
      );
      await assert.rejects(readFile(sandbox.candidate, "utf8"), {
        code: "ENOENT",
      });
      assert.match(
        await readFile(sandbox.log, "utf8"),
        /--pull never -d --no-build --force-recreate app/
      );
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
);

test(
  "a healthy deployment activates the candidate and removes its transient backup",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const sandbox = await makeSandbox();
    try {
      const result = runDeployment(sandbox, {});
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Deployment healthy:/);
      assert.equal((await readFile(sandbox.state, "utf8")).trim(), "new");
      assert.equal(
        await readFile(join(sandbox.appDir, "docker-compose.yml"), "utf8"),
        "image: candidate\n"
      );
      await assert.rejects(
        readFile(join(sandbox.appDir, ".docker-compose.yml.previous"), "utf8"),
        { code: "ENOENT" }
      );
      assert.equal(
        (await stat(join(sandbox.appDir, ".env"))).mode & 0o777,
        0o600
      );
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
);
