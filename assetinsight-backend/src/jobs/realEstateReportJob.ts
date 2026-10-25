import {
  getR2PublicUrl,
  uploadToR2,
  uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";
import { prepareImageWithoutWatermark } from "../utils/imageProcessing.js";
import RealEstateReport from "../models/realEstate.model.js";
import PdfReport from "../models/pdfReport.model.js";
import {
  analyzeRealEstateImages,
  analyzeFarmlandImages,
  analyzeCommercialImages,
  type ExtractedFarmlandFeatures,
} from "../service/openAIService.js";
import {
  findComparableProperties,
  findFarmlandComparables,
  findCommercialComparables,
  type FarmlandSearchResult,
} from "../service/webSearchService.js";
import { calculateFairMarketValue } from "../service/valuationService.js";
import {
  calculateFarmlandValuation,
  calculateCostApproachAI,
  type SubjectProperty,
  type FarmlandComparable,
  type IncomeCapitalizationInput,
} from "../service/farmlandValuationService.js";
import {
  marketTrendSearch,
  type MarketTrend,
  type PropertyDetails,
} from "../service/marketTrendSebSearch.js";
import { generateRealEstateDocxFromReport } from "../service/realEstateDocxService.js";
import { generateRealEstateXlsx } from "../service/xlsx/realEstateXlsxService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { isReviewReportOwnerId } from "../service/reviewReportPolicy.js";
import {
  assignReportApprover,
  sendAssignedApprovalEmail,
} from "../service/approvalAssignmentService.js";
import {
  markReportAutoReleased,
} from "../service/reportReleaseService.js";
import fs from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";
import archiver from "archiver";
import {
  startProgress,
  updateProgress,
  endProgress,
  type StepRec as StoreStepRec,
} from "../utils/progressStore.js";
import { notifyUser } from "../service/notificationService.js";

export type RealEstateJobInput = {
  user: { id: string; name?: string; email?: string };
  images: Express.Multer.File[]; // Main images (unwatermarked, sent to AI)
  extraImages?: Express.Multer.File[]; // Extra images (unwatermarked, report only)
  videos?: Express.Multer.File[]; // Video files (included in zip only)
  details: any;
  progressId?: string;
};

export type RealEstateFilesJobOptions = {
  approveAfterGeneration?: boolean;
};

export function queueRealEstateReportJob(input: RealEstateJobInput) {
  setImmediate(() =>
    runRealEstateReportJob(input).catch((e) => {
      if (input.progressId)
        endProgress(
          input.progressId,
          false,
          "Error processing real estate request"
        );
      console.error("Real estate job failed:", e);
    })
  );
}

export async function runRealEstateReportJob({
  user,
  images,
  extraImages = [],
  videos = [],
  details,
  progressId,
}: RealEstateJobInput) {
  type StepRec = {
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  };
  const steps: StepRec[] = [];
  if (progressId) startProgress(progressId);
  const syncSteps = () =>
    progressId &&
    updateProgress(progressId, { steps: steps as unknown as StoreStepRec[] });
  const SERVER_WEIGHTS = {
    r2_upload: 0.18,
    ai_analysis: 0.22,
    find_comparables: 0.12,
    farmland_valuation: 0.12,
    valuation: 0.06,
    market_trend: 0.05,
    save_report: 0.05,
    generate_docx: 0.08,
    generate_xlsx: 0.04,
    save_files: 0.03,
    save_images_folder: 0.025,
    zip_images: 0.045,
  } as const;
  let accum = 0;
  const setProg = (delta: number) => {
    if (!progressId) return;
    accum = Math.min(1, accum + delta);
    updateProgress(progressId, { serverProgress01: accum });
  };
  const start = (key: keyof typeof SERVER_WEIGHTS, label: string) => {
    steps.push({ key, label, startedAt: new Date().toISOString() });
    syncSteps();
  };
  const end = (key: keyof typeof SERVER_WEIGHTS) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.key === key && !s.endedAt) {
        s.endedAt = new Date().toISOString();
        const st = s.startedAt ? new Date(s.startedAt).getTime() : Date.now();
        s.durationMs = new Date(s.endedAt).getTime() - st;
        break;
      }
    }
    syncSteps();
    setProg((SERVER_WEIGHTS as any)[key] ?? 0);
  };

  try {
    // Get property type from details
    const propertyType: "agricultural" | "commercial" | "residential" =
      details?.property_type === "agricultural" ||
      details?.property_details?.property_type === "agricultural"
        ? "agricultural"
        : details?.property_type === "commercial" ||
            details?.property_details?.property_type === "commercial"
          ? "commercial"
          : "residential";

    // 1) Upload new images without adding a watermark; retain HEIC compatibility.
    const imageUrls: string[] = [];
    if (images?.length) {
      start("r2_upload", "Processing and uploading images");
      const total = images.length;
      for (let idx = 0; idx < images.length; idx++) {
        const file = images[idx];
        const ts = Date.now();

        // Get input buffer
        const anyFile = file as any;
        let inputBuffer: Buffer | null = null;
        if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
          inputBuffer = anyFile.buffer as Buffer;
        } else if (typeof anyFile?.path === "string") {
          try {
            inputBuffer = await fs.readFile(anyFile.path);
          } catch {}
        }

        let fileUrl: string;
        if (inputBuffer) {
          try {
            const prepared = await prepareImageWithoutWatermark(
              inputBuffer,
              file.mimetype,
              file.originalname
            );
            const safeBase = String(file.originalname || `image-${idx + 1}`)
              .replace(/[^a-zA-Z0-9._-]/g, "-")
              .replace(/\.[^./\\]+$/, "");
            const fileName = `uploads/real-estate/${ts}-${safeBase}${prepared.extension}`;
            await uploadBufferToR2(
              prepared.buffer,
              prepared.mimetype,
              process.env.R2_BUCKET_NAME!,
              fileName
            );
            fileUrl = getR2PublicUrl(fileName);
            console.log(
              `✅ Real estate image prepared ${idx + 1}/${total}`
            );
          } catch (procErr) {
            console.warn(
              `⚠️ Image preparation failed for image ${idx + 1}, using original:`,
              procErr
            );
            const fileName = `uploads/real-estate/${ts}-${file.originalname}`;
            await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
            fileUrl = getR2PublicUrl(fileName);
          }
        } else {
          // Fallback to original upload method
          const fileName = `uploads/real-estate/${ts}-${file.originalname}`;
          await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
          fileUrl = getR2PublicUrl(fileName);
        }
        imageUrls.push(fileUrl);

        // Update progress
        if (progressId) {
          const partial = (idx + 1) / total;
          const current = accum + partial * SERVER_WEIGHTS.r2_upload;
          updateProgress(progressId, { serverProgress01: current });
        }
      }
      end("r2_upload");
    }

    // 1b) Prepare extra images without a watermark; they are not sent to AI.
    const extraImageUrls: string[] = [];
    if (extraImages?.length) {
      const total = extraImages.length;
      for (let idx = 0; idx < extraImages.length; idx++) {
        const file = extraImages[idx];
        const ts = Date.now();

        const anyFile = file as any;
        let inputBuffer: Buffer | null = null;
        if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
          inputBuffer = anyFile.buffer as Buffer;
        } else if (typeof anyFile?.path === "string") {
          try {
            inputBuffer = await fs.readFile(anyFile.path);
          } catch {}
        }

        let fileUrl: string;
        if (inputBuffer) {
          try {
            const prepared = await prepareImageWithoutWatermark(
              inputBuffer,
              file.mimetype,
              file.originalname
            );
            const safeBase = String(file.originalname || `extra-${idx + 1}`)
              .replace(/[^a-zA-Z0-9._-]/g, "-")
              .replace(/\.[^./\\]+$/, "");
            const fileName = `uploads/real-estate/extra/${ts}-${safeBase}${prepared.extension}`;
            await uploadBufferToR2(
              prepared.buffer,
              prepared.mimetype,
              process.env.R2_BUCKET_NAME!,
              fileName
            );
            fileUrl = getR2PublicUrl(fileName);
            console.log(`✅ Extra image prepared ${idx + 1}/${total}`);
          } catch (procErr) {
            console.warn(
              `⚠️ Image preparation failed for extra image ${idx + 1}:`,
              procErr
            );
            const fileName = `uploads/real-estate/extra/${ts}-${file.originalname}`;
            await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
            fileUrl = getR2PublicUrl(fileName);
          }
        } else {
          const fileName = `uploads/real-estate/extra/${ts}-${file.originalname}`;
          await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
          fileUrl = getR2PublicUrl(fileName);
        }
        extraImageUrls.push(fileUrl);
      }
    }

    // 2) AI extraction from images (property-type specific)
    start("ai_analysis", `Analyzing ${propertyType} property images with Software`);
    let aiExtractedData: any = {};
    let aiExtractedFeatures: ExtractedFarmlandFeatures | null = null;
    try {
      if (imageUrls.length > 0) {
        if (propertyType === "agricultural") {
          aiExtractedFeatures = await analyzeFarmlandImages(imageUrls);
          aiExtractedData = aiExtractedFeatures;
          console.log(
            "✅ Farmland AI analysis complete:",
            aiExtractedFeatures?.property_condition
          );
        } else if (propertyType === "commercial") {
          aiExtractedData = await analyzeCommercialImages(imageUrls);
          console.log("✅ Commercial AI analysis complete");
        } else {
          aiExtractedData = await analyzeRealEstateImages(imageUrls);
          console.log("✅ Residential AI analysis complete");
        }
      }
    } catch (e) {
      console.error(`AI analysis failed for ${propertyType} real-estate:`, e);
    }
    end("ai_analysis");

    // 3) Build final data from details
    const finalData = {
      ...details,
      owner_name: details?.property_details?.owner_name || "",
      house_details: { ...(details?.house_details || {}), ...aiExtractedData },
      imageUrls,
      extraImageUrls,
    };

    // 4) Find comparable properties (property-type specific)
    start("find_comparables", `Finding ${propertyType} comparable properties`);
    let comparableProperties: any = {};
    let farmlandComparables: FarmlandSearchResult[] = [];
    try {
      if (finalData.property_details?.address) {
        if (propertyType === "agricultural") {
          // Find farmland comparables
          const farmlandDetails = {
            address: finalData.property_details.address,
            municipality: finalData.property_details.municipality || "",
            rm_area:
              finalData.farmland_details?.rm_area ||
              finalData.property_details.municipality ||
              "",
            total_acres:
              parseFloat(
                finalData.farmland_details?.total_title_acres ||
                  finalData.property_details.land_area_acres
              ) || 160,
            cultivated_acres:
              parseFloat(finalData.farmland_details?.cultivated_acres) || 150,
          };
          farmlandComparables = await findFarmlandComparables(farmlandDetails);
          console.log(
            `✅ Found ${farmlandComparables.length} farmland comparables`
          );
        } else if (propertyType === "commercial") {
          comparableProperties = await findCommercialComparables({
            ...finalData.property_details,
            square_footage: finalData.house_details?.square_footage,
          });
        } else {
          comparableProperties = await findComparableProperties(
            finalData.property_details,
            finalData.house_details
          );
        }
      }
    } catch (e) {
      console.error(`Error finding ${propertyType} comparable properties:`, e);
    }
    end("find_comparables");

    // 5) Farmland Valuation (for agricultural properties)
    let farmlandValuation: any = null;
    const useDirectComparable = finalData.farmland_details?.use_direct_comparable === true;
    if (propertyType === "agricultural" && farmlandComparables.length > 0) {
      start("farmland_valuation", "Calculating farmland valuation");
      try {
        // Build subject property from user-provided details (if Direct Comparable selected) or defaults
        const subjectProperty: SubjectProperty = {
          // Use user-provided subject_name if available, otherwise fall back to address
          subject_name:
            finalData.farmland_details?.subject_name ||
            finalData.property_details?.address ||
            "Subject Property",
          // Use user-provided valuation_date if available
          valuation_date: finalData.farmland_details?.valuation_date
            ? new Date(finalData.farmland_details.valuation_date)
            : finalData.report_dates?.effective_date
            ? new Date(finalData.report_dates.effective_date)
            : new Date(),
          total_title_acres:
            parseFloat(
              finalData.farmland_details?.total_title_acres ||
                finalData.property_details?.land_area_acres
            ) || 160,
          cultivated_acres:
            parseFloat(finalData.farmland_details?.cultivated_acres) || 150,
          rm_area:
            finalData.farmland_details?.rm_area ||
            finalData.property_details?.municipality ||
            "",
          soil_class: finalData.farmland_details?.soil_class || "2",
          access_quality: finalData.farmland_details?.access_quality || "good",
          // Use user-provided notes if available, otherwise AI notes or description
          notes:
            finalData.farmland_details?.notes ||
            aiExtractedFeatures?.notes ||
            finalData.property_details?.description ||
            "",
        };
        
        console.log(`📊 Subject Property: ${subjectProperty.subject_name}`);
        console.log(`📅 Valuation Date: ${subjectProperty.valuation_date.toISOString().slice(0, 10)}`);

        // Convert search results to farmland comparables
        const comparables: FarmlandComparable[] = farmlandComparables.map(
          (fc) => ({
            comp_id: fc.comp_id,
            sale_date: new Date(fc.sale_date),
            rm_area: fc.rm_area,
            distance_to_subject_km: fc.distance_km,
            title_acres: fc.title_acres,
            cultivated_acres: fc.cultivated_acres,
            sale_price: fc.sale_price,
            price_per_cultivated_acre: fc.price_per_cultivated_acre,
            data_source: fc.data_source,
            notes: fc.notes,
          })
        );

        // Check which approaches user selected
        const useDirectComparable = finalData.farmland_details?.use_direct_comparable === true;
        const useIncomeApproach = finalData.farmland_details?.use_income_approach === true;
        const useCostApproach = finalData.farmland_details?.use_cost_approach === true;
        
        // Income capitalization input (if user selected income approach)
        const incomeInput: IncomeCapitalizationInput | undefined = useIncomeApproach
          ? {
              cultivated_acres: subjectProperty.cultivated_acres,
              market_rent_per_acre:
                parseFloat(finalData.farmland_details?.market_rent_per_acre) ||
                finalData.farmland_details?.annual_rent_per_acre || 80,
              vacancy_loss_percent: parseFloat(finalData.farmland_details?.vacancy_loss_percent) || 2.0,
              operating_expense_ratio: parseFloat(finalData.farmland_details?.operating_expense_ratio) || 20.0,
              cap_rate: parseFloat(finalData.farmland_details?.cap_rate) || 5.0,
            }
          : undefined;
        
        // Determine reconciliation weights based on selected approaches
        const approachCount = (useDirectComparable ? 1 : 0) + (useIncomeApproach ? 1 : 0) + (useCostApproach ? 1 : 0);
        let reconciliationWeights: { direct: number; income: number; cost: number } | undefined;
        
        if (approachCount === 3) {
          // All three: 50% direct, 30% income, 20% cost
          reconciliationWeights = { direct: 50, income: 30, cost: 20 };
        } else if (approachCount === 2) {
          if (useDirectComparable && useIncomeApproach) {
            reconciliationWeights = { direct: 70, income: 30, cost: 0 };
          } else if (useDirectComparable && useCostApproach) {
            reconciliationWeights = { direct: 70, income: 0, cost: 30 };
          } else if (useIncomeApproach && useCostApproach) {
            reconciliationWeights = { direct: 0, income: 60, cost: 40 };
          }
        } else if (approachCount === 1) {
          if (useDirectComparable) {
            reconciliationWeights = { direct: 100, income: 0, cost: 0 };
          } else if (useIncomeApproach) {
            reconciliationWeights = { direct: 0, income: 100, cost: 0 };
          } else if (useCostApproach) {
            reconciliationWeights = { direct: 0, income: 0, cost: 100 };
          }
        }
        
        console.log(`📊 Valuation approaches: Direct=${useDirectComparable}, Income=${useIncomeApproach}, Cost=${useCostApproach}`);

        // Calculate full farmland valuation
        farmlandValuation = calculateFarmlandValuation(
          subjectProperty,
          comparables,
          incomeInput,
          undefined, // Use default adjustment rates
          reconciliationWeights
        );
        
        // AI-calculated Cost Approach (if selected)
        if (useCostApproach) {
          try {
            const costApproachResult = await calculateCostApproachAI(
              subjectProperty,
              aiExtractedFeatures,
              finalData.farmland_details
            );
            farmlandValuation.cost_approach = costApproachResult;
            
            // Update reconciliation if cost approach calculated
            if (costApproachResult && reconciliationWeights) {
              const directWeighted = (farmlandValuation.direct_comparison_value || 0) * (reconciliationWeights.direct / 100);
              const incomeWeighted = (farmlandValuation.income_capitalization?.indicated_value || 0) * (reconciliationWeights.income / 100);
              const costWeighted = costApproachResult.indicated_value * (reconciliationWeights.cost / 100);
              
              farmlandValuation.reconciliation = {
                ...farmlandValuation.reconciliation,
                cost_value: costApproachResult.indicated_value,
                cost_weight: reconciliationWeights.cost,
                cost_weighted: Math.round(costWeighted),
                final_reconciled_value: Math.round(directWeighted + incomeWeighted + costWeighted),
              };
              farmlandValuation.fair_market_value = farmlandValuation.reconciliation.final_reconciled_value;
              farmlandValuation.fair_market_value_formatted = `$${farmlandValuation.fair_market_value.toLocaleString()}`;
            }
            console.log(`✅ Cost Approach calculated: $${costApproachResult.indicated_value.toLocaleString()}`);
          } catch (costErr) {
            console.error("Error calculating Cost Approach:", costErr);
          }
        }
        
        // Store which approaches were used
        farmlandValuation.approaches_used = {
          direct_comparable: useDirectComparable,
          income_capitalization: useIncomeApproach,
          cost_approach: useCostApproach,
        };

        console.log(
          `✅ Farmland valuation complete: ${farmlandValuation.fair_market_value_formatted}`
        );
      } catch (e) {
        console.error("Error calculating farmland valuation:", e);
      }
      end("farmland_valuation");
    }

    // 6) Standard Valuation (for residential/commercial or as fallback)
    start("valuation", "Calculating fair market value");
    let valuation: any = {};
    try {
      const compsArr = Array.isArray(comparableProperties)
        ? comparableProperties
        : [];
      if (compsArr.length > 0) {
        valuation = await calculateFairMarketValue(finalData, compsArr);
      } else if (farmlandValuation) {
        // Use farmland valuation results for valuation field
        const approaches = farmlandValuation.approaches_used;
        const approachList: string[] = [];
        if (approaches?.direct_comparable) approachList.push("Direct Comparison");
        if (approaches?.income_capitalization) approachList.push("Income Capitalization");
        if (approaches?.cost_approach) approachList.push("Cost Approach");
        
        const valueSource = approachList.length > 1 
          ? `Farmland ${approachList.join(" + ")} (Reconciled)`
          : `Farmland ${approachList[0] || "Valuation"}`;
        
        let summary = "";
        if (approachList.length >= 2) {
          summary = `Reconciled value from ${approachList.length} approaches: `;
          if (approaches?.direct_comparable) summary += `Direct ($${farmlandValuation.weighted_average_rate}/ac), `;
          if (approaches?.income_capitalization) summary += `Income ($${farmlandValuation.income_capitalization?.indicated_value_per_acre}/ac), `;
          if (approaches?.cost_approach) summary += `Cost ($${farmlandValuation.cost_approach?.indicated_value?.toLocaleString()}), `;
          summary = summary.slice(0, -2) + ".";
        } else if (approaches?.direct_comparable) {
          summary = `Based on ${farmlandValuation.comparables?.length || 0} comparable sales with weighted average rate of $${farmlandValuation.weighted_average_rate}/cultivated acre.`;
        } else if (approaches?.income_capitalization) {
          summary = `Based on income capitalization with market rent of $${farmlandValuation.income_capitalization?.market_rent_per_acre}/acre, ${farmlandValuation.income_capitalization?.cap_rate}% cap rate.`;
        } else if (approaches?.cost_approach) {
          summary = `Based on Cost Approach: Land value $${farmlandValuation.cost_approach?.land_value?.toLocaleString()}, improvements $${farmlandValuation.cost_approach?.depreciated_cost_of_improvements?.toLocaleString()}.`;
        }
        
        valuation = {
          fair_market_value: farmlandValuation.fair_market_value_formatted,
          value_source: valueSource,
          final_estimate_value: farmlandValuation.fair_market_value_formatted,
          final_estimate_summary: summary,
          details: JSON.stringify(farmlandValuation.reconciliation),
        };
      }
    } catch (e) {
      console.error("Error during valuation:", e);
    }
    end("valuation");

    // 7) Market trend
    start("market_trend", "Fetching market trend");
    let marketTrendData: MarketTrend[] = [];
    try {
      const p: PropertyDetails = {
        address: finalData.property_details?.address,
        municipality: finalData.property_details?.municipality,
      } as any;
      if (p.address && p.municipality)
        marketTrendData = await marketTrendSearch(p);
    } catch (e) {
      console.error("Error fetching market trend:", e);
    }
    end("market_trend");

    // 8) Save DB record
    start("save_report", "Saving report to database");
    const comparablePropertiesMap = new Map();
    const compsForMap = Array.isArray(comparableProperties)
      ? comparableProperties
      : [];
    compsForMap.forEach((comp: any) => {
      const { name, ...rest } = comp || {};
      comparablePropertiesMap.set(name, rest);
    });

    // Build farmland_details from input and AI extracted data
    const farmlandDetailsToSave =
      propertyType === "agricultural"
        ? {
            total_title_acres:
              parseFloat(
                details?.farmland_details?.total_title_acres ||
                  details?.property_details?.land_area_acres
              ) || undefined,
            cultivated_acres:
              parseFloat(details?.farmland_details?.cultivated_acres) ||
              undefined,
            rm_area:
              details?.farmland_details?.rm_area ||
              details?.property_details?.municipality ||
              undefined,
            soil_class:
              details?.farmland_details?.soil_class ||
              aiExtractedFeatures?.soil_quality_estimate ||
              undefined,
            crop_type:
              details?.farmland_details?.crop_type ||
              aiExtractedFeatures?.crop_type ||
              undefined,
            is_rented: details?.farmland_details?.is_rented || false,
            annual_rent_per_acre:
              parseFloat(details?.farmland_details?.annual_rent_per_acre) ||
              undefined,
            irrigation: details?.farmland_details?.irrigation || false,
            access_quality:
              details?.farmland_details?.access_quality ||
              (aiExtractedFeatures?.access_roads
                ?.toLowerCase()
                .includes("paved")
                ? "excellent"
                : aiExtractedFeatures?.access_roads
                      ?.toLowerCase()
                      .includes("gravel")
                  ? "good"
                  : "fair"),
            distance_to_city_km:
              parseFloat(details?.farmland_details?.distance_to_city_km) ||
              undefined,
            // Direct Comparable Approach fields
            use_direct_comparable: details?.farmland_details?.use_direct_comparable || false,
            subject_name: details?.farmland_details?.subject_name || undefined,
            valuation_date: details?.farmland_details?.valuation_date
              ? new Date(details.farmland_details.valuation_date)
              : undefined,
            notes: details?.farmland_details?.notes || undefined,
            // Income Capitalization Approach fields
            use_income_approach: details?.farmland_details?.use_income_approach || false,
            market_rent_per_acre: parseFloat(details?.farmland_details?.market_rent_per_acre) || undefined,
            vacancy_loss_percent: parseFloat(details?.farmland_details?.vacancy_loss_percent) || 2,
            operating_expense_ratio: parseFloat(details?.farmland_details?.operating_expense_ratio) || 20,
            cap_rate: parseFloat(details?.farmland_details?.cap_rate) || 5,
            // Cost Approach (AI-calculated)
            use_cost_approach: details?.farmland_details?.use_cost_approach || false,
          }
        : undefined;

    const newReport = new RealEstateReport({
      ...finalData,
      user: user.id,
      farmland_details: farmlandDetailsToSave,
      ai_extracted_features: aiExtractedFeatures || undefined,
      farmland_valuation: farmlandValuation || undefined,
      comparableProperties: comparablePropertiesMap,
      valuation,
      marketTrend: marketTrendData,
      language: ((): "en" | "fr" | "es" => {
        const l = String(details?.language || "").toLowerCase();
        return l === "fr" || l === "es" ? (l as any) : "en";
      })(),
    });
    await newReport.save();
    end("save_report");

    // 9) Generate outputs (DOCX and Excel only - no PDF)
    const reportObjForDocs = newReport.toObject();
    reportObjForDocs.comparableProperties = Object.fromEntries(
      comparablePropertiesMap
    );
    const [docxBuffer, xlsxBuffer] = await Promise.all([
      (async () => {
        start("generate_docx", "Generating DOCX");
        const b = await generateRealEstateDocxFromReport(reportObjForDocs);
        end("generate_docx");
        return b;
      })(),
      (async () => {
        start("generate_xlsx", "Generating Excel");
        const b = await generateRealEstateXlsx(reportObjForDocs);
        end("generate_xlsx");
        return b;
      })(),
    ]);

    // 10) Save files and create PdfReport entries
    start("save_files", "Saving generated files");
    const reportsDir = path.resolve(process.cwd(), "reports");
    await fs.mkdir(reportsDir, { recursive: true });
    const ts = Date.now();
    const baseName = `real-estate-report-${newReport._id}-${ts}`;
    const docxFilename = `${baseName}.docx`;
    const xlsxFilename = `${baseName}.xlsx`;
    const docxPath = path.join(reportsDir, docxFilename);
    const xlsxPath = path.join(reportsDir, xlsxFilename);
    await Promise.all([
      fs.writeFile(docxPath, docxBuffer),
      fs.writeFile(xlsxPath, xlsxBuffer),
    ]);

    // Save images (main, extra, video) to organized folders and create ZIP
    const imagesFolderName = `${baseName}-images`;
    const imagesDirPath = path.join(reportsDir, imagesFolderName);
    const mainImagesDir = path.join(imagesDirPath, "main");
    const extraImagesDir = path.join(imagesDirPath, "extra");
    const videosDir = path.join(imagesDirPath, "videos");
    const imagesZipFilename = `${imagesFolderName}.zip`;
    const imagesZipPath = path.join(reportsDir, imagesZipFilename);
    try {
      start("save_images_folder", "Saving images to organized folders");
      await fs.mkdir(mainImagesDir, { recursive: true });
      await fs.mkdir(extraImagesDir, { recursive: true });
      await fs.mkdir(videosDir, { recursive: true });

      const extFromMime = (m?: string) => {
        if (!m) return "";
        if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
        if (m.includes("png")) return ".png";
        if (m.includes("webp")) return ".webp";
        if (m.includes("heic")) return ".heic";
        if (m.includes("heif")) return ".heif";
        if (m.includes("gif")) return ".gif";
        if (m.includes("bmp")) return ".bmp";
        if (m.includes("tiff")) return ".tiff";
        if (m.includes("mp4")) return ".mp4";
        if (m.includes("mov")) return ".mov";
        if (m.includes("avi")) return ".avi";
        if (m.includes("webm")) return ".webm";
        return "";
      };
      const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

      // Save main images
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const orig = file.originalname || "";
        const fallback = `main-${String(i + 1).padStart(3, "0")}`;
        const ext =
          path.extname(orig) || extFromMime((file as any)?.mimetype) || ".jpg";
        const base =
          sanitize((orig && orig.split("/").pop()!) || fallback) +
          (path.extname(orig) ? "" : ext);
        const filePath = path.join(mainImagesDir, base);
        await fs.writeFile(filePath, file.buffer);
      }

      // Save extra images
      for (let i = 0; i < extraImages.length; i++) {
        const file = extraImages[i];
        const orig = file.originalname || "";
        const fallback = `extra-${String(i + 1).padStart(3, "0")}`;
        const ext =
          path.extname(orig) || extFromMime((file as any)?.mimetype) || ".jpg";
        const base =
          sanitize((orig && orig.split("/").pop()!) || fallback) +
          (path.extname(orig) ? "" : ext);
        const filePath = path.join(extraImagesDir, base);
        await fs.writeFile(filePath, file.buffer);
      }

      // Save videos
      for (let i = 0; i < videos.length; i++) {
        const file = videos[i];
        const orig = file.originalname || "";
        const fallback = `video-${String(i + 1).padStart(3, "0")}`;
        const ext =
          path.extname(orig) || extFromMime((file as any)?.mimetype) || ".mp4";
        const base =
          sanitize((orig && orig.split("/").pop()!) || fallback) +
          (path.extname(orig) ? "" : ext);
        const filePath = path.join(videosDir, base);
        await fs.writeFile(filePath, file.buffer);
      }
      end("save_images_folder");

      start("zip_images", "Zipping images folder");
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(imagesZipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        output.on("close", () => resolve());
        archive.on("error", (err: any) => reject(err));
        archive.pipe(output);
        archive.directory(imagesDirPath, false);
        archive.finalize();
      });
      end("zip_images");
    } catch (e) {
      console.error("Failed saving/zipping images folder (real-estate)", e);
    }
    const baseRec = {
      user: user.id,
      report: newReport._id,
      reportType: "RealEstate" as const,
      reportModel: "RealEstateReport" as const,
      address: newReport.property_details?.address || "",
      fairMarketValue: newReport.valuation?.fair_market_value || "",
    };
    const approvalRecords = [
      new PdfReport({
        ...baseRec,
        filename: docxFilename,
        fileType: "docx",
        filePath: path.join("reports", docxFilename),
      }),
      new PdfReport({
        ...baseRec,
        filename: xlsxFilename,
        fileType: "xlsx",
        filePath: path.join("reports", xlsxFilename),
      }),
      new PdfReport({
        ...baseRec,
        filename: imagesZipFilename,
        fileType: "images",
        filePath: path.join("reports", imagesZipFilename),
        imagesFolderPath: path.join("reports", imagesFolderName),
      }),
    ];
    for (const record of approvalRecords) {
      await assignReportApprover(record, { userId: user.id });
    }
    await sendAssignedApprovalEmail(approvalRecords[0], {
      reportType: "Real Estate",
      creatorUserId: user.id,
      title: newReport.property_details?.address || "Real Estate Report",
      summary: newReport.valuation?.fair_market_value || "",
    });
    await Promise.all(approvalRecords.map((record) => record.save()));
    end("save_files");

    // 11) Email user (submitted for approval)
    try {
      const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
      const subject = "Your Real Estate reports were submitted for approval";
      const html = `
        <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
          <h2 style="margin:0 0 12px">Real Estate Reports Submitted</h2>
          <p>Hello${user?.name ? ` ${user.name}` : ""},</p>
          <p>Your Real Estate report outputs (DOCX, Excel, and Images ZIP) have been generated and submitted for admin approval.</p>
          <ul>
            <li>DOCX: ${docxFilename}</li>
            <li>Excel: ${xlsxFilename}</li>
            <li>Images: ${imagesZipFilename}</li>
          </ul>
          <p>You will receive an email when your reports are approved and ready to download.</p>
          <p><a href="${webUrl}/reports" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Go to Reports</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
          <p style="font-size:12px;color:#777">Asset Insight</p>
        </div>
      `;
      if (user?.email) {
        await sendEmail(user.email, subject, html);
      }
    } catch (e) {
      console.error("Failed to send completion email:", e);
    }

    if (progressId)
      endProgress(progressId, true, "Report generated successfully");
  } catch (e) {
    if (progressId)
      endProgress(progressId, false, "Error during report generation");
    console.error("runRealEstateReportJob error:", e);
    throw e;
  }
}

// =============================================================================
// NEW PREVIEW WORKFLOW (similar to asset reports)
// =============================================================================

/**
 * Queue a preview job (processes images, AI analysis, saves preview_data)
 */
export function queueRealEstatePreviewJob(input: RealEstateJobInput) {
  setImmediate(() =>
    runRealEstatePreviewJob(input).catch((e) => {
      if (input.progressId)
        endProgress(input.progressId, false, "Error processing request");
      console.error("Real estate preview job failed:", e);
    })
  );
}

/** Use the same selected-method contract as legacy generation in the preview path. */
export async function calculatePreviewFarmlandValuation(
  details: any,
  aiExtractedFeatures: any,
  searchResults: FarmlandSearchResult[]
) {
  const farmland = details.farmland_details || {};
  const numberOr = (value: unknown, fallback: number): number => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("Invalid farmland valuation input");
    return parsed;
  };
  const subject: SubjectProperty = {
    subject_name: farmland.subject_name || details.property_details?.address || "Subject Property",
    valuation_date: new Date(farmland.valuation_date || details.report_dates?.effective_date || Date.now()),
    total_title_acres: numberOr(farmland.total_title_acres, numberOr(details.property_details?.land_area_acres, 160)),
    cultivated_acres: numberOr(farmland.cultivated_acres, 120),
    rm_area: farmland.rm_area || details.property_details?.municipality || "",
    soil_class: farmland.soil_class || aiExtractedFeatures?.soil_quality_estimate || "Class 2-3",
    access_quality: farmland.access_quality || "good",
    notes: farmland.notes || aiExtractedFeatures?.notes || details.property_details?.description || "",
  };
  if (!Number.isFinite(subject.valuation_date.getTime()) || subject.total_title_acres < 0 || subject.cultivated_acres < 0) {
    throw new Error("Invalid farmland subject details");
  }

  // Older clients omitted the approach flags and received the calculator's 70/30
  // direct/income blend. Only explicit selections replace that legacy behavior.
  const hasSelections = ["use_direct_comparable", "use_income_approach", "use_cost_approach"]
    .some((key) => typeof farmland[key] === "boolean");
  const useDirect = hasSelections ? farmland.use_direct_comparable === true : true;
  const useIncome = hasSelections ? farmland.use_income_approach === true : true;
  const useCost = hasSelections && farmland.use_cost_approach === true;
  const count = Number(useDirect) + Number(useIncome) + Number(useCost);
  if (count === 0) return null;
  const weights = count === 3
    ? { direct: 50, income: 30, cost: 20 }
    : count === 2
      ? useDirect
        ? { direct: 70, income: useIncome ? 30 : 0, cost: useCost ? 30 : 0 }
        : { direct: 0, income: 60, cost: 40 }
      : { direct: useDirect ? 100 : 0, income: useIncome ? 100 : 0, cost: useCost ? 100 : 0 };

  const comparables: FarmlandComparable[] = useDirect ? searchResults.map((comp) => ({
    comp_id: comp.comp_id,
    sale_date: new Date(comp.sale_date),
    rm_area: comp.rm_area,
    distance_to_subject_km: comp.distance_km,
    title_acres: comp.title_acres,
    cultivated_acres: comp.cultivated_acres,
    sale_price: comp.sale_price,
    price_per_cultivated_acre: comp.price_per_cultivated_acre,
    data_source: comp.data_source,
    notes: comp.notes,
  })) : [];
  let income: IncomeCapitalizationInput | undefined;
  if (useIncome && hasSelections) {
    income = {
      cultivated_acres: subject.cultivated_acres,
      market_rent_per_acre: numberOr(farmland.market_rent_per_acre, numberOr(farmland.annual_rent_per_acre, 80)),
      vacancy_loss_percent: numberOr(farmland.vacancy_loss_percent, 2),
      operating_expense_ratio: numberOr(farmland.operating_expense_ratio, 20),
      cap_rate: numberOr(farmland.cap_rate, 5),
    };
  } else if (useIncome && farmland.is_rented && farmland.annual_rent_per_acre) {
    income = {
      cultivated_acres: subject.cultivated_acres,
      market_rent_per_acre: numberOr(farmland.annual_rent_per_acre, 80),
    };
  }
  if (useIncome && (subject.cultivated_acres <= 0 || (income?.cap_rate ?? 5) <= 0)) {
    throw new Error("Income valuation requires positive cultivated acres and capitalization rate");
  }
  if (income && (income.market_rent_per_acre < 0 || (income.vacancy_loss_percent ?? 2) < 0 ||
    (income.vacancy_loss_percent ?? 2) > 100 || (income.operating_expense_ratio ?? 20) < 0 ||
    (income.operating_expense_ratio ?? 20) > 100)) {
    throw new Error("Invalid farmland income valuation input");
  }

  const result = calculateFarmlandValuation(subject, comparables, income, undefined, weights);
  if (!useIncome) {
    // The legacy calculator always computes a default income indication. It must
    // not appear as an applied value when this preview did not select income.
    result.reconciliation.income_value = 0;
    result.reconciliation.income_weighted = 0;
  }
  if (useCost) {
    // Do not publish a partial weighted value if the selected cost calculation fails.
    const cost = await calculateCostApproachAI(subject, aiExtractedFeatures, farmland);
    if (!cost || !Number.isFinite(cost.indicated_value) || cost.indicated_value < 0) {
      throw new Error("Cost approach did not return a valid valuation");
    }
    result.cost_approach = cost;
    const costWeighted = Math.round(cost.indicated_value * weights.cost / 100);
    const finalValue = result.reconciliation.direct_comparison_weighted +
      result.reconciliation.income_weighted + costWeighted;
    result.reconciliation = {
      ...result.reconciliation,
      cost_value: cost.indicated_value,
      cost_weight: weights.cost,
      cost_weighted: costWeighted,
      final_reconciled_value: finalValue,
    };
    result.fair_market_value = finalValue;
    result.fair_market_value_formatted = new Intl.NumberFormat("en-CA", {
      style: "currency", currency: "CAD", maximumFractionDigits: 0, minimumFractionDigits: 0,
    }).format(finalValue);
  }
  if (!Number.isFinite(result.fair_market_value)) {
    throw new Error("Valuation did not return a finite result");
  }
  return {
    ...result,
    income_capitalization: useIncome ? result.income_capitalization : undefined,
    approaches_used: { direct_comparable: useDirect, income_capitalization: useIncome, cost_approach: useCost },
  };
}

/**
 * NEW PREVIEW WORKFLOW: Process images, extract data, store in preview_data
 * Does NOT generate DOCX - that happens after user submits for approval
 */
export async function runRealEstatePreviewJob({
  user,
  images,
  extraImages = [],
  videos = [],
  details,
  progressId,
}: RealEstateJobInput) {
  try {
    if (progressId) startProgress(progressId);
    console.log(`[RealEstatePreviewJob] Starting for user ${user.id}`);

    // Phase 1: Upload images to R2
    console.log(`[RealEstatePreviewJob] Uploading ${images.length} main images, ${extraImages.length} extra images`);
    
    const uploadImage = async (file: Express.Multer.File, prefix: string, idx: number): Promise<string> => {
      const sanitizedName = String(file.originalname || `${prefix}-${idx + 1}.jpg`)
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/--+/g, "-");
      const safeBase = sanitizedName.replace(/\.[^./\\]+$/, "");
      try {
        const prepared = await prepareImageWithoutWatermark(
          file.buffer,
          file.mimetype,
          file.originalname
        );
        const imageFile = `uploads/real-estate/${Date.now()}-${idx + 1}-${safeBase}${prepared.extension}`;
        await uploadBufferToR2(
          prepared.buffer,
          prepared.mimetype,
          process.env.R2_BUCKET_NAME!,
          imageFile
        );
        return getR2PublicUrl(imageFile);
      } catch {
        // Fallback: upload original
        const fallbackName = `uploads/real-estate/${Date.now()}-${idx + 1}-${sanitizedName}`;
        await uploadBufferToR2(
          file.buffer,
          file.mimetype || "image/jpeg",
          process.env.R2_BUCKET_NAME!,
          fallbackName
        );
        return getR2PublicUrl(fallbackName);
      }
    };

    // Upload main images (for AI)
    const mainImageUrls: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const url = await uploadImage(images[i], "main", i);
      mainImageUrls.push(url);
    }

    // Upload extra images (report only)
    const extraImageUrls: string[] = [];
    for (let i = 0; i < extraImages.length; i++) {
      const url = await uploadImage(extraImages[i], "extra", i);
      extraImageUrls.push(url);
    }

    // Upload videos to R2
    const videoUrls: string[] = [];
    for (let i = 0; i < videos.length; i++) {
      const file = videos[i];
      const sanitizedName = String(file.originalname || `video-${i + 1}.mp4`)
        .replace(/[^a-zA-Z0-9._-]/g, "-");
      const videoFile = `uploads/real-estate/videos/${Date.now()}-${sanitizedName}`;
      await uploadBufferToR2(
        file.buffer,
        file.mimetype || "video/mp4",
        process.env.R2_BUCKET_NAME!,
        videoFile
      );
      videoUrls.push(getR2PublicUrl(videoFile));
    }

    console.log(`[RealEstatePreviewJob] Uploaded: ${mainImageUrls.length} main, ${extraImageUrls.length} extra, ${videoUrls.length} videos`);

    // Phase 2: AI Analysis
    console.log(`[RealEstatePreviewJob] Starting AI analysis`);
    const propertyType = details?.property_type || "residential";
    const language: "en" | "fr" | "es" = ((): any => {
      const l = String(details?.language || "").toLowerCase();
      return l === "fr" || l === "es" ? l : "en";
    })();

    let aiExtractedFeatures: any = null;
    let comparableProperties: any = {};
    let farmlandValuation: any = null;
    let valuationWarning: string | undefined;
    let marketTrendData: any[] = [];
    let valuation: any = {};

    // Limit AI analysis to max 50 images
    const aiUrls = mainImageUrls.slice(0, 50);
    
    if (aiUrls.length > 0) {
      try {
        if (propertyType === "agricultural") {
          aiExtractedFeatures = await analyzeFarmlandImages(aiUrls);
        } else if (propertyType === "commercial") {
          aiExtractedFeatures = await analyzeCommercialImages(aiUrls);
        } else {
          aiExtractedFeatures = await analyzeRealEstateImages(aiUrls);
        }
        console.log("[RealEstatePreviewJob] AI analysis complete");
      } catch (e) {
        console.error("[RealEstatePreviewJob] AI analysis failed:", e);
      }
    }

    // Phase 3: Find comparables
    console.log(`[RealEstatePreviewJob] Finding comparables`);
    const address = details?.property_details?.address;
    if (address) {
      try {
        if (propertyType === "agricultural") {
          const farmlandSearch = await findFarmlandComparables({
            address: address,
            municipality: details?.property_details?.municipality || "",
            rm_area: details?.farmland_details?.rm_area,
            total_acres: details?.farmland_details?.total_title_acres || 160,
            cultivated_acres: details?.farmland_details?.cultivated_acres || 120,
          });
          comparableProperties = farmlandSearch;
        } else if (propertyType === "commercial") {
          comparableProperties = await findCommercialComparables({
            address: details?.property_details?.address,
            municipality: details?.property_details?.municipality,
          });
        } else {
          comparableProperties = await findComparableProperties(
            details?.property_details,
            details?.house_details
          );
        }
      } catch (e) {
        console.error("[RealEstatePreviewJob] Comparables search failed:", e);
      }
    }

    // Phase 4: Valuation
    console.log(`[RealEstatePreviewJob] Calculating valuation`);
    if (propertyType === "agricultural" && details?.farmland_details) {
      try {
        farmlandValuation = await calculatePreviewFarmlandValuation(
          details,
          aiExtractedFeatures,
          Array.isArray(comparableProperties) ? comparableProperties : []
        );
        if (!farmlandValuation) {
          valuationWarning = "No valuation approach was selected. Review the valuation before submitting this report.";
        }
      } catch (e) {
        console.error("[RealEstatePreviewJob] Farmland valuation failed:", e);
        valuationWarning = "The selected valuation approaches could not be completed. Review the valuation inputs and results before submitting this report.";
      }
    } else {
      // Residential/commercial valuation
      const compArray = Array.isArray(comparableProperties) ? comparableProperties : [];
      if (compArray.length > 0) {
        try {
          const finalData = {
            ...details,
            house_details: { ...details.house_details, ...aiExtractedFeatures },
          };
          valuation = await calculateFairMarketValue(finalData, compArray);
        } catch (e) {
          console.error("[RealEstatePreviewJob] Valuation failed:", e);
        }
      }
    }

    // Phase 5: Market trends
    if (address && details?.property_details?.municipality) {
      try {
        const propertyDetails: PropertyDetails = {
          address,
          municipality: details.property_details.municipality,
        };
        marketTrendData = await marketTrendSearch(propertyDetails);
      } catch (e) {
        console.error("[RealEstatePreviewJob] Market trend search failed:", e);
      }
    }

    // Phase 6: Generate AI content for report sections
    console.log(`[RealEstatePreviewJob] Generating AI content for report`);
    let aiGeneratedContent: any = {};
    try {
      const { generateRealEstateReportContent } = await import("../service/realEstateAIContent.js");
      const reportDataForAI = {
        ...details,
        ai_extracted_features: aiExtractedFeatures,
        farmland_valuation: farmlandValuation,
        valuation,
        comparableProperties,
        marketTrend: marketTrendData,
      };
      aiGeneratedContent = await generateRealEstateReportContent(reportDataForAI);
    } catch (e) {
      console.error("[RealEstatePreviewJob] AI content generation failed:", e);
    }

    // Phase 7: Create report with preview_data
    console.log(`[RealEstatePreviewJob] Saving report with preview data`);
    const comparablePropertiesMap = new Map();
    if (Array.isArray(comparableProperties)) {
      comparableProperties.forEach((comp: any, idx: number) => {
        const name = comp.name || comp.address || `Comparable ${idx + 1}`;
        const { name: _, ...rest } = comp;
        comparablePropertiesMap.set(name, rest);
      });
    }

    const fmv = farmlandValuation?.fair_market_value_formatted || valuation?.fair_market_value || "";

    const newReport = new RealEstateReport({
      user: user.id,
      language,
      status: "preview", // NEW: Set to preview status
      property_type: propertyType,
      property_details: details?.property_details,
      report_dates: details?.report_dates,
      house_details: { ...details?.house_details, ...aiExtractedFeatures },
      inspector_info: details?.inspector_info,
      imageUrls: mainImageUrls,
      extraImageUrls,
      videoUrls,
      farmland_details: details?.farmland_details,
      ai_extracted_features: aiExtractedFeatures,
      farmland_valuation: farmlandValuation,
      comparableProperties: comparablePropertiesMap,
      valuation,
      marketTrend: marketTrendData,
      // Preview data - editable by user
      preview_data: {
        // Form data
        property_type: propertyType,
        language,
        property_details: details?.property_details,
        report_dates: details?.report_dates,
        house_details: { ...details?.house_details, ...aiExtractedFeatures },
        inspector_info: details?.inspector_info,
        farmland_details: details?.farmland_details,
        // AI-extracted data
        ai_extracted_features: aiExtractedFeatures,
        // Valuation data
        farmland_valuation: farmlandValuation,
        valuation,
        comparableProperties: Object.fromEntries(comparablePropertiesMap),
        marketTrend: marketTrendData,
        fair_market_value: fmv,
        ...(valuationWarning ? { valuation_warning: valuationWarning } : {}),
        // AI-generated report content (editable)
        ai_content: aiGeneratedContent,
      },
    });

    await newReport.save();
    console.log(`[RealEstatePreviewJob] Report saved: ${newReport._id}, status: preview`);

    // Phase 8: Send "Preview Ready" email
    try {
      const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
      const subject = "Your Real Estate Report Preview is Ready";
      const html = `
        <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
          <h2 style="margin:0 0 12px">Preview Ready for Review</h2>
          <p>Hello${user?.name ? ` ${user.name}` : ""},</p>
          <p>Your real estate report preview has been generated and is ready for your review.</p>
          <p>You can edit the Software-generated content before submitting for final approval.</p>
          <p><a href="${webUrl}/real-estate/preview/${newReport._id}" style="display:inline-block;background:#059669;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Review & Edit Preview</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
          <p style="font-size:12px;color:#777">Asset Insight</p>
        </div>
      `;
      if (user?.email) {
        await sendEmail(user.email, subject, html);
        console.log(`[RealEstatePreviewJob] Preview ready email sent to ${user.email}`);
      }
    } catch (e) {
      console.error("[RealEstatePreviewJob] Failed to send preview email:", e);
    }

    if (progressId) endProgress(progressId, true, "Preview ready");
    console.log(`[RealEstatePreviewJob] Completed for report ${newReport._id}`);
  } catch (error) {
    console.error("[RealEstatePreviewJob] Error:", error);
    if (progressId) endProgress(progressId, false, "Error processing request");
    throw error;
  }
}

/**
 * Queue file generation job (after user submits for approval)
 */
export function queueRealEstateFilesJob(
  reportId: string,
  options: RealEstateFilesJobOptions = {}
) {
  setImmediate(() =>
    runRealEstateFilesJob(reportId, options).catch((e) => {
      console.error("[RealEstateFilesJob] Failed:", e);
    })
  );
}

/**
 * Generate DOCX/Excel/ZIP files after user submits for approval
 */
export async function runRealEstateFilesJob(
  reportId: string,
  options: RealEstateFilesJobOptions = {}
) {
  let report: any = null;
  try {
    console.log(`[RealEstateFilesJob] Starting for report ${reportId}`);
    report = await RealEstateReport.findById(reportId).populate("user");
    if (!report) throw new Error(`Report ${reportId} not found`);
    if (!report.preview_data) throw new Error(`Report ${reportId} missing preview_data`);

    const user = report.user as any;
    const approveAfterGeneration = options.approveAfterGeneration === true;
    (report as any).job_status = "processing";
    (report as any).job_error = undefined;
    await report.save();
    
    // Build report data from preview_data (user-edited content)
    const reportData = {
      ...report.toObject(),
      ...report.preview_data,
      inspector_name: user?.name || user?.username || "",
      user_email: user?.email || "",
      user_cv_url: (user as any)?.cvUrl,
      user_cv_filename: (user as any)?.cvFilename,
    } as any;

    console.log(`[RealEstateFilesJob] Generating files for report ${reportId}`);

    // Generate DOCX
    const docxBuffer = await generateRealEstateDocxFromReport(reportData);
    console.log(`[RealEstateFilesJob] DOCX generated: ${docxBuffer.length} bytes`);

    // Generate Excel
    const xlsxBuffer = await generateRealEstateXlsx(reportData);
    console.log(`[RealEstateFilesJob] Excel generated: ${xlsxBuffer.length} bytes`);

    // Generate images ZIP
    const allUrls = [
      ...(report.imageUrls || []),
      ...(report.extraImageUrls || []),
    ];
    const imagesZip = await generateImagesZipFromUrls(allUrls, report.videoUrls || []);
    console.log(`[RealEstateFilesJob] Images ZIP generated: ${imagesZip.length} bytes`);

    // Upload to R2
    const docxFilename = `real-estate-preview-${reportId}.docx`;
    const xlsxFilename = `real-estate-preview-${reportId}.xlsx`;
    const imagesFilename = `real-estate-preview-images-${reportId}.zip`;

    await Promise.all([
      uploadBufferToR2(
        docxBuffer,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        process.env.R2_BUCKET_NAME!,
        `previews/${docxFilename}`
      ),
      uploadBufferToR2(
        xlsxBuffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        process.env.R2_BUCKET_NAME!,
        `previews/${xlsxFilename}`
      ),
      uploadBufferToR2(
        imagesZip,
        "application/zip",
        process.env.R2_BUCKET_NAME!,
        `previews/${imagesFilename}`
      ),
    ]);

    // Update report with preview file URLs
    (report as any).preview_files = {
      docx: getR2PublicUrl(`previews/${docxFilename}`),
      excel: getR2PublicUrl(`previews/${xlsxFilename}`),
      images: getR2PublicUrl(`previews/${imagesFilename}`),
    };
    
    // Mark file generation complete
    (report as any).files_generating = false;
    (report as any).files_regenerating = false;
    (report as any).job_status = "done";
    (report as any).job_error = undefined;
    
    if (approveAfterGeneration) {
      (report as any).status = "approved";
      (report as any).approval_processed_at = new Date();
      markReportAutoReleased(report);
    } else {
      // CRITICAL: Set status to 'pending_approval' ONLY after all files are generated
      // This ensures admin approval page only shows reports with ready files
      (report as any).status = 'pending_approval';
      (report as any).approval_requested_at = new Date();
      await assignReportApprover(report, { userId: user?._id || (report as any).user });
      await sendAssignedApprovalEmail(report, {
        reportType: "Real Estate",
        creatorUserId: user?._id || (report as any).user,
        title: (report as any).preview_data?.property_details?.address || (report as any).property_details?.address,
      });
    }
    await report.save();

    console.log(`[RealEstateFilesJob] Files uploaded for report ${reportId} (status: ${(report as any).status})`);

    // IMPORTANT: Send emails ONLY after files are created and status is set
    // This ensures users and admins are notified only when everything is ready
    // Send emails
    try {
      // User email
      const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
      const userSubject = approveAfterGeneration
        ? "Your Asset Insight Real Estate Report was approved"
        : "Your Real Estate Report Submitted for Approval";
      const awaitingRelease = approveAfterGeneration && (report as any).release_status === "pending_release";
      const userHtml = `
        <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
          <h2 style="margin:0 0 12px">${approveAfterGeneration ? "Report Approved" : "Report Submitted"}</h2>
          <p>Hello${user?.name ? ` ${user.name}` : ""},</p>
          <p>${
            approveAfterGeneration
              ? awaitingRelease
                ? "Your real estate report has been updated, approved, and is waiting for release before downloads are available."
                : "Your real estate report has been updated, approved, and is ready for download."
              : "Your real estate report has been submitted for admin approval."
          }</p>
          ${
            approveAfterGeneration
              ? ""
              : "<p>You will receive an email when the admin reviews your report.</p>"
          }
          <p><a href="${webUrl}/reports" style="display:inline-block;background:#059669;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">View Reports</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
          <p style="font-size:12px;color:#777">Asset Insight</p>
        </div>
      `;
      if (user?.email) {
        await sendEmail(user.email, userSubject, userHtml);
      }

      if (!approveAfterGeneration && !await isReviewReportOwnerId(user?._id || (report as any).user)) {
        // Admin email
        const adminEmail = process.env.ADMIN_EMAIL || "admin@assetinsightvaluation.com";
        const adminSubject = `New Real Estate Report Pending Approval - ${user?.name || user?.email}`;
        const adminHtml = `
          <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
            <h2 style="margin:0 0 12px">New Report Pending Approval</h2>
            <p>A new real estate report requires your review.</p>
            <ul>
              <li><strong>User:</strong> ${user?.name || "N/A"} (${user?.email})</li>
              <li><strong>Property:</strong> ${report.property_details?.address || "N/A"}</li>
              <li><strong>Type:</strong> ${(report as any).property_type || "residential"}</li>
            </ul>
            <p><a href="${webUrl}/admin/real-estate/${reportId}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Review Report</a></p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
            <p style="font-size:12px;color:#777">Asset Insight Admin</p>
          </div>
        `;
        await sendEmail(adminEmail, adminSubject, adminHtml);
      }
      console.log(`[RealEstateFilesJob] Emails sent`);
    } catch (e) {
      console.error("[RealEstateFilesJob] Failed to send emails:", e);
    }

    await notifyUser({
      userId: String(user?.id || (report as any)?.user || ""),
      category: "report",
      type: approveAfterGeneration ? "report_approved" : "report_preview_ready",
      title: approveAfterGeneration ? "Report Approved" : "Report Ready for Preview",
      body: approveAfterGeneration
        ? (report as any).release_status === "pending_release"
          ? "Your real estate report has been approved and is waiting for release."
          : "Your real estate report has been approved and is ready for download."
        : "Your real estate report has been generated and is ready for preview.",
      data: {
        type: approveAfterGeneration ? "report_approved" : "report_preview_ready",
        reportId: String(reportId),
        reportType: "RealEstate",
      },
    }).catch((pushError) => {
      console.error("[RealEstateFilesJob] Failed to send push notification:", pushError);
    });

    console.log(`[RealEstateFilesJob] Completed for report ${reportId}`);
  } catch (e) {
    if (report) {
      try {
        (report as any).files_generating = false;
        (report as any).files_regenerating = false;
        (report as any).job_status = "error";
        (report as any).job_error = e instanceof Error ? e.message : String(e);
        await report.save();
      } catch (saveError) {
        console.error(`[RealEstateFilesJob] Failed to reset report flags for ${reportId}:`, saveError);
      }
    }
    console.error(`[RealEstateFilesJob] Error for report ${reportId}:`, e);
    throw e;
  }
}

/**
 * Helper: Generate images ZIP from URLs
 */
async function generateImagesZipFromUrls(imageUrls: string[], videoUrls: string[]): Promise<Buffer> {
  const { default: axios } = await import("axios");
  
  return new Promise(async (resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 6 } });
    
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    // Add images
    let imgIdx = 0;
    for (const url of imageUrls) {
      if (!url) continue;
      try {
        const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30000 });
        const ext = url.split(".").pop()?.split("?")[0] || "jpg";
        archive.append(Buffer.from(resp.data as ArrayBuffer), { name: `images/${String(++imgIdx).padStart(3, "0")}.${ext}` });
      } catch (e) {
        console.warn(`Failed to fetch image: ${url}`);
      }
    }

    // Add videos
    let vidIdx = 0;
    for (const url of videoUrls) {
      if (!url) continue;
      try {
        const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 60000 });
        const ext = url.split(".").pop()?.split("?")[0] || "mp4";
        archive.append(Buffer.from(resp.data as ArrayBuffer), { name: `videos/${String(++vidIdx).padStart(3, "0")}.${ext}` });
      } catch (e) {
        console.warn(`Failed to fetch video: ${url}`);
      }
    }

    archive.finalize();
  });
}
