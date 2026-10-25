import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2_BUFFER_MULTIPART_THRESHOLD_BYTES, uploadBufferToR2 } from "../src/utils/r2Storage/r2Upload.js";

const envNames = ["R2_BUCKET_NAME", "R2_BUCKET", "R2_PUBLIC_URL", "R2_CUSTOM_DOMAIN", "R2_LEGACY_BUCKET_NAME", "R2_LEGACY_PUBLIC_URL"] as const;
const originalEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const bytes = Buffer.alloc(R2_BUFFER_MULTIPART_THRESHOLD_BYTES + 17, 0x63);
bytes[0] = 0x01;
bytes[bytes.length - 1] = 0xf7;
const partSize = 8 * 1024 * 1024;
const key = "previews/asset-generations/report/revision-1/digest-images.zip";
const upload = (buffer = bytes, preventOverwrite = false) => uploadBufferToR2(buffer, "application/zip", "asset-insight", key, { preventOverwrite, multipart: true });
const failure = (status: number) => Object.assign(new Error(`storage ${status}`), { $metadata: { httpStatusCode: status } });
let send: ReturnType<typeof vi.spyOn>;
let commands: any[];

beforeEach(() => {
  process.env.R2_BUCKET_NAME = "asset-insight";
  delete process.env.R2_BUCKET;
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  delete process.env.R2_CUSTOM_DOMAIN;
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
  commands = [];
  send = vi.spyOn(S3Client.prototype, "send");
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  for (const name of envNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function install(handler?: (command: any) => Promise<any> | any) {
  let uploads = 0;
  send.mockImplementation(async (command: any) => {
    commands.push(command);
    const override = await handler?.(command);
    if (override !== undefined) return override;
    switch (command.constructor.name) {
      case "CreateMultipartUploadCommand": return { UploadId: `upload-${++uploads}` };
      case "UploadPartCommand": return { ETag: `part-${command.input.PartNumber}` };
      case "HeadObjectCommand": throw failure(404);
      default: return {};
    }
  });
}
const ofType = (name: string) => commands.filter(command => command.constructor.name === name);

describe("large R2 buffer publication", () => {
  it("retains single PUT below the threshold and conditional flags for small uploads", async () => {
    install();
    const small = bytes.subarray(0, R2_BUFFER_MULTIPART_THRESHOLD_BYTES - 1);
    await upload(small, true);
    expect(ofType("PutObjectCommand")).toHaveLength(1);
    expect(ofType("PutObjectCommand")[0].input.Body).toBe(small);
    expect(ofType("PutObjectCommand")[0].input.ContentLength).toBe(small.length);
    expect(ofType("PutObjectCommand")[0].input.IfNoneMatch).toBe("*");
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(0);
  });

  it.each([R2_BUFFER_MULTIPART_THRESHOLD_BYTES, R2_BUFFER_MULTIPART_THRESHOLD_BYTES + 17])(
    "publishes %i bytes using bounded, ordered zero-copy parts and waits for completion", async size => {
      let active = 0;
      let maximum = 0;
      let completed = false;
      install(async command => {
        if (command.constructor.name === "UploadPartCommand") {
          active += 1; maximum = Math.max(maximum, active);
          await setImmediate();
          active -= 1;
        }
        if (command.constructor.name === "CompleteMultipartUploadCommand") {
          expect(active).toBe(0);
          await setImmediate();
          completed = true;
        }
      });
      const buffer = bytes.subarray(0, size);
      expect(await upload(buffer)).toBe(`https://assetinsight.test/${key}`);
      expect(completed).toBe(true);
      expect(maximum).toBe(2);
      expect(ofType("PutObjectCommand")).toHaveLength(0);
      const parts = ofType("UploadPartCommand");
      const hash = createHash("sha256");
      parts.forEach((command, index) => {
        expect(command.input.PartNumber).toBe(index + 1);
        expect(command.input.Body.buffer).toBe(buffer.buffer);
        expect(command.input.Body.byteOffset).toBe(buffer.byteOffset + index * partSize);
        expect(command.input.Body.length).toBeLessThanOrEqual(partSize);
        expect(command.input.ContentLength).toBe(command.input.Body.length);
        hash.update(command.input.Body);
      });
      expect(hash.digest("hex")).toBe(createHash("sha256").update(buffer).digest("hex"));
      expect(ofType("CompleteMultipartUploadCommand")[0].input.MultipartUpload.Parts).toEqual(parts.map(command => ({ ETag: `part-${command.input.PartNumber}`, PartNumber: command.input.PartNumber })));
    },
  );

  it("waits for sibling parts then aborts a failed attempt without completing or publishing", async () => {
    const error = failure(403);
    let siblingSettled = false;
    install(async command => {
      if (command.constructor.name === "UploadPartCommand") {
        if (command.input.PartNumber === 1) throw error;
        await setImmediate(); siblingSettled = true;
      }
      if (command.constructor.name === "AbortMultipartUploadCommand") expect(siblingSettled).toBe(true);
    });
    await expect(upload()).rejects.toBe(error);
    expect(ofType("AbortMultipartUploadCommand")).toHaveLength(1);
    expect(ofType("CompleteMultipartUploadCommand")).toHaveLength(0);
    expect(ofType("HeadObjectCommand")).toHaveLength(0);
  });

  it("retries a transient failed part with a new upload after cleanup", async () => {
    let failed = false;
    install(command => {
      if (!failed && command.constructor.name === "UploadPartCommand") { failed = true; throw failure(503); }
    });
    await upload();
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(2);
    expect(ofType("AbortMultipartUploadCommand")[0].input.UploadId).toBe("upload-1");
    expect(ofType("CompleteMultipartUploadCommand")[0].input.UploadId).toBe("upload-2");
  });

  it("reconciles an uncertain completed upload with matching HEAD and does not replay it", async () => {
    install(command => {
      if (command.constructor.name === "CompleteMultipartUploadCommand") throw failure(503);
      if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length };
    });
    await expect(upload()).resolves.toBe(`https://assetinsight.test/${key}`);
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(1);
    expect(ofType("AbortMultipartUploadCommand")).toHaveLength(1);
  });

  it.each([404, "mismatch"])("retries uncertain completion when HEAD is %s", async head => {
    let completions = 0;
    install(command => {
      if (command.constructor.name === "CompleteMultipartUploadCommand" && ++completions === 1) throw failure(503);
      if (command.constructor.name === "HeadObjectCommand" && head === "mismatch") return { ContentLength: bytes.length - 1 };
    });
    await upload();
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(2);
    expect(ofType("AbortMultipartUploadCommand")).toHaveLength(1);
  });

  it.each([403, 412])("does not hide completion error %i with HEAD or cleanup errors", async status => {
    const error = failure(status);
    install(command => {
      if (command.constructor.name === "CompleteMultipartUploadCommand") throw error;
      if (command.constructor.name === "AbortMultipartUploadCommand") throw failure(503);
    });
    await expect(upload()).rejects.toBe(error);
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(1);
    expect(ofType("HeadObjectCommand")).toHaveLength(0);
  });

  it.each([false, true])("replays default large PUTs with fresh bounded streams (preventOverwrite=%s)", async preventOverwrite => {
    let puts = 0;
    const bodies: Readable[] = [];
    const digests: string[] = [];
    install(async command => {
      if (command.constructor.name !== "PutObjectCommand") return;
      puts += 1;
      const body = command.input.Body;
      expect(body).toBeInstanceOf(Readable);
      expect(command.input.IfNoneMatch).toBe(preventOverwrite ? "*" : undefined);
      expect(command.input.ContentLength).toBe(bytes.length);
      bodies.push(body);
      const hash = createHash("sha256");
      for await (const chunk of body) {
        expect(chunk.length).toBeLessThanOrEqual(2 * partSize);
        hash.update(chunk);
      }
      digests.push(hash.digest("hex"));
      if (puts === 1) throw failure(503);
    });
    await uploadBufferToR2(bytes, "application/zip", "asset-insight", key, { preventOverwrite });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(bodies.every(body => body.destroyed)).toBe(true);
    expect(digests).toEqual(Array(2).fill(createHash("sha256").update(bytes).digest("hex")));
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(0);
  });

  it("keeps conditional single-PUT semantics even when multipart is requested", async () => {
    install(async command => {
      if (command.constructor.name !== "PutObjectCommand") return;
      expect(command.input.Body).toBeInstanceOf(Readable);
      expect(command.input.IfNoneMatch).toBe("*");
      for await (const chunk of command.input.Body) expect(chunk.length).toBeLessThanOrEqual(2 * partSize);
    });
    await upload(bytes, true);
    expect(ofType("CreateMultipartUploadCommand")).toHaveLength(0);
  });

  it("keeps storage-origin and canonical-key guards before multipart writes", async () => {
    install();
    await expect(uploadBufferToR2(bytes, "application/zip", "sellsnap", key)).rejects.toThrow();
    await expect(uploadBufferToR2(bytes, "application/zip", "asset-insight", "/unsafe.zip")).rejects.toThrow(/canonical/i);
    expect(commands).toHaveLength(0);
  });
});
