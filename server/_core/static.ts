import express, { type Express } from "express";
import fs from "fs";
import path from "path";

const HASHED_ASSET_PATH = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|ttf|svg|png|jpe?g|webp|avif)$/;

export function staticAssetCacheControl(requestPath: string) {
  return HASHED_ASSET_PATH.test(requestPath)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

export function staticAssetResourcePolicy(requestPath: string) {
  return requestPath === "/icons/va-dashboard.png" ? "cross-origin" : "same-origin";
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath, {
    setHeaders(res, filePath) {
      const requestPath = `/${path.relative(distPath, filePath).replace(/\\/g, "/")}`;
      res.setHeader("Cache-Control", staticAssetCacheControl(requestPath));
      res.setHeader("Cross-Origin-Resource-Policy", staticAssetResourcePolicy(requestPath));
    },
  }));

  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
