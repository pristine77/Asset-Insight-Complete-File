import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const res = await fetch(`${SERVER_URL}/api/admin/reports/${id}/download`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: "Failed to download" }));
    return NextResponse.json(data, { status: res.status });
  }

  // Proxy the file stream with content headers
  const headers = new Headers();
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const disposition = res.headers.get("content-disposition");
  headers.set("content-type", contentType);
  if (disposition) headers.set("content-disposition", disposition);

  const arrayBuffer = await res.arrayBuffer();
  return new NextResponse(arrayBuffer, { status: 200, headers });
}
