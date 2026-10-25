import fs from "fs/promises";
import path from "path";
import axios from "axios";
import AssetReport from "../../models/asset.model.js";
import PdfReport from "../../models/pdfReport.model.js";
import { enqueueReportJob } from "../../utils/reportJobQueue.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../../utils/reportArtifactNames.js";

// Queue approved-file promotion in the background to avoid blocking approval flows.
export async function queueDocxGenerationJob(reportId: string) {
  enqueueReportJob(`asset-docx-generation:${reportId}`, () =>
    runDocxGenerationJob(reportId).catch((e) => {
      console.error("[DocxGenJob] Failed:", e);
    })
  );
}

// Load preview-generated files, save local approved copies, and create file records.
export async function runDocxGenerationJob(reportId: string) {
  try {
    console.log(`\n⚠️  [DocxGenJob] CALLED FOR REPORT ${reportId}`);
    console.log("📍 Call stack trace:", new Error().stack);

    const report = await AssetReport.findById(reportId).populate("user");
    if (!report) {
      throw new Error(`Report ${reportId} not found`);
    }

    console.log(`📊 [DocxGenJob] Report status: ${report.status}`);

    if (report.status !== "approved") {
      console.error(
        `❌ [DocxGenJob] REJECTED - Report ${reportId} status is '${report.status}', expected 'approved'`
      );
      throw new Error(
        `Report ${reportId} status is ${report.status}, expected 'approved'`
      );
    }

    console.log(
      "✅ [DocxGenJob] Status check passed, proceeding with file generation..."
    );

    const user = report.user as any;

    console.log(`\n${"=".repeat(80)}`);
    console.log("📥 [DocxGenJob] PROMOTING PREVIEW FILES TO APPROVED STATUS");
    console.log(`${"=".repeat(80)}`);

    const artifactNames = buildReportArtifactFilenames({
      kind: "asset",
      contractNo: getReportContractNumber(report, reportId),
      reportId,
      fallback: reportId,
      lots: (report as any)?.preview_data?.lots || (report as any)?.lots,
    });
    const docxFilename = artifactNames.docx;
    const xlsxFilename = artifactNames.excel;
    const imagesZipFilename = artifactNames.imagesZip;
    const previewDocxUrl: string | undefined = (report as any)?.preview_files?.docx;
    const previewXlsxUrl: string | undefined =
      (report as any)?.preview_files?.excel ||
      (report as any)?.preview_files?.xlsx;
    const previewImagesUrl: string | undefined = (report as any)?.preview_files?.images;

    console.log(`🔗 Preview DOCX URL: ${previewDocxUrl || "MISSING!"}`);
    console.log(`🔗 Preview XLSX URL: ${previewXlsxUrl || "MISSING!"}`);
    console.log(`🔗 Preview Images URL: ${previewImagesUrl || "MISSING!"}`);

    if (!previewDocxUrl || !previewXlsxUrl || !previewImagesUrl) {
      throw new Error(
        `[DocxGenJob] Missing preview_files URLs for report ${reportId}`
      );
    }

    let docxBuffer: Buffer | undefined;
    let xlsxBuffer: Buffer | undefined;
    let imagesZipBuffer: Buffer | undefined;
    try {
      console.log("\n⬇️ Downloading preview files from R2...");
      const [docxRes, xlsxRes, imagesRes] = await Promise.all([
        axios.get(previewDocxUrl, { responseType: "arraybuffer" }),
        axios.get(previewXlsxUrl, { responseType: "arraybuffer" }),
        axios.get(previewImagesUrl, { responseType: "arraybuffer" }),
      ]);
      docxBuffer = Buffer.from(docxRes.data as ArrayBuffer);
      xlsxBuffer = Buffer.from(xlsxRes.data as ArrayBuffer);
      imagesZipBuffer = Buffer.from(imagesRes.data as ArrayBuffer);

      console.log(
        `✅ Downloaded DOCX: ${(docxBuffer.length / 1024 / 1024).toFixed(2)} MB`
      );
      console.log(
        `✅ Downloaded XLSX: ${(xlsxBuffer.length / 1024).toFixed(2)} KB`
      );
      console.log(
        `✅ Downloaded Images: ${(imagesZipBuffer.length / 1024 / 1024).toFixed(2)} MB`
      );
    } catch (error) {
      console.error(
        "❌ [DocxGenJob] Failed to download one or more preview files",
        error
      );
      throw error;
    }

    console.log("\n💾 Saving files locally for user download API...");
    const localDir = path.resolve(process.cwd(), "reports", String(user._id));
    try {
      await fs.mkdir(localDir, { recursive: true });
    } catch {}
    const localDocxPath = path.join(localDir, docxFilename);
    const localXlsxPath = path.join(localDir, xlsxFilename);
    const localImagesZipPath = path.join(localDir, imagesZipFilename);
    await Promise.all([
      fs.writeFile(localDocxPath, docxBuffer as Buffer),
      fs.writeFile(localXlsxPath, xlsxBuffer as Buffer),
      fs.writeFile(localImagesZipPath, imagesZipBuffer as Buffer),
    ]);

    console.log("✅ Saved to local filesystem:");
    console.log(`   📄 ${localDocxPath}`);
    console.log(`   📊 ${localXlsxPath}`);
    console.log(`   📦 ${localImagesZipPath}`);

    const addressStr = String(
      (report as any)?.client_name ||
        (report as any)?.preview_data?.client_name ||
        "Asset Report"
    );
    const currency = String(
      (report as any)?.preview_data?.currency || (report as any)?.currency || "CAD"
    );
    const rawTotal =
      (report as any)?.preview_data?.total_value ??
      (report as any)?.preview_data?.total_appraised_value;
    const totalNum =
      typeof rawTotal === "number"
        ? rawTotal
        : parseFloat(String(rawTotal || "0").replace(/[^0-9.-]+/g, ""));
    const fairMarketValueStr = Number.isFinite(totalNum)
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(totalNum)
      : currency;
    const contractNo =
      (report as any)?.contract_no || (report as any)?.preview_data?.contract_no || undefined;

    const docxRec = new PdfReport({
      user: user._id,
      report: reportId,
      reportType: "Asset",
      reportModel: "AssetReport",
      fileType: "docx",
      filePath: path.relative(process.cwd(), localDocxPath),
      filename: docxFilename,
      approvalStatus: "approved",
      address: addressStr,
      fairMarketValue: fairMarketValueStr,
      contract_no: contractNo,
      valuation_methods: (report as any)?.valuation_methods,
      valuation_data: (report as any)?.valuation_data,
    });

    const xlsxRec = new PdfReport({
      user: user._id,
      report: reportId,
      reportType: "Asset",
      reportModel: "AssetReport",
      fileType: "xlsx",
      filePath: path.relative(process.cwd(), localXlsxPath),
      filename: xlsxFilename,
      approvalStatus: "approved",
      address: addressStr,
      fairMarketValue: fairMarketValueStr,
      contract_no: contractNo,
      valuation_methods: (report as any)?.valuation_methods,
      valuation_data: (report as any)?.valuation_data,
    });

    const imagesRec = new PdfReport({
      user: user._id,
      report: reportId,
      reportType: "Asset",
      reportModel: "AssetReport",
      fileType: "images",
      filePath: path.relative(process.cwd(), localImagesZipPath),
      filename: imagesZipFilename,
      approvalStatus: "approved",
      address: addressStr,
      fairMarketValue: fairMarketValueStr,
      contract_no: contractNo,
      valuation_methods: (report as any)?.valuation_methods,
      valuation_data: (report as any)?.valuation_data,
    });

    await Promise.all([docxRec.save(), xlsxRec.save(), imagesRec.save()]);

    console.log(`[DocxGenJob] Completed successfully for report ${reportId}`);
  } catch (error) {
    console.error(`[DocxGenJob] Error for report ${reportId}:`, error);
    throw error;
  }
}
