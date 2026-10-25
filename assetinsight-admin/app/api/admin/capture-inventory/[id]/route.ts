import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { captureQuery, captureRemovalBody, isCaptureInventoryId } from "@/lib/captureInventory";
import { PreviewResubmitRequestError, readPreviewMutationJson } from "@/lib/previewResubmitRequest";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!isCaptureInventoryId(id)) return NextResponse.json({ message: "Invalid capture ID." }, { status: 400 });
  let query: string;
  try { query = captureQuery(request.nextUrl.searchParams, "detail"); }
  catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid page." }, { status: 400 }); }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/capture-inventory/${id}${query ? `?${query}` : ""}`);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ message: "Capture details could not be loaded. Refresh to try again." }, { status: 502 });
  }
}
export async function DELETE(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!isCaptureInventoryId(id)) return NextResponse.json({ message: "Invalid capture ID." }, { status: 400 });
  let body: { revision: number };
  try { body = captureRemovalBody(await readPreviewMutationJson(request, 1024)); }
  catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid request." }, { status: error instanceof PreviewResubmitRequestError ? error.status : 400 });
  }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/capture-inventory/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ message: "Removal could not be confirmed. Reload capture history before trying again." }, { status: 502 });
  }
}
