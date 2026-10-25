import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildSmartUploadGroups,
  classifyBlackDivider,
  evaluateSmartUploadGrouping,
  getSmartUploadActiveInspectionErrors,
  SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES,
  sortSmartUploadFiles,
  validateSmartUploadGroups,
  validateSmartUploadOrderedFileIds,
} from "../src/service/smartUploadGroupingService.js";
import {
  resolveSmartUploadOrderReviewState,
  validateSmartUploadUnresolvedDividerIds,
} from "../src/utils/smartUploadReviewState.js";

type TestFile = {
  fileId: string;
  key: string;
  fieldname: "images";
  originalOrder: number;
  captureOrder?: number;
};

const file = (
  fileId: string,
  originalOrder: number,
  captureOrder?: number
): TestFile => ({
  fileId,
  key: `${fileId}.jpg`,
  fieldname: "images",
  originalOrder,
  captureOrder,
});

describe("Smart Upload grouping", () => {
  it("blocks unreadable report photos but ignores deliberately excluded dividers", () => {
    const metrics = [
      { fileId: "report-photo", isDivider: false, error: "decode failed" },
      { fileId: "excluded-divider", isDivider: false, error: "decode failed" },
    ];

    expect(
      getSmartUploadActiveInspectionErrors(metrics, ["excluded-divider"])
    ).toEqual([{ fileId: "report-photo", error: "decode failed" }]);
  });

  it("creates one lot when no divider exists and preserves manifest order", () => {
    const groups = buildSmartUploadGroups(
      [file("third", 2), file("first", 0), file("second", 1)],
      []
    );

    expect(groups).toEqual([
      {
        groupIndex: 0,
        imageCount: 3,
        fileIds: ["first", "second", "third"],
        coverFileId: "first",
        overLimit: false,
      },
    ]);
  });

  it("does not create empty lots for leading, trailing, or consecutive dividers", () => {
    const files = [
      file("divider-start", 0),
      file("photo-a", 1),
      file("divider-a", 2),
      file("divider-b", 3),
      file("photo-b", 4),
      file("divider-end", 5),
    ];

    const groups = buildSmartUploadGroups(files, [
      "divider-start",
      "divider-a",
      "divider-b",
      "divider-end",
    ]);

    expect(groups.map((group) => group.fileIds)).toEqual([
      ["photo-a"],
      ["photo-b"],
    ]);
  });

  it("uses capture chronology when a desktop picker returns files in filename order", () => {
    const filesInDesktopPickerOrder = [
      file("black-divider", 0, 4000),
      file("lot-1-photo-1", 1, 1000),
      file("lot-1-photo-2", 2, 2000),
      file("lot-1-photo-3", 3, 3000),
      file("lot-2-photo-1", 4, 5000),
      file("lot-2-photo-2", 5, 6000),
      file("lot-2-photo-3", 6, 7000),
    ];

    const groups = buildSmartUploadGroups(filesInDesktopPickerOrder, [
      "black-divider",
    ]);

    expect(groups.map((group) => group.fileIds)).toEqual([
      ["lot-1-photo-1", "lot-1-photo-2", "lot-1-photo-3"],
      ["lot-2-photo-1", "lot-2-photo-2", "lot-2-photo-3"],
    ]);
  });

  it("splits three photos, one divider, and three photos into two lots", () => {
    const groups = buildSmartUploadGroups(
      [
        file("lot-1-photo-1", 0),
        file("lot-1-photo-2", 1),
        file("lot-1-photo-3", 2),
        file("black-divider", 3),
        file("lot-2-photo-1", 4),
        file("lot-2-photo-2", 5),
        file("lot-2-photo-3", 6),
      ],
      ["black-divider"]
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.imageCount)).toEqual([3, 3]);
    expect(groups.flatMap((group) => group.fileIds)).not.toContain(
      "black-divider"
    );
  });

  it("flags only groups above the 200-photo limit", () => {
    const twoHundred = Array.from({ length: 200 }, (_, index) =>
      file(`photo-${index}`, index)
    );
    const allowed = buildSmartUploadGroups(twoHundred, []);
    const blocked = buildSmartUploadGroups(
      [...twoHundred, file("photo-200", 200)],
      []
    );

    expect(allowed[0]).toMatchObject({ imageCount: 200, overLimit: false });
    expect(blocked[0]).toMatchObject({ imageCount: 201, overLimit: true });
  });

  it("splits an ordered 2,000-image manifest into bounded lots", () => {
    const files: TestFile[] = [];
    const dividerFileIds: string[] = [];
    let originalOrder = 0;

    // Nine groups contain 199 report photos plus a divider; the final group
    // contains 200 report photos. This produces exactly 2,000 selected files.
    for (let groupIndex = 0; groupIndex < 10; groupIndex += 1) {
      const imageCount = groupIndex < 9 ? 199 : 200;
      for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
        files.push(
          file(
            `lot-${groupIndex + 1}-photo-${imageIndex + 1}`,
            originalOrder
          )
        );
        originalOrder += 1;
      }
      if (groupIndex < 9) {
        const dividerFileId = `divider-${groupIndex + 1}`;
        files.push(file(dividerFileId, originalOrder));
        dividerFileIds.push(dividerFileId);
        originalOrder += 1;
      }
    }

    const groups = buildSmartUploadGroups(files, dividerFileIds);

    expect(files).toHaveLength(2_000);
    expect(groups).toHaveLength(10);
    expect(groups.map((group) => group.imageCount)).toEqual([
      199,
      199,
      199,
      199,
      199,
      199,
      199,
      199,
      199,
      200,
    ]);
    expect(groups.every((group) => !group.overLimit)).toBe(true);
    expect(groups.flatMap((group) => group.fileIds)).not.toEqual(
      expect.arrayContaining(dividerFileIds)
    );
  });

  it("sorts by explicit original order with stable array-order fallback", () => {
    expect(
      sortSmartUploadFiles([
        { id: "fallback-a" },
        { id: "second", originalOrder: 1 },
        { id: "first", originalOrder: 0 },
        { id: "fallback-b" },
      ]).map((entry) => entry.id)
    ).toEqual(["fallback-a", "first", "second", "fallback-b"]);
  });

  it("prefers capture order and resolves ties deterministically", () => {
    expect(
      sortSmartUploadFiles([
        { id: "second", originalOrder: 0, captureOrder: 2000 },
        { id: "first-b", originalOrder: 2, captureOrder: 1000 },
        { id: "first-a", originalOrder: 1, captureOrder: 1000 },
      ]).map((entry) => entry.id)
    ).toEqual(["first-a", "first-b", "second"]);
  });

  it("honours an explicitly reviewed order over capture chronology", () => {
    expect(
      sortSmartUploadFiles(
        [
          { id: "second", originalOrder: 1, captureOrder: 1000 },
          { id: "first", originalOrder: 0, captureOrder: 2000 },
        ],
        { preferOriginalOrder: true }
      ).map((entry) => entry.id)
    ).toEqual(["first", "second"]);
  });

  it("blocks dividers that do not create non-empty lot boundaries", () => {
    const leading = evaluateSmartUploadGrouping(
      [file("divider", 0), file("photo", 1)],
      ["divider"]
    );
    const trailing = evaluateSmartUploadGrouping(
      [file("photo", 0), file("divider", 1)],
      ["divider"]
    );
    const consecutive = evaluateSmartUploadGrouping(
      [
        file("photo-a", 0),
        file("divider-a", 1),
        file("divider-b", 2),
        file("photo-b", 3),
      ],
      ["divider-a", "divider-b"]
    );

    expect(leading.warnings.join(" ")).toContain("first image");
    expect(trailing.warnings.join(" ")).toContain("last image");
    expect(consecutive.warnings.join(" ")).toContain("consecutive");
    expect(consecutive.warnings.join(" ")).toContain(
      "3 non-empty lots, but only 2 were found"
    );
  });

  it("requires reviewed ordering to contain each image exactly once", () => {
    const files = [file("a", 0), file("b", 1), file("c", 2)];

    expect(
      validateSmartUploadOrderedFileIds(files, ["c", "a", "b"])
    ).toMatchObject({ valid: true, orderedFileIds: ["c", "a", "b"] });
    expect(
      validateSmartUploadOrderedFileIds(files, ["a", "a", "foreign"])
    ).toMatchObject({
      valid: false,
      duplicateFileIds: ["a"],
      missingFileIds: ["b", "c"],
      unknownFileIds: ["foreign"],
    });
  });

  it("accepts authoritative reviewed groups and rejects lossy arrangements", () => {
    const files = [
      file("a", 0),
      file("b", 1),
      file("divider", 2),
      file("c", 3),
      file("d", 4),
    ];

    expect(
      validateSmartUploadGroups(files, ["divider"], [
        ["a", "c"],
        { fileIds: ["b", "d"] },
      ])
    ).toMatchObject({
      valid: true,
      groups: [
        { groupIndex: 0, fileIds: ["a", "c"], imageCount: 2 },
        { groupIndex: 1, fileIds: ["b", "d"], imageCount: 2 },
      ],
    });
    expect(
      validateSmartUploadGroups(files, ["divider"], [
        ["a", "divider"],
        ["a", "foreign"],
      ])
    ).toMatchObject({
      valid: false,
      duplicateFileIds: ["a"],
      missingFileIds: ["b", "c", "d"],
      unknownFileIds: ["foreign"],
      dividerFileIdsInGroups: ["divider"],
    });
  });

  it("keeps ambiguous legacy order review durable across reloads", () => {
    expect(
      resolveSmartUploadOrderReviewState({
        dividerFileIds: ["divider-a", "divider-b"],
        detailsOrderAmbiguous: true,
      })
    ).toEqual({
      orderReviewRequired: true,
      unresolvedDividerIds: ["divider-a", "divider-b"],
    });

    expect(
      resolveSmartUploadOrderReviewState({
        orderReviewRequired: true,
        unresolvedDividerIds: ["divider-b"],
        dividerFileIds: ["divider-a", "divider-b"],
        detailsOrderAmbiguous: true,
      })
    ).toEqual({
      orderReviewRequired: true,
      unresolvedDividerIds: ["divider-b"],
    });
  });

  it("accepts a cleared review and rejects duplicate or non-divider IDs", () => {
    expect(
      resolveSmartUploadOrderReviewState({
        orderReviewRequired: false,
        unresolvedDividerIds: [],
        dividerFileIds: ["divider"],
        detailsOrderAmbiguous: true,
      })
    ).toEqual({
      orderReviewRequired: false,
      unresolvedDividerIds: [],
    });

    expect(
      resolveSmartUploadOrderReviewState({
        orderReviewRequired: false,
        unresolvedDividerIds: ["divider"],
        dividerFileIds: ["divider"],
      })
    ).toEqual({
      orderReviewRequired: true,
      unresolvedDividerIds: ["divider"],
    });

    expect(
      resolveSmartUploadOrderReviewState({
        orderReviewRequired: false,
        unresolvedDividerIds: ["not-a-current-divider"],
        dividerFileIds: ["divider"],
      })
    ).toEqual({
      orderReviewRequired: true,
      unresolvedDividerIds: [],
    });

    expect(
      validateSmartUploadUnresolvedDividerIds(
        ["divider-a", "divider-b"],
        ["divider-a", "divider-a", "photo", ""]
      )
    ).toMatchObject({
      valid: false,
      duplicateFileIds: ["divider-a"],
      emptyFileIds: [""],
      nonDividerFileIds: ["photo"],
    });
  });
});

describe("Smart Upload black-divider classifier", () => {
  it("rejects classifier inputs above the bounded upload size", async () => {
    await expect(
      classifyBlackDivider(
        "oversized",
        Buffer.alloc(SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES + 1)
      )
    ).rejects.toThrow("classifier limit");
  });

  it("detects compressed near-black JPEG separators", async () => {
    const input = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 3, g: 3, b: 3 },
      },
    })
      .jpeg({ quality: 35 })
      .toBuffer();

    const result = await classifyBlackDivider("black", input);
    expect(result.isDivider).toBe(true);
    expect(result.meanLuminance).toBeLessThanOrEqual(12);
  });

  it("does not classify a dark but detailed photo as a divider", async () => {
    const width = 80;
    const height = 80;
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      const value = index % 2 === 0 ? 0 : 80;
      pixels[index * 3] = value;
      pixels[index * 3 + 1] = value;
      pixels[index * 3 + 2] = value;
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 80 })
      .toBuffer();

    const result = await classifyBlackDivider("dark-detail", input);
    expect(result.isDivider).toBe(false);
  });

  it("flattens transparent pixels onto white before classification", async () => {
    const input = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await classifyBlackDivider("transparent", input);
    expect(result.isDivider).toBe(false);
    expect(result.meanLuminance).toBeGreaterThan(240);
  });
});
