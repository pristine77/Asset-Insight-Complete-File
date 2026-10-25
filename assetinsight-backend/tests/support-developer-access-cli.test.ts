import { describe, expect, it } from "vitest";

import {
  assertSupportGrantEligible,
  confirmConcurrentSupportAccessState,
  parseSupportDeveloperAccessArguments,
} from "../src/scripts/manageSupportDeveloperAccess.js";

const VALID_USER_ID = "507f1f77bcf86cd799439011";

describe("support developer access operator command", () => {
  it("defaults every operation to a dry run and requires explicit false to mutate", () => {
    expect(parseSupportDeveloperAccessArguments([
      "--action=grant",
      `--user-id=${VALID_USER_ID}`,
    ], {})).toMatchObject({ action: "grant", dryRun: true, userId: VALID_USER_ID });

    expect(parseSupportDeveloperAccessArguments([
      "--action=revoke",
      `--user-id=${VALID_USER_ID}`,
      "--dry-run=false",
    ], {})).toMatchObject({ action: "revoke", dryRun: false, userId: VALID_USER_ID });
  });

  it("rejects ambiguous selectors and invalid mutation flags", () => {
    expect(() => parseSupportDeveloperAccessArguments([
      "--action=grant",
      `--user-id=${VALID_USER_ID}`,
      "--email=developer@example.test",
    ], {})).toThrow(/exactly one account/i);
    expect(() => parseSupportDeveloperAccessArguments([
      "--action=grant",
      `--user-id=${VALID_USER_ID}`,
      "--dry-run=yes",
    ], {})).toThrow(/true, false, 1, or 0/i);
  });

  it("allows grants only for active admin identities", () => {
    expect(() => assertSupportGrantEligible({ role: "admin", isBlocked: false })).not.toThrow();
    expect(() => assertSupportGrantEligible({ role: "superadmin" })).not.toThrow();
    expect(() => assertSupportGrantEligible({ role: "user" })).toThrow(/admin account/i);
    expect(() => assertSupportGrantEligible({ role: "admin", isBlocked: true })).toThrow(/inactive/i);
  });

  it("accepts only an eligible concurrent grant but always permits confirmed revocation", () => {
    expect(() => confirmConcurrentSupportAccessState({
      role: "admin",
      isBlocked: false,
      canManageSupport: true,
    }, true)).not.toThrow();
    expect(() => confirmConcurrentSupportAccessState({
      role: "user",
      canManageSupport: true,
    }, true)).toThrow(/admin account/i);
    expect(() => confirmConcurrentSupportAccessState({
      role: "admin",
      isBlocked: true,
      canManageSupport: true,
    }, true)).toThrow(/inactive/i);
    expect(() => confirmConcurrentSupportAccessState({
      role: "user",
      isBlocked: true,
      canManageSupport: false,
    }, false)).not.toThrow();
    expect(() => confirmConcurrentSupportAccessState(null, false)).toThrow(/deleted/i);
  });
});
