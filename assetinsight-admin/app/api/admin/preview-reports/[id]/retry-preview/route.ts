import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { PreviewResubmitRequestError, readInitialPreviewRetryRequest } from "@/lib/previewResubmitRequest";

type Context = { params: Promise<{ id: string }> };
const invalidId = () => NextResponse.json({ message: "Invalid report ID." }, { status: 400 });

export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) return invalidId();
  try {
    return await proxyJsonWithAdminAuth(request, `/api/admin/preview-reports/${id}/retry-preview`);
  } catch {
    return NextResponse.json({ message: "Unable to check preview recovery. Keep this report and refresh its status." }, { status: 502 });
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!/^[a-f\d]{24}$/i.test(id)) return invalidId();
  try {
    const body = await readInitialPreviewRetryRequest(request);
    return await proxyJsonWithAdminAuth(request, `/api/admin/preview-reports/${id}/retry-preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), replayAfterRefresh: false,
    });
  } catch (error) {
    if (error instanceof PreviewResubmitRequestError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "Retry could not be confirmed. Refresh this report to check whether processing started." }, { status: 502 });
  }
}
