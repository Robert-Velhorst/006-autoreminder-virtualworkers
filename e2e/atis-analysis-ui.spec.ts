import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import superjson from "superjson";
import type { AtisAnalysisJob, AtisAnalysisPreview, AtisAnalysisSelection } from "../shared/atisAnalysis";

let bundle: string;
let styles: string;
const id = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const preview = (extra: Partial<AtisAnalysisPreview> = {}): AtisAnalysisPreview => ({ id, expiresAt: "2099-10-21T12:10:00Z", total: 2, matched: 5, remaining: 3, nextAfterCardId: 2,
  cards: [{ id: 1, name: "Review receipt" }, { id: 2, name: "Confirm delivery" }], ...extra });
const job = (state: AtisAnalysisJob["state"] = "running", extra: Partial<AtisAnalysisJob> = {}): AtisAnalysisJob => ({ id, state, total: 2, matched: 5, remaining: 3, nextAfterCardId: 2,
  processed: state === "completed" ? 2 : 0, generated: state === "completed" ? 1 : 0, fallback: state === "completed" ? 1 : 0, missing: 0, failed: 0, uncertain: 0, pending: state === "completed" ? 0 : 2,
  items: [{ cardId: 1, cardName: "Review receipt", state: state === "completed" ? "generated" : "calling" }, { cardId: 2, cardName: "Confirm delivery", state: state === "completed" ? "fallback" : "pending" }], ...extra });
test.beforeAll(async () => {
  const root = resolve(import.meta.dirname, "..");
  const tailwindRequire = createRequire(createRequire(resolve(root, "package.json")).resolve("@tailwindcss/vite"));
  const { compile } = await import(pathToFileURL(tailwindRequire.resolve("@tailwindcss/node")).href);
  const { Scanner } = await import(pathToFileURL(tailwindRequire.resolve("@tailwindcss/oxide")).href);
  const compiler = await compile(await readFile(resolve(root, "client/src/index.css"), "utf8"), { base: resolve(root, "client/src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(root, "client/src"), pattern: "**/*.{tsx,ts}", negated: false }] });
  styles = compiler.build(scanner.scan());
  const result = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {httpLink} from '@trpc/client';
    import superjson from 'superjson'; import {trpc} from '@/lib/trpc';
    import {AtisAnalysisDialog} from '@/components/AtisAnalysisDialog'; import {TaskCard} from '@/components/TaskCard'; import {ReanalysisProgressModal} from '@/components/ReanalysisProgressModal';
    import {TooltipProvider} from '@/components/ui/tooltip';
    const queries=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
    const rpc=trpc.createClient({links:[httpLink({url:'/api/trpc',transformer:superjson})]});
    window.refreshActor=()=>queries.invalidateQueries(); window.completed=[];
    function Harness({selection:initialSelection,card}) { const [open,setOpen]=useState(true); const [selection,setSelection]=useState(initialSelection); window.changeSelection=setSelection; return card==='board' ? <ReanalysisProgressModal open={open} onOpenChange={setOpen} preselectedBoardId="7"/> : card ? <TaskCard task={card} onToggle={()=>{}} isExpanded/> :
      <><button onClick={()=>setOpen(true)}>Open analysis</button><AtisAnalysisDialog open={open} onOpenChange={setOpen} selection={selection} resumeOnMount
        onCompleted={job=>{window.completed.push(job.id)}}/></>; }
    window.mountAnalysis=(selection,card)=>createRoot(document.getElementById('root')).render(
      <trpc.Provider client={rpc} queryClient={queries}><QueryClientProvider client={queries}><TooltipProvider><Harness selection={selection} card={card}/></TooltipProvider></QueryClientProvider></trpc.Provider>);
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": resolve(root, "client/src"), "@shared": resolve(root, "shared") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" } });
  bundle = result.outputFiles[0].text;
});
type Call = { path: string; method: string; body: any };
async function fixture(page: Page, options: { recovery?: boolean; single?: boolean; ambiguous?: boolean; longName?: boolean; expiredNext?: boolean } = {}) {
  const calls: Call[] = []; const errors: string[] = [];
  const state = { actor: 1, status: job(), missing: false, next: false, nextPreviews: 0, hold: false, release: () => {} };
  let release: () => void;
  const held = new Promise<void>(resolvePromise => { release = resolvePromise; });
  state.release = () => { state.hold = false; release(); };
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== "http://localhost:4199") { errors.push("Unexpected external request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' });
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    calls.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === "/api/trpc/auth.me") return route.fulfill({ json: { result: { data: superjson.serialize({ id: state.actor, name: "Synthetic Admin", role: "admin", openId: `test-${state.actor}` }) } } });
    if (url.pathname === "/api/atis/understanding/preview") {
      state.next = body.selection.afterCardId !== undefined;
      if (state.next) state.nextPreviews++;
      const shortExpiry = state.next && options.expiredNext && state.nextPreviews === 1 ? new Date(await page.evaluate(() => Date.now()) + 2000).toISOString() : undefined;
      if (body.selection.boardId && body.selection.forceAll) { errors.push("Invalid board/forceAll combination"); return route.fulfill({ status: 400, json: { error: "Invalid selection" } }); }
      return route.fulfill({ json: { preview: preview({ ...(state.next ? { id: nextId } : {}), ...(shortExpiry ? { expiresAt: shortExpiry } : {}), ...(options.recovery ? { recoveryOperationId: 77 } : {}),
        ...(body.selection.mode === "single" ? { total: 1, matched: 1, remaining: 0, cards: [{ id: body.selection.cardId, name: body.selection.cardId === 1 ? "Review receipt" : `Requested card ${body.selection.cardId}` }] } : {}),
        ...(options.longName ? { cards: [{ id: 1, name: "LongUnbrokenCardName".repeat(30) }, { id: 2, name: "Confirm delivery" }] } : {}),
        ...(state.actor === 2 ? { cards: [{ id: 1, name: "New actor card" }], total: 1, matched: 1, remaining: 0 } : {}) }) } });
    }
    if (url.pathname === "/api/atis/understanding/process") {
      if (options.ambiguous) return route.abort("failed");
      if (options.single) state.status = job("running", { total: 1, matched: 1, remaining: 0, pending: 1, items: [{ cardId: 1, cardName: "Review receipt", state: "calling" }] });
      return route.fulfill({ status: 202, json: { analysis: state.status } });
    }
    if (url.pathname.startsWith("/api/atis/understanding/analyses/")) {
      if (state.hold) await held;
      return route.fulfill({ status: state.missing ? 404 : 200, json: state.missing ? { error: "Not found" } : { analysis: state.status } });
    }
    if (url.pathname === "/api/atis/card/1/understanding") return route.fulfill({ json: { aptlssChecklist: JSON.stringify([{ name: state.status.state === "completed" ? "Saved new plan" : "Existing saved plan", estimatedMinutes: 5 }]) } });
    if (url.pathname === "/api/time-tracking/active") return route.fulfill({ json: { active: false, entry: null } });
    if (url.pathname === "/api/time-tracking/task/task-1") return route.fulfill({ json: { totalMinutes: 0, totalSeconds: 0, complete: true, unresolvedEntryCount: 0 } });
    if (/conversation|checklist\/status/.test(url.pathname)) return route.fulfill({ json: { completedSteps: [], counts: {} } });
    if (url.pathname === "/api/atis/cards/by-trello/trello-1") return route.fulfill({ json: { id: 1 } });
    errors.push(`Unexpected path ${url.pathname}`); return route.abort();
  });
  const selection: AtisAnalysisSelection = { mode: options.single ? "single" : "reanalyze", ...(options.single ? { cardId: 1, guidance: { goal: "Verified goal", deliverable: "Receipt", successCriteria: ["Confirmed"] } } : { boardId: 7 }), limit: options.single ? 1 : 100 };
  const mount = async (card?: unknown, selected = selection) => {
    await page.goto("http://localhost:4199/"); await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle });
    await page.evaluate(({ selection, card }) => (window as any).mountAnalysis(selection, card), { selection: selected, card });
  };
  return { calls, state, errors, mount, confirms: () => calls.filter(call => call.body?.phase === "confirm") };
}

test("preview is DB-only; explicit confirm polls actual per-card outcomes, then separately previews next batch", async ({ page }) => {
  const f = await fixture(page); await f.mount();
  await expect(page.getByText("2 selected of 5 matched. 3 remain outside this batch.")).toBeVisible(); expect(f.confirms()).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible(); expect(await page.evaluate(() => (window as any).completed)).toEqual([]);
  f.state.hold = true; await page.clock.fastForward(2100);
  await expect.poll(() => f.calls.filter(call => call.path.includes("/analyses/")).length).toBe(1);
  await page.clock.fastForward(6000); expect(f.calls.filter(call => call.path.includes("/analyses/"))).toHaveLength(1);
  f.state.status = job("completed"); f.state.release();
  await expect(page.getByText(/1 plans ready.*1 need review/)).toBeVisible(); await expect(page.getByText(/Matching cards remain/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toEqual([id]);
  await page.getByRole("button", { name: "Preview next batch" }).click();
  await expect(page.getByRole("button", { name: "Confirm analysis of 2 cards" })).toBeVisible();
  expect(f.calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body.selection).toEqual({ mode: "reanalyze", boardId: 7, limit: 100, afterCardId: 2 });
  expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("reload observes persisted job by GET without preview/confirmation and pause never cancels server work", async ({ page }) => {
  const f = await fixture(page); await f.mount(); await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("atis-analysis:v1:1:admin"))).toBe(id);
  const count = f.calls.length; await f.mount(); await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  expect(f.calls.slice(count).filter(call => call.path.includes("understanding")).every(call => call.method === "GET")).toBe(true);
  await page.getByRole("button", { name: "Pause status checks" }).click();
  await expect(page.getByText("Status checks stopped. Server work has not been cancelled.")).toBeVisible();
  const reads = f.calls.length; await page.clock.fastForward(20_000); expect(f.calls.length).toBe(reads); expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("interrupted recovery requires its separate default-off acknowledgement", async ({ page }) => {
  const f = await fixture(page, { recovery: true }); await f.mount();
  const start = page.getByRole("button", { name: "Acknowledge and start 2 cards" }); await expect(start).toBeDisabled();
  expect(f.confirms()).toHaveLength(0);
  await page.getByRole("checkbox", { name: "I reviewed the interrupted operation and accept starting this batch" }).check();
  await start.click(); await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  expect(f.confirms()[0].body.acknowledgeInterruptedOperationId).toBe(77); expect(f.errors).toEqual([]);
});

test("ambiguous POST followed by 404 is not permission to replay; new preview needs explicit unknown-outcome acknowledgement", async ({ page }) => {
  const f = await fixture(page, { ambiguous: true }); await f.mount(); await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click();
  await expect(page.getByRole("button", { name: "Check analysis status" })).toBeEnabled(); f.state.missing = true;
  await page.getByRole("button", { name: "Check analysis status" }).click(); await expect(page.getByText(/original request could still commit or incur usage/)).toBeVisible();
  const review = page.getByRole("button", { name: "Review a new preview despite unknown outcome" }); await expect(review).toBeDisabled();
  await page.clock.fastForward(20_000); expect(f.confirms()).toHaveLength(1);
  await page.getByRole("checkbox", { name: /I accept that the prior outcome is unknown/ }).check(); await review.click();
  await expect(page.getByRole("button", { name: "Confirm analysis of 2 cards" })).toBeEnabled(); expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("interview guidance is previewed; actor change clears prior job context without confirming new work", async ({ page }) => {
  const f = await fixture(page, { single: true }); await f.mount(); await expect(page.getByRole("button", { name: "Confirm analysis of 1 card", exact: true })).toBeEnabled();
  expect(f.calls.find(call => call.path.endsWith("/preview"))?.body.selection.guidance).toEqual({ goal: "Verified goal", deliverable: "Receipt", successCriteria: ["Confirmed"] });
  await page.getByRole("button", { name: "Confirm analysis of 1 card", exact: true }).click(); await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  const count = f.calls.length; f.state.actor = 2; await page.evaluate(() => (window as any).refreshActor());
  await expect(page.getByText("New actor card", { exact: true })).toBeVisible();
  await expect(page.getByText("Review receipt", { exact: true })).toHaveCount(0);
  expect(f.calls.slice(count).filter(call => call.path.includes("/analyses/"))).toHaveLength(0); expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("TaskCard loads the actual saved understanding only after completed admission, never from its 202", async ({ page }) => {
  const f = await fixture(page, { single: true }); await f.mount({ id: "task-1", atisCardId: 1, cardId: "trello-1", cardName: "Receipt card", durationHours: 1, hasUnderstanding: true,
    checklist: [{ id: "old", step: "Old plan", timeMinutes: 10 }], attachments: [], isCompleted: false });
  await expect(page.getByText("Existing saved plan", { exact: true })).toBeVisible();
  const initialReads = f.calls.filter(call => call.path === "/api/atis/card/1/understanding").length;
  await page.getByRole("button", { name: "Re-analyze", exact: true }).click(); await page.getByRole("button", { name: "Confirm analysis of 1 card", exact: true }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible(); expect(f.calls.filter(call => call.path === "/api/atis/card/1/understanding")).toHaveLength(initialReads);
  f.state.status = job("completed", { total: 1, matched: 1, remaining: 0, processed: 1, generated: 1, fallback: 0, items: [{ cardId: 1, cardName: "Review receipt", state: "generated" }] }); await page.clock.fastForward(2100);
  await expect(page.getByText("Saved new plan", { exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/api/atis/card/1/understanding")).toHaveLength(initialReads + 1); expect(f.errors).toEqual([]);
});

test("closing a retained active analysis stays closed until manually reopened", async ({ page }) => {
  const f = await fixture(page); await f.mount(); await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  const count = f.calls.length; await page.clock.fastForward(20_000); await expect(page.getByRole("dialog")).toHaveCount(0); expect(f.calls).toHaveLength(count);
  await page.getByRole("button", { name: "Open analysis" }).click(); await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("opening single-card B observes retained A without attributing completion or continuing A's cursor", async ({ page }) => {
  const f = await fixture(page);
  f.state.status = job("completed", { total: 1, matched: 4, remaining: 3, processed: 1, generated: 1, fallback: 0, items: [{ cardId: 1, cardName: "Retained card A", state: "generated" }] });
  await page.addInitScript(value => sessionStorage.setItem("atis-analysis:v1:1:admin", value), id);
  await f.mount(undefined, { mode: "single", cardId: 99, limit: 1 });
  await expect(page.getByText("Retained card A", { exact: true })).toBeVisible();
  await expect(page.getByText(/Showing an existing analysis/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toEqual([]);
  await expect(page.getByRole("button", { name: "Preview next batch" })).toHaveCount(0);
  expect(f.calls.filter(call => call.path.endsWith("/preview"))).toHaveLength(0); expect(f.confirms()).toHaveLength(0); expect(f.errors).toEqual([]);
});

test("caller selection change during an owned job drops attribution and cannot mix old cursor with new filters", async ({ page }) => {
  const f = await fixture(page); await f.mount(); await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  await page.evaluate(() => (window as any).changeSelection({ mode: "single", cardId: 99, limit: 1 }));
  await expect(page.getByText(/Showing an existing analysis/)).toBeVisible();
  f.state.status = job("completed"); await page.clock.fastForward(2100);
  await expect(page.getByText(/Batch finished\./)).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toEqual([]);
  await expect(page.getByRole("button", { name: "Preview next batch" })).toHaveCount(0);
  expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("own admitted single A cannot complete the current single B callback", async ({ page }) => {
  const f = await fixture(page, { single: true }); await f.mount();
  await page.getByRole("button", { name: "Confirm analysis of 1 card", exact: true }).click();
  await expect(page.getByText(/Analysis in progress/)).toBeVisible();
  await page.evaluate(() => (window as any).changeSelection({ mode: "single", cardId: 99, limit: 1 }));
  await expect(page.getByText(/Showing an existing analysis/)).toBeVisible();
  f.state.status = job("completed", { total: 1, matched: 1, remaining: 0, processed: 1, generated: 1, fallback: 0,
    items: [{ cardId: 1, cardName: "Review receipt", state: "generated" }] });
  await page.clock.fastForward(2100); await expect(page.getByText(/Batch finished\./)).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toEqual([]);
  expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("changing an unconfirmed single selection replaces its old preview without submitting it", async ({ page }) => {
  const f = await fixture(page, { single: true }); await f.mount();
  await expect(page.getByText("Review receipt", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).changeSelection({ mode: "single", cardId: 99, limit: 1 }));
  await expect(page.getByText("Requested card 99", { exact: true })).toBeVisible();
  await expect(page.getByText("Review receipt", { exact: true })).toHaveCount(0);
  expect(f.calls.filter(call => call.path.endsWith("/preview")).map(call => call.body.selection.cardId)).toEqual([1, 99]);
  expect(f.confirms()).toHaveLength(0); expect(f.errors).toEqual([]);
});

test("board-specific wrapper omits forceAll and never confirms until reviewed", async ({ page }) => {
  const f = await fixture(page); await f.mount("board"); await expect(page.getByRole("button", { name: "Confirm analysis of 2 cards" })).toBeEnabled();
  expect(f.calls.find(call => call.path.endsWith("/preview"))?.body.selection).toEqual({ mode: "reanalyze", boardId: 7, limit: 100 });
  expect(f.confirms()).toHaveLength(0); expect(f.errors).toEqual([]);
});

test("expired next-batch preview refresh retains its cursor and does not replay the finished batch", async ({ page }) => {
  const f = await fixture(page, { expiredNext: true }); await f.mount(); f.state.status = job("completed");
  await page.getByRole("button", { name: "Confirm analysis of 2 cards" }).click(); await page.getByRole("button", { name: "Preview next batch" }).click();
  await page.clock.fastForward(4000); await page.getByRole("button", { name: "Refresh expired preview" }).click();
  await expect(page.getByRole("button", { name: "Confirm analysis of 2 cards" })).toBeEnabled();
  expect(f.calls.filter(call => call.path.endsWith("/preview")).slice(1).map(call => call.body.selection.afterCardId)).toEqual([2, 2]);
  expect(f.confirms()).toHaveLength(1); expect(f.errors).toEqual([]);
});

for (const width of [390, 1280]) test(`recovery preview fits ${width}px with long card names and business labels`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await fixture(page, { recovery: true, longName: true }); await f.mount();
  await expect(page.getByRole("button", { name: "Acknowledge and start 2 cards" })).toBeDisabled();
  expect(f.confirms()).toHaveLength(0);
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`analysis-preview-${width}.png`), fullPage: true });
  await page.getByRole("checkbox", { name: "I reviewed the interrupted operation and accept starting this batch" }).check();
  await page.getByRole("button", { name: "Acknowledge and start 2 cards" }).click();
  await expect(page.getByText("Analyzing", { exact: true })).toBeVisible(); await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(f.confirms()[0].body.acknowledgeInterruptedOperationId).toBe(77); expect(f.errors).toEqual([]);
});
