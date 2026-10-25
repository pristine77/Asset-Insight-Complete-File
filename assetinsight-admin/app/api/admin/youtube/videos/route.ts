import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { parseYouTubeVideoPage, youtubeVideoQuery } from "@/lib/youtubeVideos";
export async function GET(request: NextRequest) {
  let query: string;
  try { query = youtubeVideoQuery(request.nextUrl.searchParams); }
  catch { return NextResponse.json({ message: "Invalid video page." }, { status: 400 }); }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/youtube/videos?${query}`);
    const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
    if (!response.ok) return NextResponse.json({ message: "Video status is unavailable. Sign in again if your session has expired, then refresh." }, { status: response.status, headers });
    return NextResponse.json(parseYouTubeVideoPage(await response.json()), { headers });
  } catch { return NextResponse.json({ message: "Video status could not be loaded. Refresh to try again." }, { status: 502 }); }
}
