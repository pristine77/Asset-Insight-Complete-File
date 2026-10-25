import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";

function buildInstruction() {
  return `Extract as many of these fields as possible and return ONLY JSON with this shape. Leave missing fields as empty strings or empty arrays.
{
  "property_details": {
    "owner_name": string,
    "address": string,
    "land_description": string,
    "municipality": string,
    "title_number": string,
    "parcel_number": string,
    "land_area_acres": string,
    "source_quarter_section": string
  },
  "report_dates": {
    "report_date": string, // ISO date YYYY-MM-DD if known
    "effective_date": string, // ISO date YYYY-MM-DD if known
    "inspection_date": string // ISO date YYYY-MM-DD if known
  },
  "house_details": {
    "year_built": string,
    "square_footage": string,
    "lot_size_sqft": string,
    "number_of_rooms": string,
    "number_of_full_bathrooms": string,
    "number_of_half_bathrooms": string,
    "known_issues": string[]
  },
  "inspector_info": {
    "inspector_name": string,
    "company_name": string,
    "contact_email": string,
    "contact_phone": string,
    "credentials": string
  }
}`;
}

async function callOpenAIForJson(prompt: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_TEXT,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that extracts structured JSON fields for a real estate inspection form.",
        },
        { role: "user", content: buildInstruction() + "\n\nTEXT:\n" + prompt },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${t}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY not set" },
        { status: 500 }
      );
    }
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing 'text'" }, { status: 400 });
    }
    const json = await callOpenAIForJson(text);
    return NextResponse.json({ details: json });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to process text" },
      { status: 500 }
    );
  }
}
