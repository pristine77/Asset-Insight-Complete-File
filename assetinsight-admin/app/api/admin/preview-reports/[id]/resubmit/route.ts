import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { PreviewResubmitRequestError, readPreviewResubmitRequest } from "@/lib/previewResubmitRequest";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) {
    return NextResponse.json({ message: "Invalid report ID." }, { status: 400 });
  }
  let body: { baseRevision: string };
  try {
    body = await readPreviewResubmitRequest(request);
  } catch (error) {
    if (error instanceof PreviewResubmitRequestError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    return NextResponse.json({ message: "Unable to read this request." }, { status: 400 });
  }
  try {
    return await proxyJsonWithAdminAuth(request, `/api/admin/preview-reports/${encodeURIComponent(id)}/resubmit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ message: "Submission could not be confirmed. Reload the preview to check whether processing has started." }, { status: 502 });
  }
}
