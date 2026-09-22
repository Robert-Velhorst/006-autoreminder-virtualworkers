import { describe, expect, it } from "vitest";
import { staticAssetCacheControl } from "./static";

describe("static asset caching", () => {
  it("marks Vite-hashed assets as immutable", () => {
    expect(staticAssetCacheControl("/assets/index-C_X69Id1.js")).toBe("public, max-age=31536000, immutable");
    expect(staticAssetCacheControl("/assets/index-laRCjF45.css")).toBe("public, max-age=31536000, immutable");
  });

  it("does not cache the application shell as an immutable asset", () => {
    expect(staticAssetCacheControl("/index.html")).toBe("no-cache");
    expect(staticAssetCacheControl("/favicon.ico")).toBe("no-cache");
  });
});
