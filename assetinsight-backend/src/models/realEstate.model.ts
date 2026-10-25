import mongoose, { Schema } from "mongoose";

// Sub-schema for residential comparable property's details
const ComparablePropertyDetailSchema = new Schema(
  {
    "Address / Location": { type: String },
    "List Price": { type: String },
    "Square Footage": { type: String },
    "Square Footage Adjustment": { type: String },
    "Lot Size": { type: String },
    "Lot Size Adjustment": { type: String },
    Bedrooms: { type: String },
    "Bedroom Adjustment": { type: String },
    Bathrooms: { type: String },
    "Bathroom Adjustment": { type: String },
    Garage: { type: String },
    "Garage Adjustment": { type: String },
    Basement: { type: String },
    "Basement Adjustment": { type: String },
    "Other Features": { type: String },
    "Other Features Adjustment": { type: String },
    Condition: { type: String },
    "Condition Adjustment": { type: String },
    Adjustments: { type: String },
    "Adjusted Value": { type: String },
  },
  { _id: false }
);

// Sub-schema for farmland comparable with adjustments
const FarmlandComparableSchema = new Schema(
  {
    comp_id: { type: String }, // e.g., "F-1", "F-2"
    sale_date: { type: Date },
    rm_area: { type: String }, // RM of Corman Park, etc.
    distance_to_subject_km: { type: Number },
    title_acres: { type: Number },
    cultivated_acres: { type: Number },
    sale_price: { type: Number },
    price_per_cultivated_acre: { type: Number },
    data_source: { type: String }, // MLS, ISC, Private Sale
    notes: { type: String },
    // Adjustments
    unadjusted_rate: { type: Number },
    time_adj: { type: Number },
    size_adj: { type: Number },
    location_adj: { type: Number },
    soil_quality_adj: { type: Number },
    access_adj: { type: Number },
    other_adj: { type: Number },
    total_adj: { type: Number },
    adjusted_rate: { type: Number },
    weight_percent: { type: Number },
    weighted_rate: { type: Number },
  },
  { _id: false }
);

// Sub-schema for adjustment rates (configurable)
const AdjustmentRatesSchema = new Schema(
  {
    time_percent_per_year: { type: Number, default: 5.0 },
    size_per_10ac: { type: Number, default: -25 },
    location_per_km: { type: Number, default: -15 },
    soil_quality_per_step: { type: Number, default: 50 },
    access_lump_sum: { type: Number, default: 75 },
  },
  { _id: false }
);

// Sub-schema for income capitalization approach
const IncomeCapitalizationSchema = new Schema(
  {
    cultivated_acres: { type: Number },
    market_rent_per_acre: { type: Number },
    potential_gross_income: { type: Number },
    vacancy_loss_percent: { type: Number, default: 2.0 },
    effective_gross_income: { type: Number },
    operating_expense_ratio: { type: Number, default: 20.0 },
    net_operating_income: { type: Number },
    cap_rate: { type: Number, default: 5.0 },
    indicated_value: { type: Number },
    indicated_value_per_acre: { type: Number },
  },
  { _id: false }
);

// Sub-schema for cost approach (AI-calculated)
const CostApproachSchema = new Schema(
  {
    land_value: { type: Number },
    replacement_cost_new: { type: Number },
    physical_depreciation: { type: Number },
    functional_obsolescence: { type: Number },
    external_obsolescence: { type: Number },
    total_depreciation: { type: Number },
    depreciated_cost_of_improvements: { type: Number },
    indicated_value: { type: Number },
  },
  { _id: false }
);

// Sub-schema for valuation reconciliation
const ReconciliationSchema = new Schema(
  {
    direct_comparison_value: { type: Number },
    direct_comparison_weight: { type: Number, default: 70 },
    direct_comparison_weighted: { type: Number },
    income_value: { type: Number },
    income_weight: { type: Number, default: 30 },
    income_weighted: { type: Number },
    cost_value: { type: Number },
    cost_weight: { type: Number, default: 0 },
    cost_weighted: { type: Number },
    final_reconciled_value: { type: Number },
  },
  { _id: false }
);

// Sub-schema for farmland valuation (combines all approaches)
const FarmlandValuationSchema = new Schema(
  {
    subject_name: { type: String },
    valuation_date: { type: Date },
    total_title_acres: { type: Number },
    cultivated_acres: { type: Number },
    rm_area: { type: String },
    notes: { type: String },
    // Which approaches were selected by user
    approaches_used: {
      direct_comparable: { type: Boolean, default: true },
      income_capitalization: { type: Boolean, default: false },
      cost_approach: { type: Boolean, default: false },
    },
    // Comparables
    comparables: [FarmlandComparableSchema],
    adjustment_rates: AdjustmentRatesSchema,
    weighted_average_rate: { type: Number },
    direct_comparison_value: { type: Number },
    // Income approach
    income_capitalization: IncomeCapitalizationSchema,
    // Cost approach (AI-calculated)
    cost_approach: CostApproachSchema,
    // Reconciliation
    reconciliation: ReconciliationSchema,
    // Final values
    fair_market_value: { type: Number },
    fair_market_value_formatted: { type: String },
  },
  { _id: false }
);

// Sub-schema for legacy residential valuation
const ValuationSchema = new Schema(
  {
    fair_market_value: { type: String },
    value_source: { type: String },
    adjusted_value_from_comparable: { type: String },
    comparable_used: { type: String },
    final_adjusted_value: { type: String },
    final_estimate_summary: { type: String },
    final_estimate_value: { type: String },
    details: { type: String },
  },
  { _id: false }
);

// Sub-schema for AI-extracted property features from images
const AIExtractedFeaturesSchema = new Schema(
  {
    property_condition: { type: String },
    land_features: [{ type: String }],
    buildings_detected: [{ type: String }],
    crop_type: { type: String },
    soil_quality_estimate: { type: String },
    access_roads: { type: String },
    utilities_visible: [{ type: String }],
    water_features: [{ type: String }],
    terrain_type: { type: String },
    estimated_cultivated_percent: { type: Number },
    notes: { type: String },
  },
  { _id: false }
);

const RealEstateReportSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    language: { type: String, enum: ["en", "fr", "es"], default: "en" },
    property_details: {
      owner_name: { type: String },
      alternate_owner_name: { type: String },
      address: { type: String },
      land_description: { type: String },
      municipality: { type: String },
      title_number: { type: String },
      parcel_number: { type: String },
      land_area_hectares: { type: String },
      land_area_acres: { type: String },
      source_quarter_section: { type: String },
      ownership_share: { type: String },
      assessed_value_city: { type: String },
      property_type: { type: String }, // Kept from original
      description: { type: String }, // Kept from original
    },
    report_dates: {
      report_date: { type: Date },
      effective_date: { type: Date },
      inspection_date: { type: Date },
    },
    house_details: {
      year_built: { type: String },
      lottery_home: { type: Boolean },
      square_footage: { type: String },
      lot_size_sqft: { type: String },
      number_of_rooms: { type: String },
      number_of_full_bathrooms: { type: String },
      number_of_half_bathrooms: { type: String },
      garage_description: { type: String },
      basement_description: { type: String },
      major_features: [{ type: String }],
      known_issues: [{ type: String }],
    },
    inspector_info: {
      inspector_name: { type: String },
      company_name: { type: String },
      contact_email: { type: String },
      contact_phone: { type: String },
      credentials: { type: String },
    },
    imageUrls: [{ type: String }], // Main images (new uploads unwatermarked, sent to AI)
    extraImageUrls: [{ type: String }], // Extra images (new uploads unwatermarked, report only)
    videoUrls: [{ type: String }], // Videos (zip only)
    
    // Preview/Approval workflow fields
    status: {
      type: String,
      enum: ["preview", "pending_approval", "approved", "declined"],
      default: "preview",
    },
    preview_data: { type: Schema.Types.Mixed }, // Editable AI-generated content
    preview_files: {
      docx: { type: String },
      excel: { type: String },
      images: { type: String },
    },
    preview_submitted_at: { type: Date },
    approval_requested_at: { type: Date },
    approval_processed_at: { type: Date },
    approval_assigned_to: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    approval_assigned_at: { type: Date, default: null },
    approval_assigned_source: { type: String },
    approval_assignment_email_sent_at: { type: Date, default: null },
    release_status: { type: String, enum: ["pending_release", "released"], default: undefined, index: true },
    release_assigned_to: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    release_assigned_at: { type: Date, default: null },
    release_assigned_source: { type: String },
    release_assignment_email_sent_at: { type: Date, default: null },
    released_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    released_at: { type: Date, default: null },
    decline_reason: { type: String },
    files_generating: { type: Boolean, default: false },
    files_regenerating: { type: Boolean, default: false },
    job_status: { type: String, enum: ["queued", "processing", "done", "error"] },
    job_error: { type: String },
    adminArchivedAt: { type: Date, default: null },
    adminArchivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    
    // Farmland-specific details
    farmland_details: {
      total_title_acres: { type: Number },
      cultivated_acres: { type: Number },
      rm_area: { type: String }, // Rural Municipality
      soil_class: { type: String },
      crop_type: { type: String },
      is_rented: { type: Boolean, default: false },
      annual_rent_per_acre: { type: Number },
      irrigation: { type: Boolean, default: false },
      access_quality: { type: String, enum: ["excellent", "good", "fair", "poor"] },
      distance_to_city_km: { type: Number },
      // Direct Comparable Approach fields
      use_direct_comparable: { type: Boolean, default: false },
      subject_name: { type: String },
      valuation_date: { type: Date },
      notes: { type: String },
      // Income Capitalization Approach fields
      use_income_approach: { type: Boolean, default: false },
      market_rent_per_acre: { type: Number },
      vacancy_loss_percent: { type: Number, default: 2 },
      operating_expense_ratio: { type: Number, default: 20 },
      cap_rate: { type: Number, default: 5 },
      // Cost Approach (AI-calculated)
      use_cost_approach: { type: Boolean, default: false },
    },
    // AI-extracted features from images
    ai_extracted_features: AIExtractedFeaturesSchema,
    // Farmland valuation (Direct Comparison + Income Approach + Reconciliation)
    farmland_valuation: FarmlandValuationSchema,
    // Legacy residential comparables
    comparableProperties: {
      type: Map,
      of: ComparablePropertyDetailSchema,
    },
    // Legacy residential valuation
    valuation: ValuationSchema,
    marketTrend: {
      type: [
        {
          marketTrends2025: {
            reginaBenchmarkPrice: {
              march: Number,
              june: Number,
              yearOverYearIncreasePercent: Number,
            },
            inventory: {
              monthsOfSupply: Number,
              historicalAverageMonths: Number,
            },
            salesActivity: {
              comparisonTo10YearAverage: String,
            },
            forecast: {
              lowEstimatePriceGrowthPercent: Number,
              highEstimatePriceGrowthPercent: Number,
              expectedLate2025AveragePriceCAD: Number,
            },
          },
          buyerSellerInsights: {
            marketType: String,
            recommendation: {
              seller: String,
              buyer: String,
            },
          },
          summary: {
            reginaMarket: String,
            lakeridgeMarket: String,
            overallOutlook: String,
          },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

RealEstateReportSchema.index({ status: 1, adminArchivedAt: 1, createdAt: -1 });
RealEstateReportSchema.index({ user: 1, createdAt: -1 });
RealEstateReportSchema.index({ status: 1, release_status: 1, release_assigned_to: 1, createdAt: -1 });

const RealEstateReport = mongoose.model(
  "RealEstateReport",
  RealEstateReportSchema
);

export default RealEstateReport;
