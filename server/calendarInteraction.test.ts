import { describe, expect, it } from "vitest";
import { canRescheduleCalendarTask } from "../client/src/components/calendarInteraction";

describe("calendar interaction policy", () => {
  it("only enables drag rescheduling when a persistence handler is supplied", () => {
    expect(canRescheduleCalendarTask(undefined)).toBe(false);
    expect(canRescheduleCalendarTask(() => undefined)).toBe(true);
  });
});
