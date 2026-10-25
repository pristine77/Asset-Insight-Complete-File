import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { captureQuery } from "@/lib/captureInventory";

export async function GET(request: NextRequest) {
  let query: string;
  try { query = captureQuery(request.nextUrl.searchParams, "users"); }
  catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid search." }, { status: 400 }); }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/capture-inventory/users${query ? `?${query}` : ""}`);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ message: "Users could not be loaded. Try searching again." }, { status: 502 });
  }
}
