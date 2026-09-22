import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MANAGER_MODEL, CODEX_MANAGER_ROUTE, CODEX_MANAGER_EFFORTS, codexInputHash, codexReplySchema, managerSemanticProvider, requestManagerCodexReview } from "./aptlssManagerCodex";
import { codexAssessmentArgs, codexEnvironment, parseCodexAssessment, startCodexManagerRunner } from "./aptlssManagerCodexRunner";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
async function queue(at = new Date().toISOString()) {
  const dir = await mkdtemp(join(tmpdir(), "aptlss-codex-test-")); directories.push(dir);
  vi.stubEnv("APTLSS_CODEX_QUEUE_DIR",dir);
  await mkdir(join(dir,"requests")); await mkdir(join(dir,"replies"));
  await writeFile(join(dir,"heartbeat.json"),JSON.stringify({at,model:CODEX_MANAGER_MODEL,route:CODEX_MANAGER_ROUTE,efforts:CODEX_MANAGER_EFFORTS}));
  return dir;
}
const output = JSON.stringify({claims:[],actions:[],interventions:[]});
const completed = [JSON.stringify({type:"thread.started"}),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:output}}),JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}})];
describe("Codex subscription bridge", () => {
  it("starts Luna low with subscription auth and read-only tools-disabled execution", () => {
    const args=codexAssessmentArgs("C:\\private");
    expect(args).toEqual(expect.arrayContaining(["gpt-5.6-luna",'model_reasoning_effort="low"','forced_login_method="chatgpt"',"read-only","--ignore-user-config","--ephemeral","shell_tool","plugins","apps","hooks"]));
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  it("allows medium and high but rejects any higher effort", () => {
    expect(codexAssessmentArgs("private", "medium")).toContain('model_reasoning_effort="medium"');
    expect(codexAssessmentArgs("private", "high")).toContain('model_reasoning_effort="high"');
    expect(() => codexAssessmentArgs("private", "xhigh" as any)).toThrow();
  });
  it("never inherits API credentials, database secrets or custom provider URLs", () => {
    expect(codexEnvironment({PATH:"safe",USERPROFILE:"local",OPENAI_API_KEY:"private",CODEX_API_KEY:"private",DATABASE_URL:"private",OPENAI_BASE_URL:"bad",CODEX_HOME:"auth"}))
      .toEqual({PATH:"safe",USERPROFILE:"local",CODEX_HOME:"auth"});
  });
  it("accepts exactly one completed structured assistant result", () => { expect(parseCodexAssessment(completed).text).toBe(output); });
  it("accepts only known disabled-capability notices, not arbitrary errors", () => {
    expect(parseCodexAssessment([JSON.stringify({type:"item.completed",item:{type:"error",message:"Exceeded skills context budget. All skill descriptions were removed and 206 additional skills were not included in the model-visible skills list."}}),...completed]).text).toBe(output);
    expect(()=>parseCodexAssessment([JSON.stringify({type:"item.completed",item:{type:"error",message:"Authentication failed"}}),...completed])).toThrow();
  });
  it.each(["command_execution","mcp_tool_call","file_change","web_search"])("rejects %s events", type => {
    expect(()=>parseCodexAssessment([...completed,JSON.stringify({type:"item.completed",item:{type}})])).toThrow();
  });
  it("rejects incomplete and duplicate output", () => {
    expect(()=>parseCodexAssessment(completed.slice(0,2))).toThrow();
    expect(()=>parseCodexAssessment([...completed,completed[1]])).toThrow();
  });
  it("rejects a completion event before the output or a second completed turn", () => {
    expect(() => parseCodexAssessment([completed[0], completed[2], completed[1]])).toThrow();
    expect(() => parseCodexAssessment([...completed, completed[2]])).toThrow();
  });
  it.each([
    { status: "completed", outcomes: ["rejected"] },
    { status: "completed", outcomes: ["context_review"] },
    { status: "completed", outcomes: ["accepted", "accepted"] },
    { status: "unavailable", outcomes: ["accepted"] },
    { status: "rejected", outcomes: ["context_review"] },
  ])("rejects an inconsistent terminal status: $status / $outcomes", async ({ status, outcomes }) => {
    const dir = await queue();
    const trace = vi.fn();
    const pending = requestManagerCodexReview("{}", AbortSignal.timeout(5000), trace);
    const rejection = expect(pending).rejects.toThrow();
    let file = "";
    await vi.waitFor(async () => { file = (await readdir(join(dir, "requests"))).find(f => f.endsWith(".json")) ?? ""; expect(file).not.toBe(""); });
    const request = JSON.parse(await readFile(join(dir, "requests", file), "utf8"));
    const attempts = outcomes.map((outcome, index) => ({ effort: CODEX_MANAGER_EFFORTS[index], outcome, durationMs: 1 }));
    await writeFile(join(dir, "replies", file), JSON.stringify({ version: 2, id: request.id, inputHash: request.inputHash,
      model: CODEX_MANAGER_MODEL, route: CODEX_MANAGER_ROUTE, effort: attempts.at(-1)!.effort, attempts, status, text: output }));
    await rejection;
    expect(trace).not.toHaveBeenCalled();
  });
  it("fails closed on unknown provider", () => { vi.stubEnv("APTLSS_MANAGER_PROVIDER","typo"); expect(managerSemanticProvider).toThrow(); });
  it("rejects a stale local bridge before placing a job", async () => {
    const dir=await queue("2020-01-01T00:00:00Z");
    await expect(requestManagerCodexReview("{}",new AbortController().signal)).rejects.toThrow("offline");
    expect(await readdir(join(dir,"requests"))).toEqual([]);
  });
  it("never enqueues an already cancelled assessment", async () => {
    const dir = await queue();
    await expect(requestManagerCodexReview("{}", AbortSignal.abort())).rejects.toThrow();
    expect(await readdir(join(dir, "requests"))).toEqual([]);
  });
  it.each(["json", "pending"])("removes expired %s transport after an app crash without executing or touching unrelated files", async extension => {
    const dir = await queue();
    const work = await mkdtemp(join(tmpdir(), "aptlss-codex-private-test-")); directories.push(work);
    const id = "e5c21fbf-414b-42ee-838d-b0f33f71ee9a";
    const file = `${id}.json`;
    await writeFile(join(dir, "requests", `${id}.${extension}`), JSON.stringify({ version: 2, id, input: "{}", inputHash: codexInputHash("{}"),
      createdAt: new Date(Date.now() - 500_000).toISOString(), expiresAt: new Date(Date.now() - 100_000).toISOString() }));
    await writeFile(join(dir, "replies", file), "expired response");
    await writeFile(join(dir, "replies", `${file}.pending`), "interrupted response");
    await writeFile(join(dir, "requests", "unrelated.txt"), "preserve");
    const freshId = "19b468f1-9ed3-4695-9f44-4ae6c1583e42";
    await writeFile(join(dir, "requests", `${freshId}.pending`), JSON.stringify({ version: 2, id: freshId, input: "{}", inputHash: codexInputHash("{}"),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const controller = new AbortController();
    const runner = startCodexManagerRunner(dir, work, "must-not-execute", controller.signal);
    try {
      await vi.waitFor(async () => expect(await readdir(join(dir, "requests"))).toEqual([`${freshId}.pending`, "unrelated.txt"]));
      expect(await readdir(join(dir, "replies"))).toEqual([]);
      expect(await readFile(join(dir, "requests", "unrelated.txt"), "utf8")).toBe("preserve");
    } finally { controller.abort(); await runner; }
  });
  it.each(["completed", "rejected", "limited", "unauthenticated", "unavailable"])("accepts a consistent %s trace", status => {
    const attempts = CODEX_MANAGER_EFFORTS.map((effort, index) => ({ effort, durationMs: 1,
      outcome: index < 2 || status === "rejected" ? "context_review" : status === "completed" ? "accepted" : status,
      reason: index < 2 || status === "rejected" ? "chronology" : undefined }));
    expect(codexReplySchema.safeParse({ version: 2, id: "e5c21fbf-414b-42ee-838d-b0f33f71ee9a", inputHash: "a".repeat(64),
      model: CODEX_MANAGER_MODEL, route: CODEX_MANAGER_ROUTE, effort: "high", attempts, status,
      ...(status === "completed" ? { text: output } : {}) }).success).toBe(true);
  });
  it("keeps request identity and removes temporary files on cancellation", async () => {
    const dir=await queue(); const controller=new AbortController();
    const promise=requestManagerCodexReview("{}",controller.signal);
    const rejection=expect(promise).rejects.toThrow();
    await vi.waitFor(async()=>expect((await readdir(join(dir,"requests"))).some(f=>f.endsWith(".json"))).toBe(true));
    controller.abort(); await rejection;
    expect(await readdir(join(dir,"requests"))).toEqual([]);
  });
  it("consumes a matching bridge response without invoking an HTTP provider", async () => {
    const dir=await queue(); const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
    const promise=requestManagerCodexReview("{}",AbortSignal.timeout(5000));
    let file="";
    await vi.waitFor(async()=>{file=(await readdir(join(dir,"requests"))).find(f=>f.endsWith(".json"))??"";expect(file).not.toBe("");});
    const request=JSON.parse(await readFile(join(dir,"requests",file),"utf8"));
    expect(Date.parse(request.expiresAt)-Date.parse(request.createdAt)).toBe(420_000);
    await writeFile(join(dir,"replies",file),JSON.stringify({version:2,id:request.id,inputHash:request.inputHash,model:CODEX_MANAGER_MODEL,route:CODEX_MANAGER_ROUTE,effort:"low",attempts:[{effort:"low",outcome:"accepted",durationMs:1}],status:"completed",text:output}));
    expect((await (await promise).json()).status).toBe("completed"); expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(join(dir,"requests"))).toEqual([]);
  });
});
