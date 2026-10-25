import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { activityQuery } from "@/lib/reportActivity";
export async function GET(request: NextRequest) {
  let query: string;
  try { query = activityQuery(request.nextUrl.searchParams); } catch (error) { return NextResponse.json({ message: (error as Error).message }, { status: 400 }); }
  try { const response = await proxyJsonWithAdminAuth(request, `/api/admin/report-activity?${query}`); response.headers.set("Cache-Control", "no-store"); return response; }
  catch { return NextResponse.json({ message: "Activity history is unavailable. Refresh to try again." }, { status: 502 }); }
}
