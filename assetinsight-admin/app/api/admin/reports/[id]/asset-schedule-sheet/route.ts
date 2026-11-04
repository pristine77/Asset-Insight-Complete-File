import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { readPreviewMutationJson, PreviewResubmitRequestError } from "@/lib/previewResubmitRequest";
import { SERVER_URL } from "@/lib/api";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {

  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Sign in again before saving. Your browser draft is kept." }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await readPreviewMutationJson(request, 16 * 1024 * 1024); }
  catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid request." }, { status: error instanceof PreviewResubmitRequestError ? error.status : 400 }); }
  const expectedActorId = body.expectedActorId;
  if (expectedActorId !== undefined && (typeof expectedActorId !== "string" || !expectedActorId)) {
    return NextResponse.json({ message: "Invalid editor identity. Your changes have not been submitted." }, { status: 400 });
  }
  // Verify the actor with the SAME immutable request token used for the write.
  // Checking browser state alone leaves a cookie-switch race between /me and PATCH.
  const identity = await fetch(`${SERVER_URL}/api/admin/me`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const payload = await identity.json().catch(() => ({}));
  if (!identity.ok) return NextResponse.json({ message: "Sign in again before saving. Your browser draft is kept." }, { status: identity.status === 403 ? 403 : 401 });
  const actor = payload?.user?._id ?? payload?.user?.id;
  if (typeof actor !== "string" || !actor) return NextResponse.json({ message: "Sign in again before saving. Your browser draft is kept." }, { status: 401 });
  // Existing open tabs predate expectedActorId; preserve their ability to save.
  // Updated editors always send it, while every write still uses verified auth/CAS.
  if (expectedActorId !== undefined && actor !== expectedActorId) {
    return NextResponse.json({ code: "PV_ACCOUNT_CHANGED", message: "Your sign-in changed. Reopen the report before saving; the original account's browser draft is kept." }, { status: 409 });
  }
  const { id } = await params;
  const sheetBody = { assetScheduleSheet: body.assetScheduleSheet, baseRevision: body.baseRevision };
  return proxyJsonWithAdminAuth(request, `/api/admin/reports/${encodeURIComponent(id)}/asset-schedule-sheet`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sheetBody),
    // A failed mutation is never replayed with a refreshed/different identity.
    replayAfterRefresh: false,
  });
}
