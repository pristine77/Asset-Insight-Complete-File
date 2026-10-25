import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { captureQuery } from "@/lib/captureInventory";

export async function GET(request: NextRequest) {
  let query: string;
  try { query = captureQuery(request.nextUrl.searchParams, "list"); }
  catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid filters." }, { status: 400 }); }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/capture-inventory${query ? `?${query}` : ""}`);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ message: "Capture history is unavailable. Refresh to try again." }, { status: 502 });
  }
}
