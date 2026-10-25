import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicUrlProducerFiles = [
  "../src/jobs/assetReportJob.ts",
  "../src/jobs/assetReportJob/previewJob.ts",
  "../src/jobs/assetReportJob/previewFilesJob.ts",
  "../src/jobs/lotListingJob.ts",
  "../src/jobs/realEstateReportJob.ts",
  "../src/jobs/salvageReportJob.ts",
  "../src/controller/crm.controller.ts",
  "../src/controller/realEstate.controller.ts",
  "../src/controller/user.controller.ts",
  "../src/controller/appVersion.controller.ts",
];

describe("R2 public URL callers", () => {
  it("does not hard-code the legacy public origin in new report output paths", () => {
    for (const relativePath of publicUrlProducerFiles) {
      const source = fs.readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8"
      );
      expect(source, relativePath).not.toContain("https://images.sellsnap.store");
    }
  });
});
