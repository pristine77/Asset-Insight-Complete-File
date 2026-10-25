import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const res = await fetch(`${SERVER_URL}/api/admin/admins`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
  const body = await request.json().catch(() => ({}));

  const res = await fetch(`${SERVER_URL}/api/admin/admins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
