import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
let presign: typeof import("../src/utils/r2Storage/r2Upload.js")["createCaptureBackupPresignedPutUrl"];
let currentPresign: typeof import("../src/utils/r2Storage/r2Upload.js")["createR2PresignedPutUrl"];
let bucket: typeof import("../src/utils/r2Storage/r2Upload.js")["getCaptureBackupR2Bucket"];
const privateBucket = "asset-insight-private-backups-test";
const key = `capture-backups/${"a".repeat(24)}/${"b".repeat(24)}/${"c".repeat(64)}`;
beforeAll(async () => {
  vi.stubEnv("R2_ENDPOINT", "https://r2-backup-fixture.example.test");
  vi.stubEnv("R2_ACCESS_KEY_ID", "fixture-access-id");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "fixture-secret-for-offline-signature-only");
  ({ createCaptureBackupPresignedPutUrl: presign, createR2PresignedPutUrl: currentPresign, getCaptureBackupR2Bucket: bucket } = await import("../src/utils/r2Storage/r2Upload.js"));
});
beforeEach(() => vi.stubEnv("CAPTURE_BACKUP_R2_BUCKET", privateBucket));
afterAll(() => vi.unstubAllEnvs());
describe("capture backup restricted presigned PUT", () => {
  it("cryptographically binds the immutable precondition and exact byte length", async () => {
    const url = new URL(await presign(privateBucket, key, "image/jpeg", 19, 900));
    expect(url.hostname).toBe("r2-backup-fixture.example.test");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-length", "if-none-match"]));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f\d]{64}$/);
  });
  it.each([0, -1, NaN, 1.1, Infinity])("rejects invalid exact byte length %s", async size => {
    await expect(presign(privateBucket, key, "image/jpeg", size, 900)).rejects.toThrow(/positive byte length/);
  });
  it.each(["", "asset-insight-test", "sellsnap-test", "sellsnap"])("rejects missing/public/legacy backup bucket %j", invalid => {
    vi.stubEnv("CAPTURE_BACKUP_R2_BUCKET", invalid);
    expect(() => bucket()).toThrow(/separate private/);
  });
  it("does not allow normal report writes into backup storage or backup writes into public report storage", async () => {
    await expect(currentPresign(privateBucket, key, "image/jpeg")).rejects.toThrow(/active current bucket/);
    await expect(presign("asset-insight-test", key, "image/jpeg", 19, 900)).rejects.toThrow(/outside configured private/);
    await expect(presign(privateBucket, "uploads/other-original.jpg", "image/jpeg", 19, 900)).rejects.toThrow(/outside configured private/);
    const normal = new URL(await currentPresign("asset-insight-test", "uploads/report-original.jpg", "image/jpeg"));
    expect(normal.pathname).toBe("/asset-insight-test/uploads/report-original.jpg");
  });
});
