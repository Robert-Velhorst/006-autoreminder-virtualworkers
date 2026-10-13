import { describe, expect, it } from "vitest";
import { staticAssetCacheControl, staticAssetResourcePolicy } from "./static";

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

describe("public app icon resource policy", () => {
  it("allows Trello to embed only the public PNG icon", () => {
    expect(staticAssetResourcePolicy("/icons/va-dashboard.png")).toBe("cross-origin");
  });

  it.each(["/index.html", "/worker", "/assets/index-C_X69Id1.js", "/icons/private.png", "/icons/va-dashboard.svg"])(
    "keeps %s same-origin", (requestPath) => {
      expect(staticAssetResourcePolicy(requestPath)).toBe("same-origin");
    }
  );
});
