import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  BrowserTabCollectorConflictError,
  ingestBrowserTabInventory,
  isBrowserTabCaptureTimestampSupported,
  resolveBrowserTabCollectorUserOpenId,
  resolveBrowserTabCollectorWorker,
} from "./browserTabHygiene";
import { websocketService } from "./services/websocket";
import { MAX_BROWSER_TAB_CAPTURE_SEQUENCE } from "../shared/browserTabProtocol";
import { browserTabLabelFromOrigin, normalizeBrowserTabOrigin } from "../shared/browserTabPolicy";

const browserTabIdSchema = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,16}$/)
    .refine((value) => Number.isSafeInteger(Number(value)))
    .transform(Number),
]).transform(String);

const browserTabUrlSchema = z.string().max(2_048)
  .refine((value) => normalizeBrowserTabOrigin(value) !== null, "Unsupported browser tab URL")
  .transform((value) => normalizeBrowserTabOrigin(value) as string);
const browserTabSourceCapturedAtSchema = z.string().datetime()
  .refine(isBrowserTabCaptureTimestampSupported, "Unsupported browser capture time");

const browserTabSchema = z.object({
  id: browserTabIdSchema,
  title: z.string().max(512),
  url: browserTabUrlSchema,
  pinned: z.boolean(),
  active: z.boolean(),
  windowId: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
}).strict().transform(({ title: _untrustedTitle, ...tab }) => ({
  ...tab,
  title: browserTabLabelFromOrigin(tab.url),
}));
const browserTabsSchema = z.array(browserTabSchema).max(250).superRefine((tabs, context) => {
  const ids = new Set<string>();
  tabs.forEach((tab, index) => {
    if (ids.has(tab.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: "Duplicate browser tab ID",
      });
      return;
    }
    ids.add(tab.id);
  });
});

const inventorySchema = z.object({
  protocolVersion: z.literal(2),
  collectorId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  captureSequence: z.number().int().min(1).max(MAX_BROWSER_TAB_CAPTURE_SEQUENCE),
  sourceCapturedAt: browserTabSourceCapturedAtSchema,
  collectorLabel: z.string().trim().min(1).max(128).optional(),
  tabs: browserTabsSchema,
}).strict();

function allowExtensionOrigin(req: Request, res: Response) {
  const origin = req.headers.origin;
  if (origin?.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

export function registerBrowserTabRoutes(app: Express) {
  app.options("/api/browser-tabs/ingest", (req, res) => {
    allowExtensionOrigin(req, res);
    res.status(204).end();
  });

  app.post("/api/browser-tabs/ingest", async (req, res) => {
    allowExtensionOrigin(req, res);
    try {
      const authorization = req.header("authorization") ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
      const vaId = await resolveBrowserTabCollectorWorker(token);
      if (!vaId) {
        res.status(401).json({ success: false, error: "Browser collector authorization failed" });
        return;
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || req.body.protocolVersion !== 2) {
        res.status(426).json({ success: false, error: "Browser collector update required. Download the latest collector from worker Settings." });
        return;
      }
      const input = inventorySchema.parse(req.body);
      const status = await ingestBrowserTabInventory(vaId, input);
      if (status.changed && !status.staleIgnored) {
        const workerOpenId = await resolveBrowserTabCollectorUserOpenId(vaId);
        if (workerOpenId) {
          websocketService.emitToUser(workerOpenId, "browser-tabs:invalidate", {
            vaId,
            capturedAt: status.capturedAt?.toISOString() ?? new Date().toISOString(),
          });
        }
      }
      res.json({
        success: true,
        status: status.status,
        actionableTabs: status.actionableTabs,
        allowedTabs: status.allowedTabs,
        shouldWarn: status.shouldWarn,
        staleIgnored: status.staleIgnored,
        storedCaptureSequence: status.storedCaptureSequence,
      });
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      const conflict = error instanceof BrowserTabCollectorConflictError;
      res.status(conflict ? 409 : invalid ? 400 : 503).json({
        success: false,
        error: conflict
          ? "Collector identity conflict. Re-pair the browser from worker Settings."
          : invalid ? "Invalid browser inventory" : "Browser inventory could not be recorded. Retry shortly.",
      });
    }
  });
}
