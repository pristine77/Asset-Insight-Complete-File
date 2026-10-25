import { describe, expect, it } from "vitest";
import { REPORT_JOB_TYPES } from "../src/models/reportJob.model.js";
import { reportJobHandlers } from "../src/workers/reportJobHandlers/index.js";

describe("durable report worker registry", () => {
  it("registers exactly one handler for every persisted job type", () => {
    expect(Object.keys(reportJobHandlers).sort()).toEqual(
      [...REPORT_JOB_TYPES].sort()
    );

    for (const jobType of REPORT_JOB_TYPES) {
      expect(reportJobHandlers[jobType]).toBeTypeOf("function");
    }
  });
});
