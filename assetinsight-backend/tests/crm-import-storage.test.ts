import { afterAll, beforeEach, describe, expect, it } from "vitest";
import CrmImportJob from "../src/models/crmImportJob.model.js";
import CrmLead from "../src/models/crmLead.model.js";
import {
  isCurrentCrmImportStorageTarget,
  resolveCrmImportStorageTarget,
  snapshotCurrentCrmImportStorage,
} from "../src/utils/crmImportStorage.js";

const envNames = [
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "R2_LEGACY_BUCKET_NAME",
  "R2_LEGACY_PUBLIC_URL",
] as const;
const originalEnvironment = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]])
);

beforeEach(() => {
  process.env.R2_BUCKET_NAME = "asset-insight";
  process.env.R2_PUBLIC_URL = "https://assetinsight.pro";
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
});

afterAll(() => {
  for (const name of envNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("CRM import storage generations", () => {
  it("snapshots the current bucket and public origin for a new import", () => {
    const snapshot = snapshotCurrentCrmImportStorage();

    expect(snapshot).toEqual({
      sourceFileBucket: "asset-insight",
      sourceFilePublicBaseUrl: "https://assetinsight.pro",
    });
    expect(isCurrentCrmImportStorageTarget(snapshot)).toBe(true);
  });

  it("treats metadata-free historical imports as legacy and read-only", () => {
    expect(resolveCrmImportStorageTarget()).toEqual({
      bucketName: "sellsnap",
      publicBaseUrl: "https://images.sellsnap.store",
      generation: "legacy",
    });
    expect(isCurrentCrmImportStorageTarget()).toBe(false);
  });

  it("persists storage snapshots on CRM import jobs and imported leads", () => {
    for (const model of [CrmImportJob, CrmLead]) {
      expect(model.schema.path("sourceFileBucket")).toBeDefined();
      expect(model.schema.path("sourceFilePublicBaseUrl")).toBeDefined();
    }
  });
});
