import { expect, test } from "@playwright/test";

test.describe("worker portal login", () => {
  test("renders the local and Trello sign-in options without a console error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto("/worker");

    const username = page.getByLabel("Username");
    const password = page.getByLabel("Password");
    const localSignIn = page.getByRole("button", { name: "Sign in", exact: true });
    const trelloSignIn = page.getByRole("button", { name: "Sign in with Trello", exact: true });

    await expect(username).toBeVisible();
    await expect(password).toBeVisible();
    await expect(localSignIn).toBeVisible();
    await expect(trelloSignIn).toBeVisible();
    await expect(page).toHaveTitle(/VA Task Dashboard/);
    expect(errors).toEqual([]);
  });
});
