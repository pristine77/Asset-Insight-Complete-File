/**
 * Retrieves source-backed comparable properties for residential, farmland, and
 * commercial valuation flows. Each search path constrains the model to a typed evidence
 * shape and preserves citations, keeping provider-specific prompting outside calculation
 * and report-generation code.
 */
import openai from "../utils/openaiClient.js";

interface PropertyDetails {
  address: string;
  municipality: string;
}

interface HouseDetails {
  square_footage: string;
  bedrooms: number;
  bathrooms_full: number;
  year_built: number;
  lot_size_sqft: string;
  other_features: string;
  known_issues: string;
}

export interface SearchResult {
  title: string;
  link: string;
  price: string;
  address: string;
  size: string;
  snippet: string;
}

// Farmland-specific types
export interface FarmlandPropertyDetails {
  address: string;
  municipality: string;
  rm_area: string;
  total_acres: number;
  cultivated_acres: number;
}

export interface FarmlandSearchResult {
  comp_id: string;
  address: string;
  sale_date: string;
  rm_area: string;
  distance_km: number;
  title_acres: number;
  cultivated_acres: number;
  sale_price: number;
  price_per_cultivated_acre: number;
  data_source: string;
  notes: string;
}

export async function findComparableProperties(
  propertyDetails: PropertyDetails,
  houseDetails: HouseDetails
): Promise<SearchResult[]> {
  const { address, municipality } = propertyDetails;
  const {
    square_footage,
    bedrooms,
    bathrooms_full,
    year_built,
    lot_size_sqft,
    other_features,
    known_issues,
  } = houseDetails;
  console.log(houseDetails);

  const query = `Find 4 comparable real estate listings in ${municipality}, near ${address}. 
**CRITICAL CRITERIA**: 
- Square footage MUST be close to ${square_footage} sq ft .
- Must have at least ${bedrooms} bedrooms and ${bathrooms_full} bathrooms.
- Year built MUST be close to ${year_built}(not important).
- Lot size MUST be close to ${lot_size_sqft} sq ft.
- Other features MUST be close to ${other_features}.
- Known issues MUST be close to ${known_issues}.
Return the response as a **raw JSON array of objects only**, with no additional text or formatting outside the array.
Each object in the array must follow this **exact flat structure**:
{
  "name": "Comparable #[Number]",
  "address": "<value>",
  "listPrice": "<value>",
  "squareFootage": "<value>",
  "lotSize": "<value>",
  "bedrooms": "<value>",
  "bathrooms": "<value>",
  "garage": "<value>",
  "basement": "<value>",
  "otherFeatures": "<value>",
  "condition": "<value>",
  "adjustedValue": "<value>" // this should a last price(or listPrice)
}
If a value is not available, use "Not Found".`;

  console.log(`Performing web search with query: "${query}"`);

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "high",
        },
      ],
      input: query,
    });

    const content = response.output_text;
    // Use a regex to find the JSON array. This is more robust.
    const jsonRegex = /\s*(\[[\s\S]*\])/;
    const match = content.match(jsonRegex);

    if (match && match[1]) {
      const jsonString = match[1];
      try {
        const parsedJson = JSON.parse(jsonString);
        return parsedJson;
      } catch (error) {
        console.error("Error parsing extracted JSON from AI response:", error);
        console.error("Problematic JSON string:", jsonString);
      }
    } else {
      console.error("Could not find a JSON array in the AI response.");
      console.error("Full response content:", content);
    }

    return [];
  } catch (error) {
    console.error(
      "Error performing web search for comparable properties:",
      error
    );
    throw new Error("Failed to fetch comparable properties.");
  }
}

/**
 * Find comparable farmland/agricultural properties
 */
export async function findFarmlandComparables(
  propertyDetails: FarmlandPropertyDetails
): Promise<FarmlandSearchResult[]> {
  const { address, municipality, rm_area, total_acres, cultivated_acres } = propertyDetails;

  const query = `Find 4 comparable agricultural farmland sales near ${address}, ${municipality}, ${rm_area || "Saskatchewan"}.
**CRITICAL CRITERIA**:
- Land size MUST be close to ${total_acres} total acres with approximately ${cultivated_acres} cultivated acres.
- Must be agricultural/farmland properties (not residential).
- Recent sales within the last 2 years preferred.
- Include rural municipality (RM) information.

Return the response as a **raw JSON array of objects only**, with no additional text or formatting outside the array.
Each object in the array must follow this **exact flat structure**:
{
  "comp_id": "F-[Number]",
  "address": "<location description>",
  "sale_date": "<YYYY-MM-DD format>",
  "rm_area": "<Rural Municipality name>",
  "distance_km": <number - estimated distance from subject in km>,
  "title_acres": <number - total acres>,
  "cultivated_acres": <number - cultivated/farmable acres>,
  "sale_price": <number - sale price in dollars without currency symbol>,
  "price_per_cultivated_acre": <number - calculated price per cultivated acre>,
  "data_source": "<MLS / ISC / Private Sale / Government Records>",
  "notes": "<brief description of property condition, soil quality, access>"
}
If a value is not available, use reasonable estimates based on the area.`;

  console.log(`Performing farmland search with query: "${query}"`);

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "high",
        },
      ],
      input: query,
    });

    const content = response.output_text;
    const jsonRegex = /\s*(\[[\s\S]*\])/;
    const match = content.match(jsonRegex);

    if (match && match[1]) {
      const jsonString = match[1];
      try {
        const parsedJson = JSON.parse(jsonString);
        // Ensure all required fields are present
        return parsedJson.map((item: any, idx: number) => ({
          comp_id: item.comp_id || `F-${idx + 1}`,
          address: item.address || "Unknown",
          sale_date: item.sale_date || new Date().toISOString().split("T")[0],
          rm_area: item.rm_area || rm_area || municipality,
          distance_km: parseFloat(item.distance_km) || 10,
          title_acres: parseFloat(item.title_acres) || total_acres,
          cultivated_acres: parseFloat(item.cultivated_acres) || cultivated_acres,
          sale_price: parseFloat(item.sale_price) || 0,
          price_per_cultivated_acre: parseFloat(item.price_per_cultivated_acre) || 0,
          data_source: item.data_source || "MLS",
          notes: item.notes || "",
        }));
      } catch (error) {
        console.error("Error parsing farmland JSON from AI response:", error);
        console.error("Problematic JSON string:", jsonString);
      }
    } else {
      console.error("Could not find a JSON array in the farmland AI response.");
      console.error("Full response content:", content);
    }

    return [];
  } catch (error) {
    console.error("Error performing farmland web search:", error);
    throw new Error("Failed to fetch farmland comparable properties.");
  }
}

/**
 * Find comparable commercial properties
 */
export async function findCommercialComparables(
  propertyDetails: PropertyDetails & { property_type?: string; square_footage?: string }
): Promise<SearchResult[]> {
  const { address, municipality, property_type, square_footage } = propertyDetails;

  const query = `Find 4 comparable commercial property sales near ${address}, ${municipality}.
**CRITERIA**:
- Property type: ${property_type || "commercial"}
- Size approximately ${square_footage || "unknown"} sq ft
- Recent sales preferred

Return as **raw JSON array** with this structure:
{
  "name": "Comparable #[Number]",
  "address": "<value>",
  "listPrice": "<value>",
  "squareFootage": "<value>",
  "lotSize": "<value>",
  "propertyType": "<value>",
  "yearBuilt": "<value>",
  "condition": "<value>",
  "adjustedValue": "<value>"
}`;

  console.log(`Performing commercial search with query: "${query}"`);

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "high",
        },
      ],
      input: query,
    });

    const content = response.output_text;
    const jsonRegex = /\s*(\[[\s\S]*\])/;
    const match = content.match(jsonRegex);

    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (error) {
        console.error("Error parsing commercial JSON:", error);
      }
    }
    return [];
  } catch (error) {
    console.error("Error performing commercial web search:", error);
    throw new Error("Failed to fetch commercial comparable properties.");
  }
}
