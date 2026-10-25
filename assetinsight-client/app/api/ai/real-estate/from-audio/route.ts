import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4.1-mini";

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

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "Missing 'file'" }, { status: 400 });
    }

    // Prepare form-data for transcription
    const audioArrayBuf = await file.arrayBuffer();
    const audioBlob = new Blob([audioArrayBuf], {
      type: (file as any).type || "audio/webm",
    });
    const fd = new FormData();
    fd.append("file", audioBlob, "audio.webm");
    fd.append("model", TRANSCRIBE_MODEL);

    const transcribeRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd,
      }
    );

    if (!transcribeRes.ok) {
      const t = await transcribeRes.text();
      return NextResponse.json(
        { error: `OpenAI transcription error (${transcribeRes.status}): ${t}` },
        { status: 500 }
      );
    }

    const transcribed = await transcribeRes.json();
    const transcript: string = transcribed?.text || "";

    const details = await callOpenAIForJson(transcript);

    return NextResponse.json({ transcript, details });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to process audio" },
      { status: 500 }
    );
  }
}
