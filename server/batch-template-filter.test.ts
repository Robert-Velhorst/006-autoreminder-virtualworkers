import { describe, expect, it } from "vitest";
import {
  BATCH_TEMPLATES,
  filterTemplatesByPeriod,
  isBatchTemplateRunnable,
} from "../client/src/lib/batch-templates";

describe("filterTemplatesByPeriod", () => {
  it("returns only templates tagged for the selected period", () => {
    const daily = filterTemplatesByPeriod(BATCH_TEMPLATES, "daily");

    expect(daily).toHaveLength(1);
    expect(daily[0]?.id).toBe("daily-optimization");
  });

  it("does not filter templates when all periods are selected", () => {
    expect(filterTemplatesByPeriod(BATCH_TEMPLATES, "all")).toEqual(
      BATCH_TEMPLATES
    );
  });

  it("does not expose unimplemented operation types as runnable", () => {
    const optimization = BATCH_TEMPLATES.find(
      template => template.id === "daily-optimization"
    );
    const reanalysis = BATCH_TEMPLATES.find(
      template => template.id === "weekly-reanalysis"
    );

    expect(isBatchTemplateRunnable(optimization!)).toBe(false);
    expect(isBatchTemplateRunnable(reanalysis!)).toBe(true);
  });
});
