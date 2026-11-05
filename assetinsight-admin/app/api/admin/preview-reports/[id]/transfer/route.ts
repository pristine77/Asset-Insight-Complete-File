import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { PreviewResubmitRequestError, readPreviewTransferRequest } from "@/lib/previewResubmitRequest";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) {
    return NextResponse.json({ message: "Invalid report ID." }, { status: 400 });
  }
  let body: { targetUserId: string };
  try {
    body = await readPreviewTransferRequest(request);
  } catch (error) {
    if (error instanceof PreviewResubmitRequestError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    return NextResponse.json({ message: "Unable to read this request." }, { status: 400 });
  }
  try {
    return await proxyJsonWithAdminAuth(
      request,
      `/api/admin/preview-reports/${encodeURIComponent(id)}/transfer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // Reassign changes ownership. Never repeat it after a session refresh.
        replayAfterRefresh: false,
      }
    );
  } catch {
    return NextResponse.json({ message: "Reassignment could not be confirmed. Reload and review the current owner before trying again." }, { status: 502 });
  }
}
