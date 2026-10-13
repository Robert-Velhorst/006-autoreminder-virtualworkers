import type { Express } from "express";
import { z } from "zod";
import { getHaiWorkerControlFeed, resolveHaiConnectorOwner } from "./haiConnector";

const feedQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerHaiConnectorRoutes(app: Express) {
  app.get("/api/integrations/hai/feed", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const authorization = req.header("authorization") ?? "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      const workspaceOwnerId = await resolveHaiConnectorOwner(match?.[1]?.trim());
      if (!workspaceOwnerId) {
        res.status(401).json({ error: "HAI connector authorization failed" });
        return;
      }
      const input = feedQuery.parse(req.query);
      res.json(await getHaiWorkerControlFeed(workspaceOwnerId, input.cursor, input.limit));
    } catch (error) {
      const invalid = error instanceof z.ZodError || (error instanceof Error && error.message === "Invalid HAI feed cursor");
      res.status(invalid ? 400 : 503).json({
        error: invalid ? "Invalid HAI feed request" : "HAI feed is temporarily unavailable",
      });
    }
  });
}
