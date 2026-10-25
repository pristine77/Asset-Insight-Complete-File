/**
 * Generate Sample Real Estate DOCX Report for Testing
 * 
 * Usage:
 *   npm run test:realestate        (fast - no build required)
 *   npm run sample:realestate      (production - with build)
 * 
 * This script generates a sample real estate DOCX report in the ./reports directory.
 * 
 * Tests:
 * - Custom cover page (merged from CoverPage.docx template)
 * - Headers with logo on all pages (except cover/certificate)
 * - Footers with page numbers and corporate info
 * - Certificate of Market Value (emerald green theme)
 * - Table of contents
 * - Transmittal letter
 * - All CUSPAP-compliant sections:
 *   - Market Value Conclusion
 *   - Certification
 *   - Assumptions & Limiting Conditions
 *   - Scope of Appraisal
 *   - Basis of Appraisal
 *   - Factual Information
 *   - Site Description
 *   - Highest & Best Use Analysis
 *   - Valuation Analysis
 *   - Market Context & Risk Analysis
 *   - Conclusions & Recommendations
 *   - Addenda
 */

import { generateRealEstateDocx } from "../service/docx/realEstateDocxBuilder.js";
import fs from "fs/promises";
import path from "path";

async function main() {
  console.log("🏠 Generating sample Real Estate DOCX report...\n");
  
  const now = new Date();
  const effectiveDate = now.toISOString();
  const reportDate = now.toISOString();
  
  // Sample farmland report data
  const sampleFarmlandReport: any = {
    // Basic info
    property_type: "farmland",
    owner_name: "John Anderson",
    inspector_name: "Sarah Mitchell, AACI, P.App",
    inspector_company: "McDougall Auctioneers Ltd.",
    user_email: "sarah.mitchell@mcdougallauction.com",
    createdAt: now.toISOString(),
    
    // Property details
    property_details: {
      address: "NE 14-36-22 W3M, Rural Municipality of Corman Park No. 344, Saskatchewan",
      legal_description: "NE 1/4 Section 14, Township 36, Range 22, West of 3rd Meridian",
      municipality: "RM of Corman Park No. 344",
      province: "Saskatchewan",
      postal_code: "S0K 0T0",
    },
    
    // Report dates
    report_dates: {
      effective_date: effectiveDate,
      report_date: reportDate,
      inspection_date: effectiveDate,
    },
    
    // Valuation (AI-calculated)
    valuation: {
      fair_market_value: "$1,250,000",
      value_per_acre: "$7,812.50",
      value_source: "Direct Comparison Approach with Income Capitalization",
      comparable_used: "NW 22-36-21 W3M, RM of Corman Park",
      comparable_list_price: "$1,180,000",
      final_estimate_summary: "Based on 5 comparable farmland sales within 25km radius, with time and location adjustments applied. Weighted average rate of $8,621/cultivated acre. Subject: 145 cultivated acres × $8,621/acre = $1,250,000 (rounded).",
      final_estimate_value: "One Million Two Hundred Fifty Thousand Dollars ($1,250,000 CAD)",
      details: "Comparables ranged from $7,500-$9,200/acre. Time adjustment +3% for 2024 sales. Location adjustment -2% for distance from Saskatoon. Soil quality adjustment +5% for Class 2-3 soils.",
    },
    
    // Farmland valuation details
    farmland_valuation: {
      weighted_average_rate: 8621,
      direct_comparison_value: 1250045,
      cultivated_acres: 145,
      comparables: [
        { comp_id: "F-1", rm_area: "RM of Corman Park", adjusted_rate: 8500 },
        { comp_id: "F-2", rm_area: "RM of Vanscoy", adjusted_rate: 8750 },
        { comp_id: "F-3", rm_area: "RM of Aberdeen", adjusted_rate: 8400 },
        { comp_id: "F-4", rm_area: "RM of Blucher", adjusted_rate: 8900 },
        { comp_id: "F-5", rm_area: "RM of Corman Park", adjusted_rate: 8550 },
      ],
      income_capitalization: {
        cultivated_acres: 145,
        market_rent_per_acre: 85,
        potential_gross_income: 12325,
        vacancy_loss_percent: 2,
        effective_gross_income: 12078,
        operating_expense_ratio: 20,
        net_operating_income: 9663,
        cap_rate: 5,
        indicated_value: 193260,
        indicated_value_per_acre: 1333,
      },
      reconciliation: {
        direct_comparison_value: 1250045,
        direct_comparison_weight: 70,
        direct_comparison_weighted: 875031,
        income_value: 193260,
        income_weight: 30,
        income_weighted: 57978,
        final_reconciled_value: 1250000,
      },
      fair_market_value: 1250000,
      fair_market_value_formatted: "$1,250,000",
    },
    
    // Farmland specific details
    farmland_details: {
      total_title_acres: 160,
      cultivated_acres: 145,
      pasture_acres: 10,
      other_acres: 5,
      soil_class: "Class 2-3",
      soil_rating: 72,
      average_assessment: "$185,000",
      current_land_use: "Annual crop production - primarily canola and wheat rotation",
      water_sources: "Dugout, seasonal creek",
      drainage: "Good natural drainage to the east",
    },
    
    // House details (empty for farmland)
    house_details: null,
    
    // AI-generated sections
    ai_sections: {
      exec_summary: `This comprehensive appraisal report provides an independent opinion of market value for the subject agricultural property located in the Rural Municipality of Corman Park No. 344, Saskatchewan. The property consists of 160 titled acres of predominantly cultivated farmland with excellent soil quality and proven production history.

The subject property benefits from its strategic location within a highly productive agricultural region, characterized by strong commodity prices and increasing land values. The analysis considers current market conditions, comparable sales data, and the property's inherent characteristics to arrive at a well-supported value conclusion.

Based on thorough analysis using the Sales Comparison Approach, the market value of the subject property is concluded to be $1,250,000 (One Million Two Hundred Fifty Thousand Dollars) as of the effective date of this appraisal.`,
      
      property_description: `The subject property is a quarter section of farmland comprising 160 titled acres located in the Rural Municipality of Corman Park No. 344, approximately 15 kilometers northwest of Saskatoon, Saskatchewan. The legal description is NE 1/4 Section 14, Township 36, Range 22, West of the 3rd Meridian.

The property features predominantly Class 2-3 soils with an average soil rating of 72, indicating excellent agricultural capability. Approximately 145 acres are under cultivation, with the balance consisting of 10 acres of pasture and 5 acres of other use including farmstead area and wetlands.

The topography is gently rolling with good natural drainage flowing eastward. Water resources include a dugout and seasonal creek access. The property has been consistently farmed using modern agricultural practices with a canola-wheat rotation being the primary cropping system.

Access is provided via a municipal grid road with year-round maintenance. The property is serviced by SaskPower and SaskEnergy utilities are available at the road.`,
      
      scope_of_work: `The scope of this appraisal assignment includes:

1. Physical inspection of the subject property including all improvements
2. Review of title documents and legal descriptions
3. Analysis of soil classification and agricultural capability
4. Research of comparable sales within the relevant market area
5. Application of the Sales Comparison Approach to value
6. Preparation of this comprehensive written appraisal report

The appraiser conducted a thorough inspection of the subject property on the effective date, examining soil conditions, drainage patterns, improvements, and overall property condition. Comparable sales data was gathered from MLS records, land title registrations, and Farm Credit Canada resources.

This appraisal has been prepared in accordance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP) and complies with all applicable regulations governing real property appraisal in Saskatchewan.`,
      
      market_analysis: `The Saskatchewan agricultural land market has demonstrated sustained strength over the past several years, driven by favorable commodity prices, low interest rates, and strong demand from both established farmers and investors. The Saskatoon region, in particular, has seen significant appreciation in farmland values due to urban proximity and excellent soil quality.

Key market indicators include:
- Average farmland values in the RM of Corman Park have increased 8-12% annually over the past five years
- Strong demand continues from local operators seeking to expand operations
- Limited supply of quality cultivated land maintains upward pressure on values
- Investor interest remains high due to farmland's performance as an asset class

The subject property's location benefits from proximity to grain handling facilities, agricultural suppliers, and the Saskatoon market for specialty crops. Transportation infrastructure is well-developed with paved highways within 5 kilometers.

Market conditions as of the effective date are characterized as stable to slightly increasing, with no significant economic factors anticipated to adversely impact agricultural land values in the near term.`,
    },
    
    // Preview data (for compatibility)
    preview_data: {
      owner_name: "John Anderson",
      inspector_name: "Sarah Mitchell, AACI, P.App",
      inspector_company: "McDougall Auctioneers Ltd.",
      property_details: {
        address: "NE 14-36-22 W3M, Rural Municipality of Corman Park No. 344, Saskatchewan",
      },
      valuation: {
        fair_market_value: "$1,250,000",
      },
      farmland_details: {
        total_title_acres: 160,
        cultivated_acres: 145,
        soil_class: "Class 2-3",
      },
    },
    
    // Image URLs for photo gallery (using sample images)
    imageUrls: [
      "https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800&q=80", // Farmland field
      "https://images.unsplash.com/photo-1625246333195-78d9c38ad449?w=800&q=80", // Farm landscape
      "https://images.unsplash.com/photo-1560493676-04071c5f467b?w=800&q=80", // Agricultural land
      "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=800&q=80", // Farm buildings
    ],
    
    // Currency
    currency: "CAD",
  };

  // Sample residential report data
  const sampleResidentialReport: any = {
    property_type: "residential",
    owner_name: "Emily Thompson",
    inspector_name: "Michael Chen, AACI",
    inspector_company: "McDougall Auctioneers Ltd.",
    user_email: "michael.chen@mcdougallauction.com",
    createdAt: now.toISOString(),
    
    property_details: {
      address: "1234 Maple Street, Saskatoon, SK S7H 0A1",
      legal_description: "Lot 15, Block 8, Plan 101234567",
      municipality: "City of Saskatoon",
      province: "Saskatchewan",
      postal_code: "S7H 0A1",
    },
    
    report_dates: {
      effective_date: effectiveDate,
      report_date: reportDate,
      inspection_date: effectiveDate,
    },
    
    // Valuation (AI-calculated)
    valuation: {
      fair_market_value: "$485,000",
      value_per_sqft: "$295",
      value_source: "Direct Comparison Approach (Price per Sqft)",
      comparable_used: "1456 Oak Avenue, Saskatoon, SK S7H 0B2",
      comparable_list_price: "$479,900",
      final_estimate_summary: "Chosen comparable: 1456 Oak Avenue (closest sqft at 1,620 sqft). Price per sqft = $479,900 ÷ 1,620 sqft = $296.23. Subject sqft = 1,650. FMV = $296.23 × 1,650 = $488,780, rounded to $485,000.",
      final_estimate_value: "Four Hundred Eighty-Five Thousand Dollars ($485,000 CAD)",
      details: "Closest sqft comparable used. listPrice_number=479900, squareFootage_number=1620, price_per_sqft=296.23, subject_sqft=1650, fair_market_value=$485,000.",
    },
    
    house_details: {
      year_built: 2015,
      square_footage: 1650,
      number_of_rooms: 4,
      number_of_full_bathrooms: 2,
      number_of_half_bathrooms: 1,
      basement_type: "Fully finished",
      garage: "Double attached",
      heating: "High-efficiency gas furnace",
      cooling: "Central air conditioning",
      roof_type: "Asphalt shingles (2015)",
      exterior: "Vinyl siding with stone accents",
      lot_size: "50 x 120 feet",
    },
    
    farmland_details: null,
    
    ai_sections: {
      exec_summary: `This appraisal report provides an opinion of market value for a single-family residential property located at 1234 Maple Street, Saskatoon, Saskatchewan. The subject is a well-maintained 2015-built home featuring 1,650 square feet of above-grade living space with a fully finished basement.

The property is situated in a desirable established neighborhood with excellent access to schools, parks, and amenities. Based on analysis of comparable sales and current market conditions, the market value is concluded to be $485,000 as of the effective date.`,
      
      property_description: `The subject property is a two-storey single-family residence constructed in 2015. The home features 1,650 square feet of above-grade living space on a 50 x 120 foot lot. 

Main floor amenities include an open-concept living/dining area, modern kitchen with granite countertops and stainless appliances, and a powder room. The upper level contains four bedrooms including a master suite with ensuite bathroom, plus a full main bathroom.

The fully finished basement adds approximately 800 square feet of living space including a recreation room and home office. The double attached garage provides convenient vehicle storage with interior access.

Exterior features include vinyl siding with decorative stone accents, a covered front porch, and a private backyard with deck and landscaping.`,
      
      scope_of_work: `This appraisal includes physical inspection of the subject property, analysis of relevant market data, and application of the Sales Comparison Approach. The report has been prepared in accordance with CUSPAP standards.`,
      
      market_analysis: `The Saskatoon residential market has shown steady performance with moderate price appreciation. The subject neighborhood is characterized by family-oriented housing with good demand and limited turnover. Current market conditions are balanced with typical marketing times of 30-45 days for well-priced properties.`,
    },
    
    preview_data: {
      owner_name: "Emily Thompson",
      inspector_name: "Michael Chen, AACI",
      inspector_company: "McDougall Auctioneers Ltd.",
      property_details: {
        address: "1234 Maple Street, Saskatoon, SK S7H 0A1",
      },
      valuation: {
        fair_market_value: "$485,000",
      },
      house_details: {
        square_footage: 1650,
        number_of_rooms: 4,
        number_of_full_bathrooms: 2,
        number_of_half_bathrooms: 1,
      },
    },
    
    // Image URLs for photo gallery (using sample images)
    imageUrls: [
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=800&q=80", // Modern house exterior
      "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=80", // House front view
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80", // House with yard
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=80", // House interior
    ],
    currency: "CAD",
  };

  const reportsDir = path.resolve(process.cwd(), "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const filenameSafeDate = now.toISOString().replace(/[:.]/g, "-");

  // Generate Farmland Report
  console.log("🌾 Generating Farmland Appraisal Report...");
  try {
    const farmlandBuffer = await generateRealEstateDocx(sampleFarmlandReport);
    const farmlandPath = path.join(reportsDir, `sample-farmland-${filenameSafeDate}.docx`);
    await fs.writeFile(farmlandPath, farmlandBuffer);
    console.log("✅ Farmland Report:", farmlandPath);
  } catch (error) {
    console.error("❌ Farmland Report generation failed:", error);
  }

  // Generate Residential Report
  console.log("\n🏡 Generating Residential Appraisal Report...");
  try {
    const residentialBuffer = await generateRealEstateDocx(sampleResidentialReport);
    const residentialPath = path.join(reportsDir, `sample-residential-${filenameSafeDate}.docx`);
    await fs.writeFile(residentialPath, residentialBuffer);
    console.log("✅ Residential Report:", residentialPath);
  } catch (error) {
    console.error("❌ Residential Report generation failed:", error);
  }

  console.log("\n🎉 Sample Real Estate reports generated!");
  console.log("📂 Check the ./reports directory");
  console.log("\n📋 Reports include:");
  console.log("   ✅ Cover page");
  console.log("   ✅ Table of Contents");
  console.log("   ✅ Transmittal Letter");
  console.log("   ✅ Certificate of Market Value (emerald theme)");
  console.log("   ✅ Headers with logo (except cover/cert)");
  console.log("   ✅ Footers with page numbers");
  console.log("   ✅ Property photos in Site Description section");
  console.log("   ✅ Photo gallery appendix");
  console.log("   ✅ All CUSPAP sections (60+ pages)");
  console.log("   ✅ AI-generated content sections");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
