/**
 * Opt-in live OCR check using synthetic, in-memory fixtures only.
 * No MongoDB connection, report creation, or R2 reads/writes are performed.
 * Run after building: node dist/scripts/smokeBundlePhotoScanning.js --live
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log("Live OCR is opt-in: pass --live to make at most two OpenAI requests.");
    return;
  }

  const { default: openai } = await import("../utils/openaiClient.js");
  if (!String(process.env.OPENAI_API_KEY || "").trim()) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const {
    buildBundleLotNumberPhotoInputs,
    detectBundleLotNumbersFromPhotos,
    resolveBundleLotAnalysisPolicy,
    selectBundleAnalysisImageIndexes,
  } = await import("../service/bundleLotAnalysisPolicy.js");
  const { analyzeBundle } = await import("../service/assetOpenAIService/bundle.js");

  // Exercise the production client, but do not allow its normal retries to
  // turn an explicit smoke check into an unbounded paid test run.
  const createResponse = openai.responses.create.bind(openai.responses);
  let requestCount = 0;
  let providerFailure: unknown;
  openai.responses.create = ((body: any, options: any = {}) => {
    assert.ok(++requestCount <= 2, "Smoke test exceeded its two-request budget");
    return createResponse(body, { ...options, timeout: 90_000, maxRetries: 0 })
      .catch((error: unknown) => {
        providerFailure = error;
        throw error;
      });
  }) as typeof openai.responses.create;

  const svgPhoto = (label: string, detail: string) => sharp(Buffer.from(
    `<svg width="1200" height="360" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="360" fill="white"/>
      <rect x="20" y="20" width="1160" height="320" fill="none" stroke="black" stroke-width="5"/>
      <text x="55" y="115" font-family="sans-serif" font-size="56" fill="black">${label}</text>
      <text x="55" y="205" font-family="sans-serif" font-size="40" fill="black">${detail}</text>
      <text x="55" y="295" font-family="sans-serif" font-size="28" fill="black">SYNTHETIC OCR TEST FIXTURE</text>
    </svg>`,
  )).jpeg({ quality: 92 }).toBuffer();
  const expectedVin = "1HGCM82633A004352";
  const [lotPhoto, bodyPhoto, serialPhoto] = await Promise.all([
    svgPhoto("LOT #157", "Travel trailer - auction lot reference"),
    svgPhoto("Travel trailer", "Body detail - same single asset"),
    svgPhoto(`VIN: ${expectedVin}`, "Manufacturer serial plate - not a lot number"),
  ]);

  const server = createServer((request, response) => {
    const index = Number(/^\/photo-(\d+)\.jpg$/.exec(request.url || "")?.[1]);
    if (!Number.isInteger(index) || index < 1 || index > 104) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "image/jpeg" });
    response.end(index === 1 ? lotPhoto : index === 104 ? serialPhoto : bodyPhoto);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const urls = Array.from({ length: 104 }, (_, index) =>
      `http://127.0.0.1:${port}/photo-${index + 1}.jpg`,
    );
    const inputs = buildBundleLotNumberPhotoInputs(
      [{ count: 104, extraCount: 0, mode: "single_lot" }], urls,
    );
    assert.equal(inputs[0]?.sourceImageIndex, 0);
    const detected = await detectBundleLotNumbersFromPhotos(inputs);
    // Production deliberately falls back on detector failures. The smoke check
    // must distinguish that from an actual OCR mismatch without exposing secrets.
    if (providerFailure) throw providerFailure;
    assert.equal(detected.get(0), "157", "First-photo lot sticker was not recognized");
    const diagnostic = resolveBundleLotAnalysisPolicy({
      groupIndex: 0,
      sourceImageIndex: 0,
      detectedLotNumber: detected.get(0),
      mainImageCount: urls.length,
    });
    const indexes = selectBundleAnalysisImageIndexes(
      urls.map((_, index) => index), diagnostic,
    );
    assert.deepEqual(indexes, [...Array.from({ length: 99 }, (_, i) => i), 103]);
    const analysis = await analyzeBundle(
      indexes.map((index) => urls[index]), "single_lot", "en", "CAD", false,
    );
    assert.equal(analysis.lots.length, 1, "Fixture should remain one lot");
    assert.equal(String(analysis.lots[0]?.lot_number), "157");
    const serial = String(analysis.lots[0]?.serial_number || "")
      .replace(/[^a-z0-9]/gi, "").toUpperCase();
    assert.ok(serial.includes(expectedVin), "Final-photo VIN was not recognized");
    console.log(JSON.stringify({
      result: "passed", lotNumber: "157", finalPhotoVinRecognized: true,
      submittedPhotos: urls.length, analyzedPhotos: indexes.length,
      firstPhoto: indexes[0] + 1, lastPhoto: indexes[indexes.length - 1] + 1,
      providerRequests: requestCount, databaseWrites: 0, storageWrites: 0,
    }));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

main().catch((error: unknown) => {
  // Do not print provider request bodies, headers, URLs, or credentials.
  const failure = error as { code?: unknown; status?: unknown; name?: unknown };
  console.error("Bundle OCR smoke test failed", {
    name: String(failure?.name || "Error"),
    code: String(failure?.code || "smoke_assertion_failed"),
    status: typeof failure?.status === "number" ? failure.status : undefined,
  });
  process.exitCode = 1;
});
