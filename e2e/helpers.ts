import { expect, type Page } from "@playwright/test";

export const E2E_USERNAME = "va-dashboard-ci-worker";
export const E2E_PASSWORD = "ci-only-worker-password";

export async function signInAsWorker(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(E2E_USERNAME);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/worker$/);
}
