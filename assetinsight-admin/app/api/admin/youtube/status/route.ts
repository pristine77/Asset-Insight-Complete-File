import type { NextRequest } from "next/server";
import { youtubeProxy } from "@/lib/youtubeProxy";
export async function GET(request: NextRequest) { return youtubeProxy(request, "status"); }
