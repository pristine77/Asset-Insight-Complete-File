import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { activityIdValid, activityQuery } from "@/lib/reportActivity";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!activityIdValid(id)) return NextResponse.json({ message: "Invalid activity ID." }, { status: 400 });
  let query: string;
  try { query = activityQuery(request.nextUrl.searchParams, "events"); } catch (error) { return NextResponse.json({ message: (error as Error).message }, { status: 400 }); }
  try { const response = await proxyJsonWithAdminAuth(request, `/api/admin/report-activity/${id}/events?${query}`); response.headers.set("Cache-Control", "no-store"); return response; }
  catch { return NextResponse.json({ message: "Activity events are unavailable." }, { status: 502 }); }
}
