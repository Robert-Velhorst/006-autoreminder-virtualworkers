import compression from "compression";
import type { Express } from "express";

export function configureCompression(app: Express) {
  app.use(compression({ threshold: 1024 }));
}
