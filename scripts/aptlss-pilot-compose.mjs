import { confinedLocalPath } from "../shared/local-filesystem-policy.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertAptlssPilotOperationAllowed,
  assertAptlssResumeConfiguration,
  assertSingleAptlssPilotWorkerId,
  isAptlssImageSafetyProofValid,
} from "./aptlss-pilot-validation.mjs";

const mode = process.argv[2] || "check";
assertAptlssPilotOperationAllowed(mode);
const pilotWorkerId = assertSingleAptlssPilotWorkerId(process.env.APTLSS_MANAGER_PILOT_WORKER_IDS);
const root = path.resolve(".local/pilot");
const main = path.resolve("../joyce-work-schedule");
const runtime = JSON.parse(fs.readFileSync(path.join(root, "runtime-compose.json"), "utf8"));
const before = JSON.parse(fs.readFileSync(path.join(root, "runtime-before.json"), "utf8"));
const image = mode === "rollback" ? before.image : process.env.PILOT_IMAGE || "va-dashboard:joyce-shadow-pilot-20260906";
const proofDirectory = confinedLocalPath(process.env.PILOT_PROOF_DIRECTORY || path.join(root, "proof"));
const subscription = mode !== "rollback" && process.env.PILOT_CODEX_SUBSCRIPTION === "true";
const queueDirectory = path.join(root, "codex-queue");
const env = { ...process.env, PILOT_IMAGE: image, PILOT_PROOF_DIRECTORY: proofDirectory, PILOT_CODEX_QUEUE_DIRECTORY: queueDirectory };
const compose = ["compose", "--project-name", "joyce-work-schedule", "--project-directory", main,
  "--env-file", path.join(main, ".env.db.local"), "-f", path.join(main, "docker-compose.yml"),
  "-f", path.join(root, "runtime-compose.json"), "-f", path.resolve("deployment/shadow-pilot.yml")];
if (subscription) compose.push("-f", path.resolve("deployment/codex-subscription.yml"));
const docker = (args, timeout = 30000) => {
  try { return execFileSync("docker", args, { env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) {
    // Docker configuration and failed connection diagnostics may contain secrets.
    throw new Error(`Docker ${args[0]} operation failed (exit ${error.status ?? "timeout"}); no secret output was printed`);
  }
};
const config = JSON.parse(docker([...compose, "config", "--format", "json"]));
const actual = config.services.app.environment;
const expected = Object.fromEntries(Object.entries(runtime.services.app.environment).map(([key, value]) => [key, value.replace(/\$\$/g, "$")]));
Object.assign(expected, { APTLSS_MANAGER_PILOT_WORKER_IDS: String(pilotWorkerId), APTLSS_MANAGER_SHADOW_ONLY: "true",
  APTLSS_MANAGER_SCHEDULER: "true", APTLSS_SAFETY_ATTESTATION: "/app/pilot-proof/aptlss-safety.json" });
if (subscription) {
  Object.assign(expected, { APTLSS_MANAGER_PROVIDER: "codex-subscription", APTLSS_CODEX_QUEUE_DIR: "/app/codex-queue" });
  const mounts = config.services.app.volumes.filter(volume => volume.target === "/app/codex-queue");
  if (mounts.length !== 1 || mounts[0].type !== "bind" || path.resolve(mounts[0].source) !== queueDirectory || mounts[0].read_only) throw new Error("Only the private transport queue may be mounted for Codex");
  if (config.services.app.volumes.some(volume => /(?:codex-private|[\\/]\.codex(?:[\\/]|$)|auth\.json)/i.test(volume.source ?? ""))) throw new Error("Codex authentication and runner files must not enter the container");
  const heartbeat = JSON.parse(fs.readFileSync(path.join(queueDirectory, "heartbeat.json"), "utf8"));
  if (heartbeat.model !== "gpt-5.6-luna" || heartbeat.route !== "luna-adaptive-v1" || JSON.stringify(heartbeat.efforts) !== '["low","medium","high"]' || !Number.isFinite(Date.parse(heartbeat.at)) || Math.abs(Date.now() - Date.parse(heartbeat.at)) > 15000) throw new Error("Start the local adaptive Codex subscription runner before deployment");
}
const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(key => expected[key] !== String(actual[key] ?? ""));
if (changed.length) throw new Error(`Unexpected environment differences: ${changed.join(", ")}`);
if (config.services.app.image !== image) throw new Error("The configured application image does not match the selected image");
if (actual.NODE_ENV !== "production" || actual.LOCAL_AUTH_BYPASS !== "false") throw new Error("Production authentication must remain enabled");
const ports = config.services.app.ports;
if (ports.length !== 1 || ports[0].host_ip !== "127.0.0.1" || String(ports[0].published) !== "3025" || Number(ports[0].target) !== 3000) throw new Error("Existing loopback endpoint must be preserved");
if (!["check", "resume", "rollback"].includes(mode)) {
  const proof = JSON.parse(fs.readFileSync(path.join(proofDirectory, "aptlss-safety.json"), "utf8"));
  const verified = JSON.parse(docker(["run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e",
    "const f=require('fs'),c=require('crypto');const m=JSON.parse(f.readFileSync('dist/aptlss-build.json'));const bundleValid=m.bundleHash===c.createHash('sha256').update(f.readFileSync('dist/index.js')).digest('hex');const collectorPackageValid=m.collectorPackageHash===c.createHash('sha256').update(f.readFileSync('dist/public/downloads/worker-browser-collector.zip')).digest('hex');console.log(JSON.stringify({version:m.version,digest:m.digest,bundleValid,collectorPackageValid}))"], 60000));
  if (!isAptlssImageSafetyProofValid(proof, verified)) {
    throw new Error("The exact image must have matching shadow-pilot verification evidence");
  }
}
if (mode === "check") console.log(JSON.stringify({ configVerified: true, image, port: 3025, workerId: pilotWorkerId, mode: "shadow", credentialsPreserved: true }));
if (mode === "stop") {
  const current = JSON.parse(docker(["inspect", "joyce-work-schedule-app-1"]))[0];
  if (current.Image !== before.image) throw new Error("Application changed since capture; do not stop it");
  docker(["stop", "--time", "20", "joyce-work-schedule-app-1"], 60000);
  console.log("Only the dashboard application was stopped");
}
if (mode === "resume") {
  const containers = JSON.parse(docker(["inspect", "joyce-work-schedule-app-1"]));
  const images = JSON.parse(docker(["image", "inspect", image]));
  if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(images) || images.length !== 1)
    throw new Error("Existing application image or container could not be verified; refusing to resume");
  assertAptlssResumeConfiguration({
    container: containers[0],
    imageDetails: images[0],
    image,
    proofDirectory,
    pilotWorkerId,
  });
  docker(["start", "joyce-work-schedule-app-1"], 60000);
  console.log("Existing application container resumed");
}
if (mode === "migrate") {
  docker([...compose, "run", "--rm", "--no-deps", "--pull", "never", "migrate"], 180000);
  console.log("Additive operational migration completed");
}
if (mode === "deploy" || mode === "rollback") {
  docker([...compose, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"], 180000);
  console.log(JSON.stringify({ applicationRecreated: true, image, mode }));
}
