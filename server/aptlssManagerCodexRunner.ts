import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CODEX_MANAGER_EFFORTS, CODEX_MANAGER_ROUTE, CODEX_MANAGER_MODEL, codexInputHash, codexReplySchema, codexRequestSchema, type CodexManagerEffort } from "./aptlssManagerCodex";
import { managerSemanticInstructions } from "./aptlssManagerModel";
import { codexAssessmentSchema, codexContextInstructions, runCodexCascade } from "./aptlssManagerCodexCascade";

const disabled = ["shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin", "hooks", "browser_use",
  "browser_use_external", "in_app_browser", "computer_use", "image_generation", "view_image", "multi_agent", "multi_agent_v2",
  "code_mode", "code_mode_host", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "goals", "sleep_tool"];
export function codexEnvironment(env: NodeJS.ProcessEnv) {
  const keys = ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"];
  return Object.fromEntries(keys.filter(key => env[key]).map(key => [key, env[key]!])) as NodeJS.ProcessEnv;
}
export function codexAssessmentArgs(work: string, effort: CodexManagerEffort = "low") {
  if (!CODEX_MANAGER_EFFORTS.includes(effort)) throw new Error("Unsupported reasoning effort");
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never",
    "-C", work, "-m", CODEX_MANAGER_MODEL, "-c", `model_reasoning_effort="${effort}"`, "-c", 'forced_login_method="chatgpt"',
    "-c", 'model_provider="openai"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", "agents.enabled=false",
    "-c", "mcp_servers={}", "-c", "plugins={}", "-c", "notify=[]", "-c", `model_instructions_file=${JSON.stringify(join(work, "instructions.txt"))}`,
    "-c", "skills.max_context_tokens=1", "-c", "memories.generate_memories=false", "-c", "memories.use_memories=false",
    "-c", "suppress_unstable_features_warning=true",
    ...disabled.flatMap(feature => ["--disable", feature]), "--enable", "skip_host_skill_discovery",
    "--output-schema", join(work, "schema.json"), "-"];
}
export function parseCodexAssessment(lines: string[]) {
  let completed = false, text: string | undefined, usage: any;
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line);
    if (completed) throw new Error("Unexpected event after completed turn");
    if (["thread.started", "turn.started"].includes(event.type)) continue;
    if (event.type === "turn.completed") {
      if (!text) throw new Error("Turn completed before assessment output");
      completed = true; usage = event.usage; continue;
    }
    if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      // These startup notices describe deliberately disabled capabilities, not failed inference.
      if (event.item?.type === "error" && event.type === "item.completed" && [
        "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.",
        "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
      ].includes(event.item.message)) continue;
      if (event.item?.type === "error" && event.type === "item.completed" &&
        /^Exceeded skills context budget\. All skill descriptions were removed and \d+ additional skills were not included in the model-visible skills list\.$/.test(event.item.message ?? "")) continue;
      if (!["agent_message", "reasoning"].includes(event.item?.type)) throw new Error("Tool output rejected");
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        if (text !== undefined) throw new Error("Multiple output messages rejected");
        text = event.item.text;
      }
      continue;
    }
    throw new Error("Unexpected Codex event");
  }
  if (!completed || !text || Buffer.byteLength(text) > 150_000) throw new Error("Incomplete Codex assessment");
  return { text, usage };
}

async function runAssessment(executable: string, work: string, input: string, effort: CodexManagerEffort, feedback: string, signal: AbortSignal) {
  return new Promise<{ text: string; usage?: any }>((accept, reject) => {
    const child = spawn(executable, codexAssessmentArgs(work, effort), { cwd: work, shell: false, windowsHide: true,
      env: codexEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", finished = false;
    const stop = () => child.kill();
    const timeout = setTimeout(stop, 120_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const onFailure = (error: Error) => { if (!finished) { finished = true; reject(error); } };
    child.on("error", () => onFailure(new Error("unavailable")));
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 500_000) { stop(); onFailure(new Error("rejected")); }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.on("close", code => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      if (finished) return;
      finished = true;
      if (signal.aborted) return reject(new Error("unavailable"));
      if (code !== 0) {
        const diagnostic = `${stderr}\n${stdout}`;
        return reject(new Error(/usage limit|rate limit|limit.*reached|insufficient_quota/i.test(diagnostic) ? "limited"
          : /not logged|unauthorized|authentication|sign in|login required/i.test(diagnostic) ? "unauthenticated" : "unavailable"));
      }
      try { accept(parseCodexAssessment(stdout.split(/\r?\n/))); }
      catch { reject(new Error("rejected")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`Extract only proposed claims from the following evidence JSON. Do not use tools or access any other data.\n${feedback}\n<untrusted_evidence>\n${input}\n</untrusted_evidence>`);
  });
}

export async function startCodexManagerRunner(root: string, work: string, executable: string, signal: AbortSignal) {
  root = resolve(root); work = resolve(work);
  if (root === work || work.startsWith(root + "/") || work.startsWith(root + "\\")) throw new Error("Private work directory must not be shared with the dashboard");
  await mkdir(root, { recursive: true });
  await mkdir(work, { recursive: true });
  const lock = join(work, "runner.lock");
  try {
    const pid = Number(await readFile(lock, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error("Runner already active"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await unlink(lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  const schema = z.toJSONSchema(codexAssessmentSchema) as Record<string, any>;
  delete schema.$schema; delete schema.properties.claims.default; schema.required = ["claims", "actions", "interventions", "contextCheck"];
  await writeFile(join(work, "schema.json"), JSON.stringify(schema), { mode: 0o600 });
  await writeFile(join(work, "instructions.txt"), managerSemanticInstructions + codexContextInstructions + " You are a read-only evidence classifier. No tools, browsing, file access, code execution, or external actions are allowed. Return only the requested JSON.", { mode: 0o600 });
  const requests = join(root, "requests"), replies = join(root, "replies");
  await mkdir(requests, { recursive: true }); await mkdir(replies, { recursive: true });
  let heartbeatBusy = false;
  const heartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await writeFile(join(root, "heartbeat.pending"), JSON.stringify({ at: new Date().toISOString(), model: CODEX_MANAGER_MODEL, route: CODEX_MANAGER_ROUTE, efforts: CODEX_MANAGER_EFFORTS }));
      await rename(join(root, "heartbeat.pending"), join(root, "heartbeat.json"));
    } finally { heartbeatBusy = false; }
  };
  await heartbeat();
  const interval = setInterval(() => void heartbeat().catch(() => {}), 3000);
  try {
    while (!signal.aborted) {
      const files = (await readdir(requests)).filter(name => /^[a-f0-9-]{36}\.(json|pending)$/.test(name)).sort();
      for (const file of files) {
        if (signal.aborted) break;
        const path = join(requests, file), replyPath = join(replies, file.replace(/\.pending$/, ".json"));
        try {
          if ((await stat(path)).size > 150_000) continue;
          const request = codexRequestSchema.parse(JSON.parse(await readFile(path, "utf8")));
          if (![`${request.id}.json`, `${request.id}.pending`].includes(file) || request.inputHash !== codexInputHash(request.input)) continue;
          const expiry = Date.parse(request.expiresAt);
          const lifetime = expiry - Date.parse(request.createdAt);
          if (lifetime <= 0 || lifetime > 420_000 || Date.parse(request.createdAt) > Date.now() + 5000) continue;
          if (expiry <= Date.now()) {
            // Recover only this validated request's expired transport, never evidence history.
            await Promise.all([path, join(requests, `${request.id}.pending`), replyPath, replyPath + ".pending"]
              .map(file => unlink(file).catch(() => {})));
            continue;
          }
          if (file.endsWith(".pending")) continue;
          try { await stat(replyPath); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const controller = new AbortController();
          const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
          const timeout = setTimeout(cancel, expiry - Date.now());
          const check = setInterval(() => void stat(path).catch(cancel), 1000);
          let reply: z.infer<typeof codexReplySchema> = { version: 2, id: request.id, inputHash: request.inputHash,
            model: CODEX_MANAGER_MODEL, route: CODEX_MANAGER_ROUTE, effort: "low", status: "unavailable",
            attempts: [{ effort: "low", outcome: "unavailable", durationMs: 0 }] };
          try {
            const auth = spawnSync(executable, ["login", "status"], { cwd: work, windowsHide: true, timeout: 10_000,
              env: codexEnvironment(process.env), encoding: "utf8" });
            if (auth.status !== 0 || !/Logged in using ChatGPT/i.test(`${auth.stdout}\n${auth.stderr}`)) throw new Error("unauthenticated");
            const result = await runCodexCascade(request.input, controller.signal, (effort, feedback, signal) => runAssessment(executable, work, request.input, effort, feedback, signal));
            reply = { ...reply, ...result };
          } catch (error) {
            const status = (error as Error).message;
            const failedStatus = status === "limited" || status === "unauthenticated" || status === "rejected" ? status : "unavailable";
            reply.status = failedStatus;
            reply.attempts = [{ effort: "low", outcome: failedStatus, durationMs: 0 }];
          } finally { clearTimeout(timeout); clearInterval(check); signal.removeEventListener("abort", cancel); }
          if (!controller.signal.aborted && Date.now() < expiry) {
            try { await stat(path); } catch { continue; }
            await writeFile(replyPath + ".pending", JSON.stringify(codexReplySchema.parse(reply)), { mode: 0o600 });
            await rename(replyPath + ".pending", replyPath);
            console.log(JSON.stringify({ at: new Date().toISOString(), id: request.id, model: CODEX_MANAGER_MODEL,
              effort: reply.effort, status: reply.status, attempts: reply.attempts }));
          }
        } catch { /* Invalid or concurrently cancelled transport files never execute. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { clearInterval(interval); await unlink(lock).catch(() => {}); }
}
