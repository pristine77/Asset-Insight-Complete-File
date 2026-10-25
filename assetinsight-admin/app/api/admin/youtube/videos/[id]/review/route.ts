import { NextResponse } from "next/server";

/** Retired endpoint: an old tab must never restore per-video review or change visibility. */
export async function POST() {
  return NextResponse.json({ code: "YOUTUBE_REVIEW_REMOVED", message: "Separate video review is no longer used. Refresh video status to check automatic publication." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
