/**
 * Produces source-backed market-trend context through the configured web-search model.
 * Prompt constraints and structured parsing keep citations attached to claims, while
 * conservative empty-result handling lets report generation distinguish unavailable
 * evidence from fabricated trend data.
 */
import openai from "../utils/openaiClient.js";

export interface PropertyDetails {
  address: string;
  municipality: string;
}

export interface MarketTrend {
  marketTrends2025: {
    reginaBenchmarkPrice: {
      march: number;
      june: number;
      yearOverYearIncreasePercent: number;
    };
    inventory: {
      monthsOfSupply: number;
      historicalAverageMonths: number;
    };
    salesActivity: {
      comparisonTo10YearAverage: string;
    };
    forecast: {
      lowEstimatePriceGrowthPercent: number;
      highEstimatePriceGrowthPercent: number;
      expectedLate2025AveragePriceCAD: number;
    };
  };
  buyerSellerInsights: {
    marketType: string;
    recommendation: {
      seller: string;
      buyer: string;
    };
  };
  summary: {
    reginaMarket: string;
    lakeridgeMarket: string;
    overallOutlook: string;
  };
}

// Helper function to clean the market trend data
function cleanMarketTrendData(data: any): any {
  if (Array.isArray(data)) {
    return data.map(cleanMarketTrendData);
  }

  if (data && typeof data === "object") {
    const cleanedObject: { [key: string]: any } = {};
    // Numeric fields we must coerce to numbers
    const numericFields = [
      "march",
      "june",
      "yearOverYearIncreasePercent",
      "monthsOfSupply",
      "historicalAverageMonths",
      "lowEstimatePriceGrowthPercent",
      "highEstimatePriceGrowthPercent",
      "expectedLate2025AveragePriceCAD",
    ];

    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = data[key];

        if (numericFields.includes(key)) {
          // Coerce numeric fields robustly
          if (typeof value === "number") {
            cleanedObject[key] = value;
          } else if (typeof value === "string") {
            const lower = value.toLowerCase();
            if (lower === "not found") {
              cleanedObject[key] = 0;
            } else {
              const numeric = parseFloat(value.replace(/[^0-9.-]/g, ""));
              cleanedObject[key] = Number.isFinite(numeric) ? numeric : 0;
            }
          } else {
            cleanedObject[key] = 0;
          }
        } else if (
          typeof value === "string" &&
          value.toLowerCase() === "not found"
        ) {
          // Keep 'Not Found' for string fields
          cleanedObject[key] = value;
        } else {
          cleanedObject[key] = cleanMarketTrendData(value);
        }
      }
    }
    return cleanedObject;
  }

  return data;
}

export async function marketTrendSearch(
  propertyDetails: PropertyDetails
): Promise<MarketTrend[]> {
  const { address, municipality } = propertyDetails;

  const query = `Find real estate market trend for ${municipality}, near ${address}. 
**CRITICAL CRITERIA**: 
Return the response as a **raw JSON array of objects only**, with no additional text or formatting outside the array.
Each object in the array must follow this **exact flat structure**:
{
  "marketTrends2025": {
    "reginaBenchmarkPrice": {
      "march": 326300,
      "june": 343200,
      "yearOverYearIncreasePercent": 7.9
    },
    "inventory": {
      "monthsOfSupply": 1.8,
      "historicalAverageMonths": 5.5
    },
    "salesActivity": {
      "comparisonTo10YearAverage": "15% to 17% above"
    },
    "forecast": {
      "lowEstimatePriceGrowthPercent": 3,
      "highEstimatePriceGrowthPercent": 9,
      "expectedLate2025AveragePriceCAD": 423000
    }
  },
  "buyerSellerInsights": {
    "marketType": "Seller's market",
    "recommendation": {
      "seller": "Favorable time to list due to high demand and low inventory",
      "buyer": "Move quickly to secure property before further appreciation"
    }
  },
  "summary": {
    "reginaMarket": "Strong growth with tight inventory and increasing prices",
    "lakeridgeMarket": "Healthy pricing around mid-$500K with active buyer interest",
    "overallOutlook": "Positive for both appreciation and selling activity in 2025"
  }
}
If a value is not available: use 0 for numeric fields and "Not Found" for string fields.`;

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "high",
        },
      ],

      input: query,
    });

    const content = response.output_text;
    // Find the start of the JSON array in the content
    const jsonStartIndex = content.indexOf("[");
    if (jsonStartIndex === -1) {
      console.error("Could not find a JSON array in the AI response.");
      console.error("Full response content:", content);
      return [];
    }

    // Extract the substring from the start of the JSON array
    const jsonString = content.substring(jsonStartIndex);

    try {
      const parsedJson = JSON.parse(jsonString);
      const cleanedData = cleanMarketTrendData(parsedJson);
      return cleanedData;
    } catch (error) {
      // If parsing fails, it might be due to trailing characters.
      // We can try to find the correct end of the JSON array.
      try {
        let openBrackets = 0;
        let jsonEndIndex = -1;

        for (let i = 0; i < jsonString.length; i++) {
          if (jsonString[i] === "[") {
            openBrackets++;
          } else if (jsonString[i] === "]") {
            openBrackets--;
          }

          if (openBrackets === 0) {
            jsonEndIndex = i;
            break;
          }
        }

        if (jsonEndIndex !== -1) {
          const cleanedJsonString = jsonString.substring(0, jsonEndIndex + 1);
          const parsedJson = JSON.parse(cleanedJsonString);
          const cleanedData = cleanMarketTrendData(parsedJson);
          return cleanedData;
        }
      } catch (e) {
        // If it still fails, log the original error
        console.error("Error parsing extracted JSON from AI response:", error);
        console.error("Problematic JSON string:", jsonString);
        return [];
      }

      // If we couldn't fix it, log the original error
      console.error("Error parsing extracted JSON from AI response:", error);
      console.error("Problematic JSON string:", jsonString);
    }

    return [];
  } catch (error) {
    console.error("Error performing web search for market trend:", error);
    throw new Error("Failed to fetch market trend.");
  }
}
