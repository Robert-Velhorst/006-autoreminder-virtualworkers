import { expect, test } from "@playwright/test";

// A public tunnel can add a few seconds before the unauthenticated auth.me
// request completes. Keep the route gate meaningful without making it flaky.
const AUTH_GATE_TIMEOUT_MS = 10_000;

const protectedPortalRoutes = [
  "/",
  "/aptlss",
  "/settings",
  "/calendar",
  "/advanced-scheduling",
  "/atis-phases",
  "/founder",
  "/robert",
  "/command-center",
  "/admin",
  "/worker",
  "/worker/plan",
  "/worker/decisions",
  "/worker/evidence",
  "/worker/reminders",
  "/worker/settings",
];

test.describe("protected portal entry points", () => {
  for (const route of protectedPortalRoutes) {
    test(`${route} requires authentication without a client error`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(route);

      await expect(page.getByLabel("Username")).toBeVisible({ timeout: AUTH_GATE_TIMEOUT_MS });
      await expect(page.getByLabel("Password")).toBeVisible({ timeout: AUTH_GATE_TIMEOUT_MS });
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible({ timeout: AUTH_GATE_TIMEOUT_MS });
      expect(errors).toEqual([]);
    });
  }
});
