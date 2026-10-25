import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  deleteScopedDraft,
  DraftEnvelopeError,
  getScopedDraftKey,
  hasScopedDraft,
  loadScopedDraft,
  listScopedDrafts,
  parseScopedDraftEnvelope,
  saveScopedDraft,
  recordBrowserObservation,
  pendingBrowserActivity,
  acknowledgeBrowserActivity,
} from "./storage";

describe("scoped v2 form drafts", () => {
  it("restores a baseline without inventing deletions or replaying imports on save", async () => {
    const owner = "restored-activity", id = "stable-draft";
    const lots = [{ id: "lot", lotNumber: "157", files: [new File(["x"], "photo.jpg")], extraFiles: [], coverIndex: 0 }];
    await recordBrowserObservation(owner, id, "asset", "93530", lots, false);
    const initial = await pendingBrowserActivity(owner);
    await acknowledgeBrowserActivity(owner, initial.map(event => event.eventId));
    await recordBrowserObservation(owner, id, "asset", "93530", [], false, true);
    await recordBrowserObservation(owner, id, "asset", "93530", lots, false, true);
    expect(await pendingBrowserActivity(owner)).toEqual([]);
    await saveScopedDraft({ version: 3, kind: "asset", userId: owner, revision: 1, savedAt: new Date().toISOString(), formData: { contractNo: "93530", description: "Private pre-submission text", watermarkImages: false }, lots }, id);
    const saved = await pendingBrowserActivity(owner);
    expect(saved.map(event => event.action)).toEqual(["draft_saved"]);
    expect(saved[0].activityId).toBe(id);
    expect(saved[0].data.fields).toContain("description");
    expect(JSON.stringify(saved)).not.toContain("Private pre-submission text");
  });
  it("retains metadata-only upload/remove/order history without saving photos or submitting", async () => {
    const owner = "activity-browser-user", id = "activity-browser-draft";
    const a = new File(["private image"], "private-camera.jpg", { type: "image/jpeg" });
    const b = new File(["other"], "other.jpg", { type: "image/jpeg" });
    const lots = [{ id: "lot-1", files: [a, b], extraFiles: [], coverIndex: 0 }];
    await recordBrowserObservation(owner, id, "asset", "93530", lots, false);
    const first = await pendingBrowserActivity(owner);
    expect(first.some(event => event.action === "photos_imported")).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/private image|private-camera|other.jpg/);
    expect(await hasScopedDraft(owner, "asset", id)).toBe(false);
    await acknowledgeBrowserActivity(owner, first.map(event => event.eventId));
    await recordBrowserObservation(owner, id, "asset", "93530", [{ ...lots[0], files: [b, a], coverIndex: 1 }], true);
    const changes = await pendingBrowserActivity(owner);
    expect(changes.map(event => event.action)).toEqual(expect.arrayContaining(["photos_reordered", "logo_changed", "cover_changed"]));
    expect(await pendingBrowserActivity("different-user")).toEqual([]);
    await acknowledgeBrowserActivity("different-user", changes.map(event => event.eventId));
    expect(await pendingBrowserActivity(owner)).toEqual(changes);
    await recordBrowserObservation(owner, id, "asset", "93530", [], true);
    expect((await pendingBrowserActivity(owner)).some(event => event.action === "lot_removed")).toBe(true);
  });
  it("isolates users and form types in their storage keys", () => {
    expect(getScopedDraftKey("user-a", "asset")).toBe(
      "cv:user-a:asset:draft:v2"
    );
    expect(getScopedDraftKey("user-a", "lot-listing")).toBe(
      "cv:user-a:lot-listing:draft:v2"
    );
    expect(getScopedDraftKey("user-b", "asset")).not.toBe(
      getScopedDraftKey("user-a", "asset")
    );
    expect(getScopedDraftKey(null, "asset")).toBeNull();
    expect(
      getScopedDraftKey("user-a", "asset", "auctioneer:work-item-1")
    ).toBe("cv:user-a:asset:auctioneer:work-item-1:draft:v2");
  });

  it("accepts only the attributed user, form, and v2 envelope", () => {
    const raw = JSON.stringify({
      version: 2,
      kind: "asset",
      userId: "user-a",
      revision: 8,
    });

    expect(
      parseScopedDraftEnvelope(raw, { userId: "user-a", kind: "asset" })
    ).toMatchObject({ revision: 8 });

    expect(() =>
      parseScopedDraftEnvelope(raw, {
        userId: "user-b",
        kind: "asset",
      })
    ).toThrowError(DraftEnvelopeError);
    expect(() =>
      parseScopedDraftEnvelope(raw, {
        userId: "user-a",
        kind: "lot-listing",
      })
    ).toThrowError(DraftEnvelopeError);
  });

  it("rejects corrupt and unsupported envelopes without falling back to legacy data", () => {
    expect(() =>
      parseScopedDraftEnvelope("{broken", {
        userId: "user-a",
        kind: "asset",
      })
    ).toThrowError(/not valid JSON/i);
    expect(() =>
      parseScopedDraftEnvelope(
        JSON.stringify({
          version: 1,
          kind: "asset",
          userId: "user-a",
        }),
        { userId: "user-a", kind: "asset" }
      )
    ).toThrowError(/unsupported version/i);
  });
});

describe("scoped v3 IndexedDB drafts", () => {
  it("lists ordinary draft metadata without exposing another user's drafts", async () => {
    const userId = "draft-list-user";
    const otherUserId = "draft-list-other-user";
    const scopedId = "auctioneer:incoming-1";
    await Promise.all([
      deleteScopedDraft(userId, "asset"),
      deleteScopedDraft(userId, "lot-listing"),
      deleteScopedDraft(userId, "asset", scopedId),
      deleteScopedDraft(otherUserId, "asset"),
    ]);

    await saveScopedDraft({
      version: 3,
      kind: "asset",
      userId,
      revision: 2,
      savedAt: "2026-08-02T10:00:00.000Z",
      formData: { contractNo: "ASSET-12" },
      lots: [{ files: [new File(["a"], "a.jpg", { type: "image/jpeg" })] }],
    });
    await saveScopedDraft({
      version: 3,
      kind: "lot-listing",
      userId,
      revision: 3,
      savedAt: "2026-08-03T10:00:00.000Z",
      data: {
        contractNo: "LOT-34",
        lots: [{ files: [] }, { files: [] }],
      },
    });
    await saveScopedDraft(
      {
        version: 3,
        kind: "asset",
        userId,
        revision: 4,
        savedAt: "2026-08-04T10:00:00.000Z",
        formData: { contractNo: "INCOMING" },
        lots: [],
      },
      scopedId
    );
    await saveScopedDraft({
      version: 3,
      kind: "asset",
      userId: otherUserId,
      revision: 1,
      savedAt: "2026-08-05T10:00:00.000Z",
      formData: { contractNo: "OTHER" },
      lots: [],
    });

    expect(await listScopedDrafts(userId)).toEqual([
      expect.objectContaining({
        kind: "lot-listing",
        contractNo: "LOT-34",
        lotCount: 2,
        mediaCount: 0,
      }),
      expect.objectContaining({
        kind: "asset",
        contractNo: "ASSET-12",
        lotCount: 1,
        mediaCount: 1,
      }),
    ]);
    expect(await listScopedDrafts(userId, { includeScoped: true })).toHaveLength(3);

    await Promise.all([
      deleteScopedDraft(userId, "asset"),
      deleteScopedDraft(userId, "lot-listing"),
      deleteScopedDraft(userId, "asset", scopedId),
      deleteScopedDraft(otherUserId, "asset"),
    ]);
  });

  it("isolates Auctioneer work-item drafts from ordinary form drafts", async () => {
    const userId = "auctioneer-scope-user";
    const scopeId = "auctioneer:work-item-1";
    await Promise.all([
      deleteScopedDraft(userId, "asset"),
      deleteScopedDraft(userId, "asset", scopeId),
    ]);

    const base = {
      version: 3 as const,
      kind: "asset" as const,
      userId,
      savedAt: "2026-08-01T10:00:00.000Z",
    };
    await saveScopedDraft({ ...base, revision: 1, contractNo: "ORDINARY" });
    await saveScopedDraft(
      { ...base, revision: 2, contractNo: "AUCTIONEER" },
      scopeId
    );

    const [ordinary, auctioneer] = await Promise.all([
      loadScopedDraft<typeof base & { revision: number; contractNo: string }>(
        userId,
        "asset"
      ),
      loadScopedDraft<typeof base & { revision: number; contractNo: string }>(
        userId,
        "asset",
        scopeId
      ),
    ]);
    expect(ordinary?.envelope.contractNo).toBe("ORDINARY");
    expect(auctioneer?.envelope.contractNo).toBe("AUCTIONEER");

    await Promise.all([
      deleteScopedDraft(userId, "asset"),
      deleteScopedDraft(userId, "asset", scopeId),
    ]);
  });

  it("restores original media and removes the draft transactionally", async () => {
    const userId = "indexed-media-user";
    await deleteScopedDraft(userId, "asset");
    const image = new File(["original-image-bytes"], "lot-1.jpg", {
      type: "image/jpeg",
      lastModified: 1234,
    });

    await saveScopedDraft({
      version: 3,
      kind: "asset",
      userId,
      revision: 1,
      savedAt: "2026-07-21T10:00:00.000Z",
      lots: [{ files: [image] }],
    });

    const loaded = await loadScopedDraft<{
      version: 3;
      kind: "asset";
      userId: string;
      revision: number;
      savedAt: string;
      lots: Array<{ files: File[] }>;
    }>(userId, "asset");

    expect(loaded?.missingMediaCount).toBe(0);
    expect(loaded?.envelope.lots[0].files[0]).toBeInstanceOf(File);
    expect(loaded?.envelope.lots[0].files[0].name).toBe("lot-1.jpg");

    await deleteScopedDraft(userId, "asset");
    expect(await hasScopedDraft(userId, "asset")).toBe(false);
  });

  it("keeps remaining media valid when photos are reordered or removed", async () => {
    const userId = "indexed-revision-user";
    await deleteScopedDraft(userId, "lot-listing");
    const first = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["second"], "second.jpg", { type: "image/jpeg" });
    const base = {
      version: 3 as const,
      kind: "lot-listing" as const,
      userId,
      savedAt: "2026-07-21T10:00:00.000Z",
    };

    await saveScopedDraft({ ...base, revision: 1, lots: [{ files: [first, second] }] });
    await saveScopedDraft({ ...base, revision: 2, lots: [{ files: [second] }] });

    const loaded = await loadScopedDraft<
      typeof base & { revision: number; lots: Array<{ files: File[] }> }
    >(userId, "lot-listing");
    expect(loaded?.missingMediaCount).toBe(0);
    expect(loaded?.envelope.revision).toBe(2);
    expect(loaded?.envelope.lots[0].files.map((file) => file.name)).toEqual([
      "second.jpg",
    ]);
    await deleteScopedDraft(userId, "lot-listing");
  });

  it("persists a large multi-lot draft without storing media in localStorage", async () => {
    const userId = "indexed-large-draft-user";
    await deleteScopedDraft(userId, "asset");
    const lots = Array.from({ length: 6 }, (_, lotIndex) => ({
      files: Array.from({ length: 20 }, (_, imageIndex) =>
        new File(
          [`lot-${lotIndex + 1}-image-${imageIndex + 1}`],
          `lot-${lotIndex + 1}-${imageIndex + 1}.jpg`,
          { type: "image/jpeg", lastModified: lotIndex * 100 + imageIndex }
        )
      ),
    }));

    await saveScopedDraft({
      version: 3,
      kind: "asset",
      userId,
      revision: 1,
      savedAt: "2026-07-21T10:00:00.000Z",
      lots,
    });

    const loaded = await loadScopedDraft<{
      version: 3;
      kind: "asset";
      userId: string;
      revision: number;
      savedAt: string;
      lots: Array<{ files: File[] }>;
    }>(userId, "asset");

    expect(loaded?.missingMediaCount).toBe(0);
    expect(loaded?.envelope.lots).toHaveLength(6);
    expect(loaded?.envelope.lots.flatMap((lot) => lot.files)).toHaveLength(120);
    expect(localStorage.getItem(getScopedDraftKey(userId, "asset") ?? "")).toBeNull();

    await deleteScopedDraft(userId, "asset");
  });
});
