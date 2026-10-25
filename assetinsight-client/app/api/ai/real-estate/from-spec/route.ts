import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_VISION = "gpt-4.1";

function buildInstruction(imageCount: number) {
  const imageText = imageCount > 1 
    ? `You will be given ${imageCount} photos/scans of real estate spec sheets.` 
    : "You will be given a photo/scan of a real estate spec sheet.";
  
  return `${imageText} Read all text from ALL images and extract as many fields as possible. Combine information from all images into a single result. Return ONLY JSON in this exact shape. Leave unknown fields as empty strings or empty arrays.
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
    "report_date": string,
    "effective_date": string,
    "inspection_date": string
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

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
    }
    const form = await req.formData();
    
    // Collect up to 5 images (file0, file1, file2, file3, file4)
    const imageContents: { type: "image_url"; image_url: { url: string } }[] = [];
    
    for (let i = 0; i < 5; i++) {
      const file = form.get(`file${i}`);
      if (file instanceof Blob) {
        const arrayBuf = await file.arrayBuffer();
        const b64 = Buffer.from(arrayBuf).toString("base64");
        const mime = (file as any).type || "image/png";
        const dataUrl = `data:${mime};base64,${b64}`;
        imageContents.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    }

    if (imageContents.length === 0) {
      return NextResponse.json({ error: "No images provided" }, { status: 400 });
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_VISION,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: "You extract structured JSON fields for a real estate inspection form. Analyze all provided images and combine the information." },
          {
            role: "user",
            content: [
              { type: "text", text: buildInstruction(imageContents.length) },
              ...imageContents,
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json({ error: `OpenAI error (${res.status}): ${t}` }, { status: 500 });
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let json: any = {};
    try { json = JSON.parse(content); } catch {}
    return NextResponse.json({ details: json });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to analyze images" }, { status: 500 });
  }
}
