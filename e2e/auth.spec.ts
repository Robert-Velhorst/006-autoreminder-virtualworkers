import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, signInAsWorker } from "./helpers";

test.describe("Authentication", () => {
  test("shows the sign-in form on a protected worker page", async ({
    page,
  }) => {
    await page.goto("/worker");

    await expect(
      page.getByRole("heading", { name: "VA Dashboard" })
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible();
  });

  test("rejects an unknown username without disclosing account existence", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill(`missing-${Date.now()}`);
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(
      page.getByText("Invalid username or password").first()
    ).toBeVisible();
  });

  test("authenticates the CI worker account", async ({ page }) => {
    await signInAsWorker(page);

    await expect(page).toHaveURL(/\/worker$/);
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  });

  test("does not let a worker open an administrator route", async ({
    page,
  }) => {
    await signInAsWorker(page);
    await page.goto("/settings");

    await expect(page).toHaveURL(/\/worker$/);
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  });
});
