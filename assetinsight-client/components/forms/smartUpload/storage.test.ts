import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSmartUploadDraft,
  deleteSmartUploadDraft,
  loadSmartUploadFile,
  loadSmartUploadDraft,
  releaseSmartUploadMedia,
  updateSmartUploadDraft,
} from "./storage";

const USER_ID = "smart-upload-storage-test-user";

Object.defineProperty(globalThis, "File", {
  configurable: true,
  value: NodeFile,
});

afterEach(async () => {
  await Promise.all([
    deleteSmartUploadDraft(USER_ID, "asset"),
    deleteSmartUploadDraft(USER_ID, "lot-listing"),
    deleteSmartUploadDraft(
      USER_ID,
      "asset",
      "auctioneer:work-item-1"
    ),
  ]);
});

describe("Smart Upload IndexedDB recovery", () => {
  it("restores file bytes and original order after upload progress is saved", async () => {
    const files = [
      new File(["first"], "first.jpg", {
        type: "image/jpeg",
        lastModified: 1,
      }),
      new File(["divider"], "divider.png", {
        type: "image/png",
        lastModified: 2,
      }),
      new File(["third"], "third.webp", {
        type: "image/webp",
        lastModified: 3,
      }),
    ];

    const created = await createSmartUploadDraft({
      userId: USER_ID,
      kind: "asset",
      clientSubmissionId: "submission-1",
      details: { contract_no: "CTR-1" },
      files,
    });
    expect(created.files.map((file) => file.file)).toEqual(files);

    await updateSmartUploadDraft(USER_ID, "asset", {
      sessionId: "session-1",
      stage: "uploading",
      files: created.files.map(({ file: _file, ...descriptor }, index) => ({
        ...descriptor,
        uploaded: index < 2,
      })),
    });

    const restored = await loadSmartUploadDraft(USER_ID, "asset");
    expect(restored?.sessionId).toBe("session-1");
    expect(restored?.files.map((file) => file.fileId)).toEqual([
      "images-0",
      "images-1",
      "images-2",
    ]);
    expect(restored?.files.map((file) => file.originalOrder)).toEqual([
      0, 1, 2,
    ]);
    expect(restored?.files.map((file) => file.uploaded)).toEqual([
      true,
      true,
      false,
    ]);
    expect(restored?.files.every((file) => file.file === undefined)).toBe(true);
    const restoredThird = await loadSmartUploadFile(
      restored!,
      restored!.files[2]!
    );
    await expect(restoredThird!.text()).resolves.toBe("third");
  });

  it("keeps Asset and Lot Listing recovery sessions isolated", async () => {
    await createSmartUploadDraft({
      userId: USER_ID,
      kind: "asset",
      clientSubmissionId: "asset-submission",
      details: { contract_no: "ASSET-1" },
      files: [new File(["asset"], "asset.jpg", { type: "image/jpeg" })],
    });
    await createSmartUploadDraft({
      userId: USER_ID,
      kind: "lot-listing",
      clientSubmissionId: "listing-submission",
      details: { contract_no: "LISTING-1" },
      files: [new File(["listing"], "listing.jpg", { type: "image/jpeg" })],
    });

    const [asset, listing] = await Promise.all([
      loadSmartUploadDraft(USER_ID, "asset"),
      loadSmartUploadDraft(USER_ID, "lot-listing"),
    ]);
    expect(asset?.details.contract_no).toBe("ASSET-1");
    expect(listing?.details.contract_no).toBe("LISTING-1");
  });

  it("isolates an Auctioneer recovery session from an ordinary session", async () => {
    const scopeId = "auctioneer:work-item-1";
    await createSmartUploadDraft({
      userId: USER_ID,
      kind: "asset",
      clientSubmissionId: "ordinary",
      details: { contract_no: "ORDINARY" },
      files: [new File(["ordinary"], "ordinary.jpg", { type: "image/jpeg" })],
    });
    await createSmartUploadDraft({
      userId: USER_ID,
      kind: "asset",
      scopeId,
      clientSubmissionId: "auctioneer",
      details: { contract_no: "AUCTIONEER" },
      files: [
        new File(["auctioneer"], "auctioneer.jpg", { type: "image/jpeg" }),
      ],
    });

    const [ordinary, auctioneer] = await Promise.all([
      loadSmartUploadDraft(USER_ID, "asset"),
      loadSmartUploadDraft(USER_ID, "asset", scopeId),
    ]);
    expect(ordinary?.clientSubmissionId).toBe("ordinary");
    expect(auctioneer?.clientSubmissionId).toBe("auctioneer");
  });

  it("can release original media without deleting the recovery manifest", async () => {
    await createSmartUploadDraft({
      userId: USER_ID,
      kind: "asset",
      clientSubmissionId: "release-media",
      details: { contract_no: "RELEASE-1" },
      files: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })],
    });

    const before = await loadSmartUploadDraft(USER_ID, "asset");
    expect(await loadSmartUploadFile(before!, before!.files[0]!)).toBeDefined();

    await releaseSmartUploadMedia(USER_ID, "asset");

    const after = await loadSmartUploadDraft(USER_ID, "asset");
    expect(after?.clientSubmissionId).toBe("release-media");
    expect(await loadSmartUploadFile(after!, after!.files[0]!)).toBeUndefined();
  });
});
