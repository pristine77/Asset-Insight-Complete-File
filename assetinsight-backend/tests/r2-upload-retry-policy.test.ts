import { describe, expect, it } from "vitest";

import { isRetryableR2WriteError } from "../src/utils/r2Storage/r2Upload.js";

describe("R2 write retry policy", () => {
  it("retries transient R2, transport, and HTTP failures", () => {
    expect(isRetryableR2WriteError({ name: "InternalError" })).toBe(true);
    expect(isRetryableR2WriteError({ code: "ECONNRESET" })).toBe(true);
    expect(
      isRetryableR2WriteError({ $metadata: { httpStatusCode: 503 } })
    ).toBe(true);
  });

  it("does not retry authorization or validation failures", () => {
    expect(
      isRetryableR2WriteError({
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      })
    ).toBe(false);
    expect(
      isRetryableR2WriteError({
        name: "ValidationError",
        $metadata: { httpStatusCode: 400 },
      })
    ).toBe(false);
  });
});
