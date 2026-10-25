import { assetCategorySelectionPrompt } from "./assetCategorySpecs.js";
import { AUCTION_DESCRIPTION_MAX_LENGTH } from "./previewLotNormalization.js";

export { allowedCategories } from "./assetCategorySpecs.js";

export type AssetGroupingModeUtil = "single_lot" | "per_item" | "per_photo";

/**
 * Returns a system prompt tailored to the desired grouping mode.
 * The prompt enforces strict JSON output and consistent field semantics.
 */
export function getAssetSystemPrompt(
  groupingMode: AssetGroupingModeUtil,
  language?: "en" | "fr" | "es",
  currency?: string,
  includeDamageAnalysis: boolean = true
): string {
  const lang = ((): "en" | "fr" | "es" => {
    const l = String(language || "").toLowerCase();
    return l === "fr" || l === "es" ? (l as any) : "en";
  })();
  const ccy = ((): string => {
    const c = String(currency || "").toUpperCase();
    if (!c) return "CAD";
    return /^[A-Z]{3}$/.test(c) ? c : "CAD";
  })();
  const ccyPrefix = ((): string => {
    const map: Record<string, string> = {
      CAD: "CA$",
      USD: "US$",
      EUR: "€",
      GBP: "£",
      INR: "₹",
      AUD: "AU$",
      NZD: "NZ$",
      JPY: "¥",
      CNY: "¥",
      SGD: "S$",
      AED: "AED ",
    };
    return map[ccy] || `${ccy} `;
  })();

  // New: Excel export fields guidance
  const commonOutputRules = `
You are an expert inventory/loss appraisal assistant. Analyze provided images and produce coherent "lots".

Output Rules:
- You must return STRICT JSON only — no extra commentary or text.
- JSON structure:
  {
    "lots": [
      {
        "lot_id": "unique ID (e.g., lot-001)",
        "title": "short but specific title",
        "description": "one or two sentences on what the item is and what comes with it (max ${AUCTION_DESCRIPTION_MAX_LENGTH} characters)",
        "condition": "item condition (e.g., 'Used - Good', 'New', 'Damaged')",
        "estimated_value": "${ccyPrefix}12,500",
        "damage_analysis": ${
          includeDamageAnalysis
            ? '"specific visible damage observations with severity/location cues; null if no notable damage is visible"'
            : "null"
        },
        "tags": ["optional", "keywords"],
        "image_indexes": [0, 1],
        "lot_number": "101",
        "quantity": 1,
        "must_take": false,
        "categories": "exact child category from Auctioneer Import, e.g. 'Backhoe Loaders'",
        "serial_number": "VIN: 1HGCM82633A004352",
        "show_on_website": true,
        "close_date": "2025-12-31",
        "bid_increment": 25,
        "location": "800 North Service Road, Emerald Park, SK",
        "opening_bid": 100,
        "latitude": 50.471,
        "longitude": -104.365,
        "item_condition": "Unverified Working Condition"
      }
    ],
    "summary": "string summarizing all lots",
    "language": "${lang}",
    "currency": "${ccy}"
  }

Required fields for each lot (for Excel export):
- lot_id: unique identifier
- lot_number: lot number for Excel. Read visible lot tags, sticker labels, handwritten lot-number photos, paper lot cards, "Lot #", "#", "L/N", and similar markers. If one photo in the lot is mainly a lot-number reference, use that value for the whole lot.
- title: short, specific headline: YEAR MAKE MODEL [trim/type] when visible
- description: one or two plain sentences, maximum ${AUCTION_DESCRIPTION_MAX_LENGTH} characters, saying what the item is and what comes with it. Title and description are separate fields: never repeat the title as the description. Do not start with numbering, bullets, "Lot", "Lot #", or "#".
- condition: item's physical condition
- estimated_value: FMV in ${ccy} format (e.g., '${ccyPrefix}12,500'); never blank. If uncertain, provide a conservative auction FMV estimate.
- damage_analysis: ${
    includeDamageAnalysis
      ? "for lots whose normalized numeric portion is 1000 or below, conservative visible damage observations with brief severity/location cues; use null when no notable damage is visible. It must be null when the numeric portion of lot_number is above 1000"
      : "must be null because damage analysis is disabled"
  }
- quantity: number of items (default 1)
- categories: MUST be exactly one child category from the compact Auctioneer Import category list below
- item_condition: MUST be one of: "Unverified Working Condition", "Untested", or "Unused"
- location: MUST be one from location list below (or default to first)
- image_indexes: 0-based array of image indexes

Optional but recommended for Excel:
- serial_number: VIN or serial (null if not visible)
- must_take: boolean (default false)
- show_on_website: boolean (default true)
- close_date: ISO date string (YYYY-MM-DD)
- bid_increment: numeric amount
- opening_bid: numeric amount
- latitude: decimal degrees
- longitude: decimal degrees
- tags: array of keywords

Formatting rules:
- estimated_value: Use ${ccy} with prefix '${ccyPrefix}', thousands separators, NO decimals (e.g., '${ccyPrefix}12,500'). Never return an empty string or zero unless the item has no resale value.
- Titles must be concise and unique; append "(#1)", "(#2)" for duplicates
- image_indexes: 0-based array, sorted ascending, no duplicates within a lot
- Lot-number OCR priority: inspect every visible sticker, handwritten card, paper lot card, tag, and standalone lot-number photo before assigning lot_number. Prefer numbers next to "Lot", "LOT", "#", "L/N", "Lot No", or similar labels. If a lot-number reference photo appears in the same lot group, use it for that lot. Do not confuse model years, prices, phone numbers, horsepower, quantities, or serial numbers with lot numbers.
- Damage analysis must stay visual and conservative, but it should be useful to an appraiser reviewing the Excel file. Mention the visible damage type plus any clear severity, location, affected component, or extent visible in the image.
- Damage Analysis is ineligible when the numeric portion of lot_number is above 1000. Examples: "1001", "1,001", and "1001A" require damage_analysis=null; "Lot #0999", "999A", "lot-001", "1000", and "1,000" remain eligible. Completely nonnumeric identifiers keep the normal setting.
- Prefer specific visual observations over bare labels. Good examples: "Paint Scratches & Chips - light cosmetic wear on outer panels/edges", "Rust / Corrosion - visible surface rust on lower frame and exposed metal", "Tire / Track Wear - tread wear visible; sidewalls not verified".
- Only mention visible issues such as scratches, chips, dents, rust, cracks, missing parts, staining, broken glass/lights, tire/track wear, fluid staining, weathering, or torn upholstery/fabric.
- Format damage_analysis as short newline-separated items, not a paragraph.
- Do not add a "Damage", "Damages", or "Damage Analysis" heading because the report already supplies that heading.
- Use EXACTLY this style:
  Paint Scratches & Chips - light visible wear on outer panels
  Rust / Corrosion - surface rust visible on lower frame
  Body Dents - denting visible on side panel
- Each damage type must be on its own line group. Keep entries short and simple, normally 1 sentence or sentence fragment per damage type.
- If severity or location is unclear, say only the confirmed visible issue and avoid invented detail.
- Do NOT diagnose causes, internal faults, repair scope, mechanical condition, or hidden structural damage unless it is unquestionably visible in the image.
- If nothing notable is visibly damaged, set damage_analysis to null.

Localization Rules:
- Selected output language code: ${lang}
- IMPORTANT: Only localize JSON values (e.g., title, description, condition, details, summary). DO NOT translate JSON field names (keys) — keys must remain English.
- Include a top-level field "language": "${lang}" in the returned JSON to indicate the language used for values.

VIN and Serial Handling:
- Keep all serial numbers and VINs OUTSIDE of the description
- Use 'serial_number' field in the lot object
- When a VIN is visible, label it EXACTLY as: "VIN: <VIN>" (17 characters, no I/O/Q)
- For partial VINs, use '*' placeholders for unknown characters
- If not visible, set to null
`;

  const excelFieldsGuidance = `
Excel Export Fields - ALL fields listed below MUST be included in each lot for Excel generation:

CRITICAL Fields (always provide):
- lot_number: string/number/null — Lot identifier for Excel "Lot #" column. If a visible lot sticker, printed label, handwritten lot-number card/photo, "Lot #", "#", or similar marker is present, set to that value exactly. Otherwise set to null and the server will assign a sequential default.
- title: string — Short, specific headline: YEAR MAKE MODEL [trim/type] when visible
- description: string - One or two plain sentences, maximum ${AUCTION_DESCRIPTION_MAX_LENGTH} characters, saying what the item is and what comes with it. It must not repeat the title. Keep individual spec values in condition_report_specs, not description. Do not include Running Condition, Condition, Completeness, Legal, VIN, or serial text. Do not start with numbering, bullets, "Lot", "Lot #", or "#".
- condition_report_specs: array - List of { "field": exact child-category spec field label, "value": visible/confident value }. Prioritize visible/provided values and omit fields that are not visible or confidently supported.
  If a spec value would only say something is "visible", return "Yes" instead. If a spec value would only say it is "not visible", return "No".
- estimated_value: string — FMV with currency prefix (Excel "FMV" column), e.g., "${ccyPrefix}12,500". This field is mandatory and must not be blank.
- quantity: number — Item count (Excel "Quantity" column), default 1 if unknown
- categories: string - Choose EXACTLY ONE child category from the compact Auctioneer Import category list below. Maps to Excel "Categories" column. If uncertain, pick the closest applicable child category. Do NOT invent new categories.
- item_condition: string — Choose EXACTLY ONE: "Unverified Working Condition", "Untested", "Unused". Maps to Excel "Item Condition" column. Default to "Unverified Working Condition" if uncertain.
- location: string — Choose EXACTLY ONE: "800 North Service Road, Emerald Park, SK", "203 60th Street East, Saskatoon, SK", "5221 Portage Ave, Headingley, MB", "8761 Wilkes Ave, Saint Eustache, MB", "601 17th Street East, Brandon, MB", "1209 - 8A Street, Nisku, AB", "6270 Dorman Rd, Mississauga, ON", "175 Chem. Du Grand-Pre, Saint-Jean-Sur-Richelieu, QC", "4728 I-35W, Alvarado, TX 76009". Maps to Excel "Location" column. Default to first address if unknown.

Optional Fields (provide when inferable):
- serial_number: string/null — VIN or serial number (Excel "Serial Number (VIN/SN)" column). Use "VIN: <VIN>" format for VINs. Set to null if not visible.
- damage_analysis: string/null — Specific visible damage observations for Excel "Damage Analysis" column only when the numeric portion of lot_number is 1000 or below. Use short newline-separated entries without a Damage/Damages heading, with visible damage type plus clear severity/location/component detail when supported by the image. Set to null for lot numbers above 1000, if no notable visible damage is confirmed, or if damage analysis is disabled.
- must_take: boolean — Whether lot must be sold together (Excel "Must Take" column), default false
- show_on_website: boolean — Show online (Excel "Show On Website" column), default true
- close_date: string — ISO date YYYY-MM-DD (Excel "Close Date" column)
- bid_increment: number — Bid increment amount (Excel "Bid Increment" column), e.g., 25
- opening_bid: number — Starting bid amount (Excel "Opening Bid" column), e.g., 100
- latitude: number — Decimal degrees (Excel "Latitude" column)
- longitude: number — Decimal degrees (Excel "Longitude" column)

Important Rules:
- Use exact field names as shown above (do NOT translate JSON keys)
- For booleans, use true/false (not strings)
- For numbers, provide numeric values without currency symbols or formatting
- Contract # will be added automatically at report level (do not include in lots)
`;

  const categoryDescriptionGuidance = `
Auctioneer Import - Category and Field Name Rules:
- Select 'categories' first. It MUST be one exact child category from this compact category list.
- The selected child category drives later backend field resolution and ordering.
- Build 'description' and 'condition_report_specs' from visible/provided values that clearly match obvious Auctioneer field labels for the selected child category.
- Include only visible or confidently inferable Field Name values. Do not add unavailable fields.
- For fields that are not visible, not provided, or not confidently inferable, omit the field from condition_report_specs.
- Do not include auction fee, invoice, tax, title-clearance, buyer-fee, or sale boilerplate text in description or condition_report_specs.
- If no category specs are visible or confidently inferable, return the selected category and an empty or minimal condition_report_specs list.
- Keep serial numbers and VINs outside of description; put them in 'serial_number' and 'serial_no_or_label'.
- Format title as the short headline: the clearest asset identity (YEAR MAKE MODEL and type when visible).
- Format description as one or two plain sentences, maximum ${AUCTION_DESCRIPTION_MAX_LENGTH} characters, describing what the item is and what comes with it (key features, attachments, inclusions). Do not repeat the title, and do not pack every spec into description. Do not include Running Condition, Condition, Completeness, Legal, VIN, or serial text. Do not prefix descriptions with list numbering, bullets, "Lot", "Lot #", or "#".
- Put applicable visible specs into condition_report_specs as { "field", "value" } entries using exact field labels when obvious. If the exact Auctioneer field label is uncertain, put the useful detail in 'details' instead of inventing a field label.
- Do not invent categories, field values, model years, specs, capacities, hours, mileage, VINs, or serial numbers.
- The backend will normalize and complete the selected category's ordered field list after this initial image analysis.

Auctioneer Import child categories grouped by parent:
${assetCategorySelectionPrompt}
`;

  const descriptionFormattingRules = `
  Description formatting:
  - Choose the exact child category before writing the description.
  - The title is the headline: YEAR MAKE MODEL [trim/type] when visible; otherwise the clearest visible make/model/type.
  - The description is separate from the title and must not repeat it: one or two plain sentences saying what the item is and what comes with it, using the selected child category and clearly visible/provided values.
  - Keep the description to ${AUCTION_DESCRIPTION_MAX_LENGTH} characters or less.
  - Do not start the description with numbering, bullets, "Lot", "Lot #", or "#".
  - Put individual spec values into condition_report_specs/details rather than listing them in the description.
  - Omit unknown fields from description text. Do not include blank labels, section headers, VINs, serial numbers, Running Condition, Condition, Completeness, or Legal selection text in description.
  - Omit auction fee, invoice, tax, title-clearance, buyer-fee, and sale boilerplate text.
`;


  const exampleDefault = `
Example Output:
{
  "lots": [
    {
      "lot_id": "lot-001",
      "title": "JCB Backhoe Loader",
      "description": "4WD backhoe loader with open ROPS canopy, trenching backhoe bucket and hydraulic outriggers.",
      "condition_report_specs": [
        { "field": "Drive Type", "value": "4WD" },
        { "field": "ROPS / Cab Type", "value": "Open ROPS Cab With Roof And Glass" },
        { "field": "Backhoe Bucket Type", "value": "Trenching" },
        { "field": "Stabilizer Type", "value": "Hydraulic Outriggers/Stabilizers" },
        { "field": "Tire Size", "value": "Front/Rear Large Off-Road Tires" }
      ],
      "condition": "Used - Good",
      "estimated_value": "${ccyPrefix}150",
      "damage_analysis": "Paint Scratches & Chips - light visible scratches on frame and outer surfaces",
      "tags": ["backhoe", "loader", "construction"],
      "image_indexes": [0, 2],
      "lot_number": "101",
      "quantity": 1,
      "must_take": false,
      "categories": "Backhoe Loaders",
      "serial_number": null,
      "show_on_website": true,
      "close_date": "2025-10-31",
      "bid_increment": 25,
      "location": "800 North Service Road, Emerald Park, SK",
      "opening_bid": 100,
      "item_condition": "Unverified Working Condition"
    }
  ],
  "summary": "1 lot identified: JCB backhoe loader.",
  "language": "${lang}",
  "currency": "${ccy}"
}
`;

  const examplePerItem = `
Example Output (per_item):
{
  "lots": [
    {
      "lot_id": "lot-001",
      "lot_number": "101",
      "title": "Canon EOS 80D DSLR Camera Body",
      "description": "24MP digital SLR camera body; includes battery and strap.",
      "condition_report_specs": [
        { "field": "Other Details", "value": "24MP DSLR camera body; light cosmetic wear. Includes battery and strap" }
      ],
      "condition": "Used - Good",
      "estimated_value": "${ccyPrefix}520",
      "damage_analysis": "Paint Scratches & Chips - light cosmetic wear on body edges",
      "quantity": 1,
      "must_take": false,
      "categories": "Consumer Electronics",
      "serial_number": "SN: 12345678",
      "show_on_website": true,
      "close_date": null,
      "bid_increment": 25,
      "location": "800 North Service Road, Emerald Park, SK",
      "opening_bid": 50,
      "latitude": null,
      "longitude": null,
      "item_condition": "Untested",
      "tags": ["camera", "electronics"],
      "image_url": "https://example.com/img-0.jpg",
      "image_indexes": [0]
    },
    {
      "lot_id": "lot-002",
      "lot_number": "102",
      "title": "Canon EF-S 18-135mm Lens",
      "description": "Standard zoom lens with optical image stabilization for Canon APS-C cameras.",
      "condition_report_specs": [
        { "field": "Other Details", "value": "Zoom lens with optical stabilization; standard zoom range" }
      ],
      "condition": "Used - Good",
      "estimated_value": "${ccyPrefix}180",
      "damage_analysis": null,
      "quantity": 1,
      "must_take": false,
      "categories": "Consumer Electronics",
      "serial_number": null,
      "show_on_website": true,
      "close_date": null,
      "bid_increment": 25,
      "location": "800 North Service Road, Emerald Park, SK",
      "opening_bid": 20,
      "latitude": null,
      "longitude": null,
      "item_condition": "Untested",
      "tags": ["lens", "electronics"],
      "image_url": "https://example.com/img-0.jpg",
      "image_indexes": [0]
    }
  ],
  "summary": "2 distinct items identified in a single image: camera body and lens.",
  "language": "${lang}",
  "currency": "${ccy}"
}
`;

  const perPhoto = `
Grouping mode: per_photo
- Return EXACTLY one lot per image; with N images, return N lots total.
- Each lot must contain exactly one image index.
- No overlaps across lots.
- Ensure titles are concise and unique.
${descriptionFormattingRules}
   - Additional per_photo fields to include for each lot:\n   - serial_no_or_label: string | null — extract any visible serial/model numbers or label text. When a VIN is visible, include it labeled EXACTLY as "VIN: <VIN>" (use '*' for unknown characters in a partial VIN). Use null if nothing is visible.

  Lot Number Guidance:
  - Detect any visible numeric lot sticker/label in the image(s). Examples include: "Lot 12", "Lot #12", "#105", or a prominent numeric sticker. If clearly present, set 'lot_number' to the numeric value only (no prefixes like 'Lot' or '#').
  - Avoid confusing years (e.g., 2008), prices, phone numbers, horsepower, or model numbers with lot numbers. Prefer numbers adjacent to "Lot"/"LOT" or printed tags/stickers.
  - If no clear lot sticker/label is visible, set 'lot_number' to null. The server will auto-assign sequential lot numbers and order.

  Focus Box Guidance:
  - CRITICAL: If the image contains a VISIBLE red rectangular focus box overlay (a red-stroked rectangle drawn on top of the image), you MUST ONLY analyze and return the item(s) INSIDE that red box.
  - STRICTLY IGNORE everything outside the red focus box when it is present.
  - Choose the single lot that best represents the content within the box. If multiple candidates are visible, prefer the one most centered within the box.
  - If no red focus box is visible, analyze the entire image normally.
`;

  const perItem = `
Grouping mode: per_item ("everything you see")
- Single-image analysis (typical usage): Identify EVERY unique physical item visible in THIS SINGLE IMAGE and return EACH as its own lot. Do NOT omit any single item. Do not collapse distinct items.
- If multiple identical units exist in the same image, create separate lots for each unit and distinguish titles with "(#1)", "(#2)", etc.
- For single-image analysis, set 'image_indexes' to exactly the provided index for that image ONLY (the caller/user message will specify it). Do NOT include any other indexes.
- Titles must be concise and unique across lots.
${descriptionFormattingRules}
  - Additional per_item fields to include for each lot:
    - serial_no_or_label: string | null — extract any visible serial/model numbers or label text. When a VIN is visible, include it labeled EXACTLY as "VIN: <VIN>" (17 characters; use '*' for partial VINs). Use null if not visible. For partial VINs, include the visible characters and '*' placeholders where unknown.
    - details: string — concise attributes like color, material, size/dimensions, capacity, or model/specs; also note inclusions or notable issues.
    - image_url: REQUIRED — set EXACTLY to the original URL for this image (from the provided list). Do NOT fabricate. Must match one of the provided image URLs.
  - If MULTIPLE images are provided at once, treat each image independently and return lots per image separately. For each lot, set 'image_indexes' to [CURRENT_INDEX] only and 'image_url' to that image's exact URL. Do NOT include indexes from other images.

  Lot Number Guidance:
  - Detect any visible numeric lot sticker/label in the image(s). Examples include: "Lot 12", "Lot #12", "#105", or a prominent numeric sticker. If clearly present, set 'lot_number' to the numeric value only (no prefixes like 'Lot' or '#').
  - Avoid confusing years (e.g., 2008), prices, phone numbers, horsepower, or model numbers with lot numbers. Prefer numbers adjacent to "Lot"/"LOT" or printed tags/stickers.
  - If no clear lot sticker/label is visible, set 'lot_number' to null. The server will auto-assign sequential lot numbers and order.

  Focus Box Guidance:
  - CRITICAL: If the image contains a VISIBLE red rectangular focus box overlay (a red-stroked rectangle drawn on top of the image), you MUST ONLY analyze and return items that are INSIDE that red box.
  - STRICTLY IGNORE all items outside the red focus box when it is present.
  - If multiple items are inside the box, return each as its own lot (per_item mode).
  - If no red focus box is visible, analyze the entire image normally and return all items.
`;

  const singleLot = `
Grouping mode: single_lot
- Combine all images into ONE lot.
- Identify duplicate or near-identical frames/angles (same shot). Include only ONE representative image index per duplicate group (prefer the sharpest/most complete view).
- Deduplicate redundant frames by design.
- Return exactly ONE lot.
- Description formatting for the lot:
  - When the lot holds several distinct items, the description names them briefly; put each item's full specs in 'details' as numbered lines like the examples below.
${descriptionFormattingRules}
 - Optional additional field at lot level:\n   - serial_no_or_label: string | null — if one or more serials/VINs are clearly visible for the primary subject(s), include them. When a VIN is visible, label it EXACTLY as "VIN: <VIN>" (use '*' for partial VINs). For multiple items, separate entries with "; ". Use null if nothing is visible.
  Lot Number Guidance:
  - Detect any visible numeric lot sticker/label in the image(s). Examples include: "Lot 12", "Lot #12", "#105", or a prominent numeric sticker. If clearly present, set 'lot_number' to the numeric value only (no prefixes like 'Lot' or '#').
  - Avoid confusing years (e.g., 2008), prices, phone numbers, horsepower, or model numbers with lot numbers. Prefer numbers adjacent to "Lot"/"LOT" or printed tags/stickers.
  - If no clear lot sticker/label is visible, set 'lot_number' to null. The server will auto-assign sequential lot numbers and order.

  Focus Box Guidance:
  - CRITICAL: If ANY image contains a VISIBLE red rectangular focus box overlay (a red-stroked rectangle drawn on top of the image), you MUST ONLY analyze and include items that are INSIDE that red box from that image.
  - STRICTLY IGNORE all items outside the red focus box when it is present.
  - For images without a red focus box, analyze the entire image normally.
  - Combine all analyzed items across all images into ONE lot as per single_lot mode.

  - Example numbered 'details' lines:
    1. 2002 Kenworth T800 T/A Truck Tractor, CAT C15 475 HP Diesel Engine, 18 Spd Trans, A/R Susp., WetKit, Sliding 5th Wheel, 16,000 lb Front, 46,000 lb Rear, Aluminum Wheels, Front Tires 385/65R22.5, Rear Tires 11R24.5, New CVI
    2. 2004 Kenworth T800 T/A Truck Tractor, CAT C15 Diesel Engine, 18 Spd Trans, 16,000 lb / 46,000 lb Front/Rears, A/R Susp., Alum Headache Rack, Sliding 5th Wheel, Aluminum Wheels, Front Tires 315/80R22.5, Rear 11R24.5, New CVI
    3. 2006 Kenworth T800 T/A Fuel Truck, CAT C11 Diesel Engine, 13 Spd Trans, Chalmers Susp., Advanced 2 Compartment Steel Tank, 2,273 L & 13,683 L, (2) MID Com Pumps, Hoses, & Reels, PTO, Aluminum Wheels, Front Tires 385/65R22.5, Rear Tires 11R24.5, New CVI
`;

  let modeSection = perItem;
  if (groupingMode === "per_photo") {
    modeSection = perPhoto;
  } else if (groupingMode === "single_lot") {
    modeSection = singleLot;
  } else {
    modeSection = perItem;
  }

  const exampleBlock =
    groupingMode === "per_item" ? examplePerItem : exampleDefault;

  return `
${commonOutputRules}
${excelFieldsGuidance}
${categoryDescriptionGuidance}
${modeSection}
Assignment Constraints:
- per_photo: With N images, return N lots and include each image index exactly once (one index per lot). No overlaps.
- per_item: For each lot, image_indexes must be exactly [CURRENT_INDEX] (single element). Do NOT include any other index. Do not merge or dedupe across images in this step. Include image_url equal to the exact original URL string for this image.
- single_lot: Return exactly ONE lot. For duplicate/near-identical frames of the same shot, include only ONE representative index per duplicate group.

Tagging:
- For every lot, include a tag 'mode:<MODE>' in 'tags'. Use one of: 'single_lot', 'per_item', 'per_photo'.

${exampleBlock}

`;
}
