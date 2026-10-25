import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { activityIdValid, activityRemoval } from "@/lib/reportActivity";
import { readPreviewMutationJson, PreviewResubmitRequestError } from "@/lib/previewResubmitRequest";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!activityIdValid(id)) return NextResponse.json({ message: "Invalid activity ID." }, { status: 400 });
  try { const response = await proxyJsonWithAdminAuth(request, `/api/admin/report-activity/${id}`); response.headers.set("Cache-Control", "no-store"); return response; }
  catch { return NextResponse.json({ message: "Activity details are unavailable." }, { status: 502 }); }
}
export async function DELETE(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!activityIdValid(id)) return NextResponse.json({ message: "Invalid activity ID." }, { status: 400 });
  let body;
  try { body = activityRemoval(await readPreviewMutationJson(request, 1024)); }
  catch (error) { return NextResponse.json({ message: (error as Error).message }, { status: error instanceof PreviewResubmitRequestError ? error.status : 400 }); }
  try { return await proxyJsonWithAdminAuth(request, `/api/admin/report-activity/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch { return NextResponse.json({ message: "Removal could not be confirmed. Reload to check its outcome." }, { status: 502 }); }
}
