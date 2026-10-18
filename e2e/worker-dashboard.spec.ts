import { expect, test } from "@playwright/test";
import { signInAsWorker } from "./helpers";

test("worker can navigate the core dashboard views", async ({ page }) => {
  await signInAsWorker(page);

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  const navigation = page.getByRole("navigation");
  await expect(navigation.getByRole("button", { name: /Plan My Day/ })).toBeVisible();
  await expect(navigation.getByRole("button", { name: /Decisions/ })).toBeVisible();
  await expect(navigation.getByRole("button", { name: /Evidence/ })).toBeVisible();

  await navigation.getByRole("button", { name: /Evidence/ }).click();
  await expect(page).toHaveURL(/\/worker\/evidence$/);
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
});
