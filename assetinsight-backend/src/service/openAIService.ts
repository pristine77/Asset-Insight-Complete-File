/**
 * Shared OpenAI boundary for real-estate image analysis and narrative generation.
 * Structured schemas stabilize output shape before persistence; provider failures are
 * normalized and propagated to callers.
 */
import openai from "../utils/openaiClient.js";
import axios from "axios";

export interface ExtractedHouseDetails {
  bedrooms: number;
  bathrooms_full: number;
  bathrooms_half: number;
  garage_description: string;
  basement_description: string;
  major_features: string[];
  known_issues: string[];
}

// Agricultural/Farmland property features
export interface ExtractedFarmlandFeatures {
  property_condition: string;
  land_features: string[];
  buildings_detected: string[];
  crop_type: string;
  soil_quality_estimate: string;
  access_roads: string;
  utilities_visible: string[];
  water_features: string[];
  terrain_type: string;
  estimated_cultivated_percent: number;
  fencing_condition: string;
  drainage_quality: string;
  notes: string;
}

// Commercial property features
export interface ExtractedCommercialFeatures {
  building_type: string;
  construction_type: string;
  condition: string;
  parking_spaces: number;
  loading_docks: number;
  floor_count: number;
  signage_visible: boolean;
  accessibility_features: string[];
  exterior_features: string[];
  interior_visible_features: string[];
  notes: string;
}

// Helper function to fetch image and convert to Base64 with mime type
async function imageUrlToBase64WithMime(
  url: string
): Promise<{ base64: string; mime: string }> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 0,
  });
  const buffer = Buffer.from(response.data as ArrayBuffer);
  const mimeHeader = String(response.headers?.["content-type"] || "").split(";")[0];
  const mime = mimeHeader && mimeHeader.startsWith("image/") ? mimeHeader : "image/jpeg";
  return { base64: buffer.toString("base64"), mime };
}

// JSON schema for residential property analysis
const residentialPropertySchema = {
  type: "object" as const,
  properties: {
    bedrooms: { type: "number" as const },
    bathrooms_full: { type: "number" as const },
    bathrooms_half: { type: "number" as const },
    garage_description: { type: "string" as const },
    basement_description: { type: "string" as const },
    major_features: { type: "array" as const, items: { type: "string" as const } },
    known_issues: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["bedrooms", "bathrooms_full", "bathrooms_half", "garage_description", "basement_description", "major_features", "known_issues"],
  additionalProperties: false,
};

export async function analyzeRealEstateImages(
  imageUrls: string[]
): Promise<ExtractedHouseDetails> {
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error("No image URLs provided for analysis.");
  }

  const urlsToAnalyze = imageUrls.slice(0, 50);
  const imgs = await Promise.all(urlsToAnalyze.map(imageUrlToBase64WithMime));

  const systemPrompt = `You are an expert real estate analyst. Analyze the provided images of a residential property and extract specific details.
Focus on: bedrooms, bathrooms, garage, basement, major features, and any visible issues.
If a detail cannot be determined from the images, use a reasonable default (0 for counts, "Not visible" for descriptions, empty array for lists).`;

  const contentArray: any[] = [
    {
      type: "input_text",
      text: `Analyze these residential property images and extract the property details.\n\nImage URLs:\n${imageUrls.map((u, idx) => `#${idx}: ${u}`).join("\n")}`,
    },
  ];

  for (const { base64, mime } of imgs) {
    contentArray.push({
      type: "input_image",
      image_url: `data:${mime};base64,${base64}`,
      detail: "auto",
    });
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: contentArray,
        },
      ] as any,
      text: {
        format: {
          type: "json_schema",
          name: "residential_property_analysis",
          strict: true,
          schema: residentialPropertySchema,
        },
      },
    } as any);

    const content = response?.output_text?.trim();
    if (!content) {
      throw new Error("OpenAI returned an empty response.");
    }

    return JSON.parse(content) as ExtractedHouseDetails;
  } catch (error) {
    console.error("Error analyzing residential images with OpenAI:", error);
    throw new Error("Failed to analyze images.");
  }
}

// JSON schema for farmland property analysis
const farmlandPropertySchema = {
  type: "object" as const,
  properties: {
    property_condition: { type: "string" as const },
    land_features: { type: "array" as const, items: { type: "string" as const } },
    buildings_detected: { type: "array" as const, items: { type: "string" as const } },
    crop_type: { type: "string" as const },
    soil_quality_estimate: { type: "string" as const },
    access_roads: { type: "string" as const },
    utilities_visible: { type: "array" as const, items: { type: "string" as const } },
    water_features: { type: "array" as const, items: { type: "string" as const } },
    terrain_type: { type: "string" as const },
    estimated_cultivated_percent: { type: "number" as const },
    fencing_condition: { type: "string" as const },
    drainage_quality: { type: "string" as const },
    notes: { type: "string" as const },
  },
  required: ["property_condition", "land_features", "buildings_detected", "crop_type", "soil_quality_estimate", "access_roads", "utilities_visible", "water_features", "terrain_type", "estimated_cultivated_percent", "fencing_condition", "drainage_quality", "notes"],
  additionalProperties: false,
};

/**
 * Analyze farmland/agricultural property images
 */
export async function analyzeFarmlandImages(
  imageUrls: string[]
): Promise<ExtractedFarmlandFeatures> {
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error("No image URLs provided for farmland analysis.");
  }

  const urlsToAnalyze = imageUrls.slice(0, 50);
  const imgs = await Promise.all(urlsToAnalyze.map(imageUrlToBase64WithMime));

  const systemPrompt = `You are an expert agricultural land appraiser. Analyze the provided images of farmland/agricultural property and extract specific details.
Focus on: property condition, land features, buildings, crop type, soil quality, access roads, utilities, water features, terrain, cultivated percentage, fencing, and drainage.
Base your analysis on visible evidence in the images. If something cannot be determined, use reasonable assumptions typical for the region.
Use these values for property_condition: "excellent", "good", "fair", or "poor".
For estimated_cultivated_percent, provide a number between 0-100.`;

  const contentArray: any[] = [
    {
      type: "input_text",
      text: `Analyze these farmland/agricultural property images and provide details for land valuation.\n\nImage URLs:\n${imageUrls.map((u, idx) => `#${idx}: ${u}`).join("\n")}`,
    },
  ];

  for (const { base64, mime } of imgs) {
    contentArray.push({
      type: "input_image",
      image_url: `data:${mime};base64,${base64}`,
      detail: "auto",
    });
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: contentArray,
        },
      ] as any,
      text: {
        format: {
          type: "json_schema",
          name: "farmland_property_analysis",
          strict: true,
          schema: farmlandPropertySchema,
        },
      },
    } as any);

    const content = response?.output_text?.trim();
    if (!content) {
      throw new Error("OpenAI returned an empty response for farmland analysis.");
    }

    return JSON.parse(content) as ExtractedFarmlandFeatures;
  } catch (error) {
    console.error("Error analyzing farmland images with OpenAI:", error);
    throw new Error("Failed to analyze farmland images.");
  }
}

// JSON schema for commercial property analysis
const commercialPropertySchema = {
  type: "object" as const,
  properties: {
    building_type: { type: "string" as const },
    construction_type: { type: "string" as const },
    condition: { type: "string" as const },
    parking_spaces: { type: "number" as const },
    loading_docks: { type: "number" as const },
    floor_count: { type: "number" as const },
    signage_visible: { type: "boolean" as const },
    accessibility_features: { type: "array" as const, items: { type: "string" as const } },
    exterior_features: { type: "array" as const, items: { type: "string" as const } },
    interior_visible_features: { type: "array" as const, items: { type: "string" as const } },
    notes: { type: "string" as const },
  },
  required: ["building_type", "construction_type", "condition", "parking_spaces", "loading_docks", "floor_count", "signage_visible", "accessibility_features", "exterior_features", "interior_visible_features", "notes"],
  additionalProperties: false,
};

/**
 * Analyze commercial property images
 */
export async function analyzeCommercialImages(
  imageUrls: string[]
): Promise<ExtractedCommercialFeatures> {
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error("No image URLs provided for commercial analysis.");
  }

  const urlsToAnalyze = imageUrls.slice(0, 50);
  const imgs = await Promise.all(urlsToAnalyze.map(imageUrlToBase64WithMime));

  const systemPrompt = `You are an expert commercial property appraiser. Analyze the provided images of commercial property and extract specific details.
Focus on: building type, construction type, condition, parking, loading docks, floors, signage, accessibility, and notable features.
Base your analysis on visible evidence. Use 0 for counts if not visible.
Use these values for condition: "excellent", "good", "fair", or "poor".`;

  const contentArray: any[] = [
    {
      type: "input_text",
      text: `Analyze these commercial property images and provide details for property valuation.\n\nImage URLs:\n${imageUrls.map((u, idx) => `#${idx}: ${u}`).join("\n")}`,
    },
  ];

  for (const { base64, mime } of imgs) {
    contentArray.push({
      type: "input_image",
      image_url: `data:${mime};base64,${base64}`,
      detail: "auto",
    });
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: contentArray,
        },
      ] as any,
      text: {
        format: {
          type: "json_schema",
          name: "commercial_property_analysis",
          strict: true,
          schema: commercialPropertySchema,
        },
      },
    } as any);

    const content = response?.output_text?.trim();
    if (!content) {
      throw new Error("OpenAI returned an empty response for commercial analysis.");
    }

    return JSON.parse(content) as ExtractedCommercialFeatures;
  } catch (error) {
    console.error("Error analyzing commercial images with OpenAI:", error);
    throw new Error("Failed to analyze commercial images.");
  }
}

/**
 * Unified function to analyze real estate images based on property type
 */
export async function analyzePropertyImages(
  imageUrls: string[],
  propertyType: "agricultural" | "commercial" | "residential"
): Promise<ExtractedFarmlandFeatures | ExtractedCommercialFeatures | ExtractedHouseDetails> {
  switch (propertyType) {
    case "agricultural":
      return analyzeFarmlandImages(imageUrls);
    case "commercial":
      return analyzeCommercialImages(imageUrls);
    case "residential":
    default:
      return analyzeRealEstateImages(imageUrls);
  }
}
