import type { NextRequest } from "next/server";
import { youtubeProxy } from "@/lib/youtubeProxy";
export async function POST(request: NextRequest) { return youtubeProxy(request, "erase-data"); }
