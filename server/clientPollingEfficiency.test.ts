import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

describe("legacy client polling", () => {
  it("does not refresh notification or job-detail APIs while the dashboard is inactive", () => {
    const notificationBell = fs.readFileSync(
      path.join(workspaceRoot, "client/src/components/NotificationBell.tsx"),
      "utf8",
    );
    const aptlssManagement = fs.readFileSync(
      path.join(workspaceRoot, "client/src/pages/APTLSSManagement.tsx"),
      "utf8",
    );
    const performanceMetrics = fs.readFileSync(
      path.join(workspaceRoot, "client/src/components/PerformanceMetrics.tsx"),
      "utf8",
    );

    expect(notificationBell).toContain("document.visibilityState === 'visible'");
    expect(notificationBell).toContain("visibilitychange");
    expect(aptlssManagement).toContain("selectedJob?.status !== \"running\"");
    expect(performanceMetrics).toContain("document.visibilityState === 'visible'");
    expect(performanceMetrics).toContain("visibilitychange");
  });
});
