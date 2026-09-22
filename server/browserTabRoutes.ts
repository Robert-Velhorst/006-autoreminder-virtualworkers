import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  ingestBrowserTabInventory,
  resolveBrowserTabCollectorUserOpenId,
  resolveBrowserTabCollectorWorker,
} from "./browserTabHygiene";
import { websocketService } from "./services/websocket";

const inventorySchema = z.object({
  collectorId: z.string().trim().min(1).max(128),
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
      const input = inventorySchema.parse(req.body);
      const status = await ingestBrowserTabInventory(vaId, input);
      const workerOpenId = await resolveBrowserTabCollectorUserOpenId(vaId);
      if (workerOpenId) {
        websocketService.emitToUser(workerOpenId, "browser-tabs:invalidate", {
          vaId,
          capturedAt: new Date().toISOString(),
        });
      }
      res.json({
        success: true,
        status: status.status,
        actionableTabs: status.actionableTabs,
        allowedTabs: status.allowedTabs,
        shouldWarn: status.shouldWarn,
      });
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      res.status(invalid ? 400 : 503).json({
        success: false,
        error: invalid ? "Invalid browser inventory" : "Browser inventory could not be recorded. Retry shortly.",
      });
    }
  });
}
