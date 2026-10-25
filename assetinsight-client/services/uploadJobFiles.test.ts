import { describe, expect, it } from "vitest";
import {
  describeSubmissionFiles,
  submissionFilesFromLots,
  submissionFilesMatchManifest,
} from "./uploadJobFiles";

const file = (name: string, size = 10, lastModified = 1700000000000) =>
  new File([new Uint8Array(size)], name, { type: "image/jpeg", lastModified });

describe("submissionFilesFromLots", () => {
  it("orders every lot's main photos before its report-only photos", () => {
    const { images, videos } = submissionFilesFromLots([
      { files: [file("a1.jpg"), file("a2.jpg")], extraFiles: [file("a-extra.jpg")] },
      { files: [file("b1.jpg")], extraFiles: [] },
    ]);

    expect(images.map((item) => item.name)).toEqual([
      "a1.jpg",
      "a2.jpg",
      "a-extra.jpg",
      "b1.jpg",
    ]);
    expect(videos).toEqual([]);
  });

  it("collects videos separately, in lot order, after the photographs", () => {
    const { images, videos } = submissionFilesFromLots([
      { files: [file("a1.jpg")], videoFiles: [file("a.mp4")] },
      { files: [file("b1.jpg")], videoFiles: [file("b.mp4")] },
    ]);

    expect(images.map((item) => item.name)).toEqual(["a1.jpg", "b1.jpg"]);
    expect(videos.map((item) => item.name)).toEqual(["a.mp4", "b.mp4"]);
  });

  it("tolerates absent buckets and a missing lot list", () => {
    expect(submissionFilesFromLots([{}])).toEqual({ images: [], videos: [] });
    expect(submissionFilesFromLots(null)).toEqual({ images: [], videos: [] });
  });
});
describe("submissionFilesMatchManifest", () => {
  it("accepts rehydrated media identical to the frozen manifest", () => {
    const rebuilt = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a1.jpg", 10)], extraFiles: [file("a2.jpg", 20)] }])
    );

    expect(submissionFilesMatchManifest(rebuilt, rebuilt)).toEqual({ matches: true });
  });

  it("refuses a draft that gained or lost a photo", () => {
    const frozen = describeSubmissionFiles(submissionFilesFromLots([{ files: [file("a1.jpg")] }]));
    const rebuilt = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a1.jpg"), file("a2.jpg")] }])
    );

    expect(submissionFilesMatchManifest(rebuilt, frozen)).toEqual({
      matches: false,
      reason: "count",
    });
  });

  it("refuses a replaced photo that kept its name but changed its bytes", () => {
    const frozen = describeSubmissionFiles(submissionFilesFromLots([{ files: [file("a1.jpg", 10)] }]));
    const rebuilt = describeSubmissionFiles(submissionFilesFromLots([{ files: [file("a1.jpg", 99)] }]));

    expect(submissionFilesMatchManifest(rebuilt, frozen)).toEqual({
      matches: false,
      reason: "identity",
    });
  });

  it("refuses a reordered draft, because file ids are positional", () => {
    const frozen = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a1.jpg"), file("a2.jpg")] }])
    );
    const rebuilt = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a2.jpg"), file("a1.jpg")] }])
    );

    expect(submissionFilesMatchManifest(rebuilt, frozen)).toEqual({
      matches: false,
      reason: "identity",
    });
  });

  it("refuses a re-picked photo edited since the upload began", () => {
    const frozen = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a1.jpg", 10, 1700000000000)] }])
    );
    const rebuilt = describeSubmissionFiles(
      submissionFilesFromLots([{ files: [file("a1.jpg", 10, 1800000000000)] }])
    );

    expect(submissionFilesMatchManifest(rebuilt, frozen)).toEqual({
      matches: false,
      reason: "identity",
    });
  });

  it("treats a missing manifest as a mismatch rather than a licence to resume", () => {
    const rebuilt = describeSubmissionFiles(submissionFilesFromLots([{ files: [file("a1.jpg")] }]));

    expect(submissionFilesMatchManifest(rebuilt, undefined)).toEqual({
      matches: false,
      reason: "count",
    });
  });
});
