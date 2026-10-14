import { expect, test } from "@playwright/test";
import { signInAsWorker } from "./helpers";

test("worker can navigate the core dashboard views", async ({ page }) => {
  await signInAsWorker(page);

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Plan My Day/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Decisions/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Evidence/ })).toBeVisible();

  await page.getByRole("button", { name: /Evidence/ }).click();
  await expect(page).toHaveURL(/\/worker\/evidence$/);
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
});
