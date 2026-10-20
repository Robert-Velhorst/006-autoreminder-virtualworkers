import { describe, expect, it } from "vitest";
import {
  aptlssEvidenceRevisions,
  users,
  workspaceEvidenceItems,
} from "../drizzle/schema.postgres";
import { retainGoogleDriveEvidenceRecord } from "./googleEvidence";

function driveRetentionFixture(existing: Record<string, unknown> | null) {
  const itemWrites: Array<{
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];
  const revisionWrites: Array<Record<string, unknown>> = [];
  let evidenceReads = 0;
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: () => query,
          limit: () => query,
          for: async () => {
            if (table === users) return [{ id: 42 }];
            if (table === aptlssEvidenceRevisions) return [];
            evidenceReads += 1;
            if (evidenceReads === 1) return existing ? [existing] : [];
            return [{ id: Number(existing?.id ?? 81) }];
          },
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) =>
        table === aptlssEvidenceRevisions
          ? (revisionWrites.push(values), Promise.resolve())
          : {
              onConflictDoUpdate: async ({
                set,
              }: {
                set: Record<string, unknown>;
              }) => {
                itemWrites.push({ values, set });
              },
            },
    }),
  } as never;

  return { tx, itemWrites, revisionWrites };
}

function driveValues(overrides: Record<string, unknown> = {}) {
  return {
    vaId: 42,
    source: "google_drive",
    sourceId: "42:file-1",
    sourceContainerId: "worker:42",
    kind: "file",
    title: "Case correspondence",
    summary: "Evidence from Google Drive",
    content: "Current source content",
    sourceUrl: "https://drive.google.com/file/d/file-1/view",
    mimeType: "application/pdf",
    modifiedAt: new Date("2026-09-26T10:01:00.000Z"),
    observedAt: new Date("2026-09-26T10:02:00.000Z"),
    contentHash: "revision-new",
    metadataJson: "{}",
    active: true,
    ...overrides,
  };
}

describe("Google evidence ingestion safety", () => {
  it("rejects a replayed older Drive revision without writing over the newer source", async () => {
    const newer = new Date("2026-09-26T10:01:00.000Z");
    const fixture = driveRetentionFixture({
      id: 81,
      vaId: 42,
      source: "google_drive",
      sourceId: "42:file-1",
      modifiedAt: newer,
      observedAt: newer,
      contentHash: "revision-new",
      active: true,
      reviewStatus: "linked",
      reviewedAt: newer,
      reviewedBy: "founder-7",
    });

    const result = await retainGoogleDriveEvidenceRecord(
      fixture.tx,
      driveValues({
        modifiedAt: new Date("2026-09-26T10:00:00.000Z"),
        contentHash: "revision-old",
        content: "Stale replay content",
      }) as never
    );

    expect(result).toEqual({ retained: false, changed: false });
    expect(fixture.itemWrites).toHaveLength(0);
    expect(fixture.revisionWrites).toHaveLength(0);
  });

  it("invalidates an old review only when a newer Drive revision changes the evidence", async () => {
    const previousReview = {
      id: 81,
      vaId: 42,
      source: "google_drive",
      sourceId: "42:file-1",
      modifiedAt: new Date("2026-09-26T10:00:00.000Z"),
      observedAt: new Date("2026-09-26T10:00:00.000Z"),
      contentHash: "revision-old",
      active: true,
      reviewStatus: "not_work_related",
      reviewedAt: new Date("2026-09-26T10:00:00.000Z"),
      reviewedBy: "founder-7",
    };
    const fixture = driveRetentionFixture(previousReview);

    const result = await retainGoogleDriveEvidenceRecord(
      fixture.tx,
      driveValues() as never
    );

    expect(result).toMatchObject({
      retained: true,
      changed: true,
      evidenceId: 81,
    });
    expect(fixture.itemWrites[0]?.set).toMatchObject({
      reviewStatus: "unreviewed",
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(fixture.revisionWrites).toEqual([
      {
        evidenceId: 81,
        contentHash: "revision-new",
        truthClass: "source_record",
        summary: "Evidence from Google Drive",
        content: "Current source content",
        metadataJson: "{}",
        observedAt: new Date("2026-09-26T10:02:00.000Z"),
        recordedBy: null,
      },
    ]);
  });

  it("preserves the existing review for an exact replay of the same Drive revision", async () => {
    const modifiedAt = new Date("2026-09-26T10:01:00.000Z");
    const fixture = driveRetentionFixture({
      id: 81,
      vaId: 42,
      source: "google_drive",
      sourceId: "42:file-1",
      modifiedAt,
      observedAt: modifiedAt,
      contentHash: "revision-new",
      active: true,
      reviewStatus: "linked",
      reviewedAt: modifiedAt,
      reviewedBy: "founder-7",
    });

    const result = await retainGoogleDriveEvidenceRecord(
      fixture.tx,
      driveValues({ modifiedAt }) as never
    );

    expect(result).toMatchObject({ retained: true, changed: false });
    expect(fixture.itemWrites[0]?.set).not.toHaveProperty("reviewStatus");
    expect(fixture.itemWrites[0]?.set).not.toHaveProperty("reviewedAt");
    expect(fixture.itemWrites[0]?.set).not.toHaveProperty("reviewedBy");
    expect(fixture.revisionWrites).toHaveLength(0);
  });
});
