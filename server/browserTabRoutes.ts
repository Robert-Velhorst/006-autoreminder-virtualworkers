import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  BrowserTabCollectorConflictError,
  ingestBrowserTabInventory,
  resolveBrowserTabCollectorUserOpenId,
  resolveBrowserTabCollectorWorker,
} from "./browserTabHygiene";
import { websocketService } from "./services/websocket";

const inventorySchema = z.object({
  protocolVersion: z.literal(2),
  collectorId: z.string().trim().min(1).max(128),
  captureSequence: z.number().int().min(1).max(4_294_967_295),
  sourceCapturedAt: z.string().datetime(),
  collectorLabel: z.string().trim().min(1).max(128).optional(),
  tabs: z.array(z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    title: z.string().max(2_000),
    url: z.string().max(8_000),
    pinned: z.boolean(),
    active: z.boolean(),
    windowId: z.number().int(),
  })).max(250),
});

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
      if (!status.staleIgnored) {
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
