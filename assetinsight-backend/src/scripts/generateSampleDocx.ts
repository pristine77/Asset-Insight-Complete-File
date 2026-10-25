/**
 * Generate Sample Asset DOCX Report for Testing
 *
 * Usage:
 *   npm run test:docx
 *   npm run sample:docx
 *
 * This script generates a full sample asset DOCX report in the ./reports
 * directory using the production assetDocxService flow:
 * 1. Build the custom cover page from CoverPage.docx
 * 2. Build the main asset report body
 * 3. Merge cover page + main report (+ optional CV)
 */

import { generateAssetDocxFromReport } from "../service/assetDocxService.js";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

async function sampleImageDataUrl(
  width: number,
  height: number,
  label: string,
  background: string
): Promise<string> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="${background}"/>` +
      `<rect x="16" y="16" width="${width - 32}" height="${height - 32}" fill="none" stroke="#ffffff" stroke-width="4"/>` +
      `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial" font-size="42" font-weight="700">${label}</text>` +
      `</svg>`
  );
  const png = await sharp(svg).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function main() {
  console.log("Generating sample asset DOCX report...\n");

  const now = new Date();
  const landscapePhoto = await sampleImageDataUrl(
    1200,
    720,
    "Equipment Photo",
    "#374151"
  );
  const portraitPhoto = await sampleImageDataUrl(
    720,
    1200,
    "Serial Plate",
    "#6B7280"
  );
  const sampleReport = {
    title: "Sample Asset Appraisal Report",
    client_name: "Acme Corp",
    prepared_for: "Acme Corp",
    effective_date: now.toISOString(),
    createdAt: now.toISOString(),
    report_date: now.toISOString(),
    user_email: "jane.doe@mcdougallauction.com",
    appraiser: "Jane Doe",
    inspector_name: "Jane Doe",
    appraiser_role: "Senior Appraiser",
    appraisal_company: "McDougall Auctioneers Ltd.",
    contract_number: "CV-2026-001",
    currency: "CAD",
    language: "en",
    summary:
      "Sample asset appraisal prepared to validate the full DOCX generation and merge flow.",
    valuation_methods: ["FML", "OLV"],
    valuation_data: {
      methods: [
        { method: "FML", value: 193000 },
        { method: "OLV", value: 173700 },
      ],
    },
    lots: [
      {
        lot_number: 1,
        lot_title: "2021 John Deere 310SL Backhoe",
        title: "2021 John Deere 310SL Backhoe",
        name: "2021 John Deere 310SL Backhoe",
        description:
          "Four-wheel-drive backhoe loader with enclosed cab, extendahoe, and general wear consistent with normal commercial use.",
        make: "John Deere",
        model: "310SL",
        year: "2021",
        serial_number: "1T0310SLCLF123456",
        condition: "Good",
        quantity: 1,
        appraised_value: 125000,
        market_value: 125000,
        liquidation_value: 112500,
        image_url: landscapePhoto,
        image_urls: [landscapePhoto, portraitPhoto],
      },
      {
        lot_number: 2,
        lot_title: "2019 Ford F-350 Service Truck",
        title: "2019 Ford F-350 Service Truck",
        name: "2019 Ford F-350 Service Truck",
        description:
          "Service truck with utility body, diesel engine, and field-ready configuration for construction support work.",
        make: "Ford",
        model: "F-350",
        year: "2019",
        serial_number: "1FT8W3BT8KEF65432",
        condition: "Good",
        quantity: 1,
        appraised_value: 68000,
        market_value: 68000,
        liquidation_value: 61200,
        image_url: portraitPhoto,
        image_urls: [portraitPhoto, landscapePhoto],
      },
    ],
    imageUrls: [landscapePhoto, portraitPhoto],
  };

  const buffer = await generateAssetDocxFromReport(sampleReport);

  const reportsDir = path.resolve(process.cwd(), "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const filenameSafeDate = now.toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(
    reportsDir,
    `sample-asset-report-${filenameSafeDate}.docx`
  );

  await fs.writeFile(outPath, buffer);

  console.log(`Sample asset DOCX report created: ${outPath}`);
  console.log("This sample uses assetDocxService, including cover page merge.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
