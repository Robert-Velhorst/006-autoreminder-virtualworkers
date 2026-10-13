import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import superjson from "superjson";

const SOURCE_REVIEW_REASON =
  "This Gmail item only announces portal correspondence; verify the underlying document and its deadline before sending a reminder.";

function reminderRow(
  id: number,
  title: string,
  state: string,
  options: {
    sourceType?: string;
    error?: string | null;
    policyReason?: string | null;
    sourceUrl?: string | null;
  } = {}
) {
  return {
    commitment: {
      id,
      title,
      context: null,
      dueAt: "2026-09-27T12:00:00.000Z",
      status: "open",
      sourceType: options.sourceType ?? "manual",
      sourceId: `source-${id}`,
      sourceUrl: options.sourceUrl ?? null,
    },
    schedule: {
      id,
      commitmentId: id,
      ruleId: id,
      recipientUserId: 2,
      scheduledFor: "2026-09-27T11:00:00.000Z",
      channel: "email",
      state,
      error: options.error ?? null,
      policyReason: options.policyReason ?? null,
      draftContent:
        state === "draft_ready"
          ? "Please review this follow-up before sending."
          : null,
      draftTitle: null,
    },
    rule: { id, name: `Reminder ${id}` },
  };
}

async function mockWorkerReminders(page: Page, dashboardError?: string) {
  const rows = [
    reminderRow(1, "SKGZ portal notice follow-up", "needs_review", {
      sourceType: "gmail",
      error: SOURCE_REVIEW_REASON,
      policyReason: SOURCE_REVIEW_REASON,
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-1",
    }),
    reminderRow(2, "Invoice approval follow-up", "draft_ready"),
    reminderRow(3, "Recipient address follow-up", "failed", {
      error: "Recipient has no email address",
    }),
    reminderRow(4, "Owner decision follow-up", "escalated"),
    reminderRow(5, "Scheduled appointment reminder", "scheduled"),
    reminderRow(6, "Reminder preparation", "preparing"),
    reminderRow(7, "Reminder delivery", "sending"),
    reminderRow(8, "Delivery confirmation", "needs_review", {
      error:
        "Provider did not confirm delivery. Verify the destination before authorizing a retry.",
      policyReason:
        "Provider did not confirm delivery. Verify the destination before authorizing a retry.",
    }),
  ];
  const dashboard = {
    rows,
    policy: {
      id: 2,
      userId: 2,
      enabled: true,
      inAppEnabled: true,
      emailEnabled: true,
      maxPerDay: 3,
      minIntervalMinutes: 60,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      timezone: "Europe/Amsterdam",
      allowWeekends: false,
      createdAt: "2026-09-26T08:00:00.000Z",
      updatedAt: "2026-09-26T08:00:00.000Z",
    },
    audit: [],
  };

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/trpc/")) {
      const value = url.pathname.endsWith("/unread-count")
        ? { unreadCount: 0 }
        : url.pathname.includes("notifications")
          ? { notifications: [] }
          : [];
      await route.fulfill({ json: value });
      return;
    }

    const methods = decodeURIComponent(
      url.pathname.split("/api/trpc/")[1]
    ).split(",");
    const batched = url.searchParams.has("batch");
    const results = methods.map(method => {
      if (method === "reminders.dashboard" && dashboardError) {
        return {
          error: {
            json: {
              message: dashboardError,
              code: -32603,
              data: {
                code: "INTERNAL_SERVER_ERROR",
                httpStatus: 500,
                path: method,
              },
            },
          },
        };
      }
      const value =
        method === "auth.me"
          ? {
              id: 2,
              openId: "worker-reminder-ui-test",
              name: "Test Worker",
              email: "worker@example.invalid",
              role: "worker",
            }
          : method === "reminders.dashboard"
            ? dashboard
            : null;
      return { result: { data: superjson.serialize(value) } };
    });
    await route.fulfill({ json: batched ? results : results[0] });
  });
}

test("does not show technical details when reminders fail to load", async ({
  page,
}) => {
  const technicalSentinel =
    "ECONNREFUSED db.internal:3306; SQLSTATE[HY000] secret=DO_NOT_SHOW";
  await mockWorkerReminders(page, technicalSentinel);
  await page.goto("/worker/reminders");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Reminder system unavailable");
  await expect(alert).toContainText(
    "Reminders could not be loaded. Check your connection, then select Refresh reminders to try again."
  );
  await expect(
    page.getByRole("button", { name: "Refresh reminders" })
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(technicalSentinel);
});

test("worker reminders explain next steps without empty placeholders on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkerReminders(page);
  await page.goto("/worker/reminders");

  await expect(
    page.getByRole("heading", { name: "Active reminders" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs your action" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Scheduled or in progress" })
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Needs your action" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("worker-reminders-mobile.png"),
    fullPage: false,
  });
  await expect(
    page.getByText(
      "Next: Open the email and confirm its request and deadline. Ask the owner to update this reminder if either changed. Do not approve it yet."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: Ask the owner to confirm the next step before sending or changing this commitment."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: Review the message. Approve and send only if correct; otherwise cancel it or ask the owner."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: Ask the owner to add the recipient's email address, then choose Approve and send."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: Check the recipient's mailbox or provider activity. Record what you found; retry only after confirming it was not sent."
    )
  ).toBeVisible();
  await expect(
    page.getByText("Blocked: source check", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Blocked: delivery check", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: No action is needed now. This reminder is scheduled for the time shown."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: The reminder is being prepared. Wait for the status to update before taking action."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Next: Delivery is in progress. Wait for the result before trying again."
    )
  ).toBeVisible();
  await expect(page.getByText("No extra context was recorded.")).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page })
    .include("[aria-labelledby='active-reminders-title']")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations.map(({ id }) => id)).toEqual([]);
  await expect(
    page.locator("[aria-labelledby='active-reminders-title']")
  ).toHaveJSProperty(
    "scrollWidth",
    await page
      .locator("[aria-labelledby='active-reminders-title']")
      .evaluate(element => element.clientWidth)
  );

  await page
    .getByRole("button", { name: /Invoice approval follow-up/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve and send" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("button", { name: /Recipient address follow-up/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve and send" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /Delivery confirmation/ }).click();
  await expect(page.getByText("Delivery check required")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm delivery checked" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("button", { name: /SKGZ portal notice follow-up/ })
    .click();
  await expect(
    page.getByRole("link", { name: "Open original source" })
  ).toHaveAttribute("href", "https://mail.google.com/mail/u/0/#all/thread-1");
  await expect(
    page
      .getByRole("dialog")
      .getByText(/Check the recipient's mailbox or provider activity/)
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm delivery checked" })
  ).toHaveCount(0);
});
