import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { PreviewResubmitRequestError, readPreviewReminderRequest } from "@/lib/previewResubmitRequest";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) return NextResponse.json({ message: "Invalid report ID." }, { status: 400 });
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/preview-reports/${encodeURIComponent(id)}/reminder`);
    response.headers.set("Cache-Control", "no-store, private");
    return response;
  } catch {
    return NextResponse.json({ message: "Unable to load the current notification draft." }, { status: 502 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) return NextResponse.json({ message: "Invalid report ID." }, { status: 400 });
  let body;
  try { body = await readPreviewReminderRequest(request); }
  catch (error) {
    return NextResponse.json({ message: error instanceof PreviewResubmitRequestError ? error.message : "Unable to read this request." }, { status: error instanceof PreviewResubmitRequestError ? error.status : 400 });
  }
  try {
    return await proxyJsonWithAdminAuth(request, `/api/admin/preview-reports/${encodeURIComponent(id)}/reminder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ message: "Delivery could not be confirmed. Check this same notification request before sending another message." }, { status: 502 });
  }
}
