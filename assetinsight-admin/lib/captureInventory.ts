export type CaptureStatus = "saved" | "paused" | "discarded";
export type CaptureStage = "not_uploaded" | "uploading" | "processing" | "preview_ready" | "generating_files" | "completed" | "error";
export type CaptureUser = { id: string; username: string; email: string; companyName: string; isBlocked: boolean };
export type CaptureRow = {
  id: string; captureId: string; schemaVersion: number; revision: number;
  reportType: "asset" | "lotListing"; clientSubmissionId: string; contractNo: string; localStatus: CaptureStatus;
  creator: CaptureUser;
  device: { platform: string; appVersion: string; registrationId: string | null; verified: boolean };
  deviceCreatedAt: string | null; deviceSavedAt: string | null; firstCapturedAt: string | null; lastCapturedAt: string | null;
  firstReceivedAt: string | null; lastReceivedAt: string | null;
  counts: { lotCount: number; photoCount: number; mainPhotoCount: number; extraPhotoCount: number; availablePhotoCount: number; missingPhotoCount: number };
  server: {
    stage: CaptureStage; uploadedPhotoCount: number | null; expectedPhotoCount: number | null;
    reportId: string | null; uploadSessionId: string | null;
    uploadStartedAt: string | null; uploadCompletedAt: string | null; acceptedAt: string | null;
    previewSubmittedAt: string | null; processingCompletedAt: string | null;
    filesReady: boolean; previewAvailable: boolean; issue: string | null;
  };
};
export type CaptureLot = { id: string; lotNumber: string; title: string; mainPhotoCount: number; extraPhotoCount: number; availablePhotoCount: number; missingPhotoCount: number };
export type CaptureList = { items: CaptureRow[]; total: number; page: number; limit: number; pages: number };
export type CaptureDetail = CaptureRow & { lots: CaptureLot[]; lotsPage: number; lotsLimit: number; lotsTotal: number; lotsPages: number };
export type CaptureFilters = { userId: string; search: string; reportType: string; localStatus: string; receivedFrom: string; receivedTo: string };
export const EMPTY_CAPTURE_FILTERS: CaptureFilters = { userId: "", search: "", reportType: "", localStatus: "", receivedFrom: "", receivedTo: "" };
export const CAPTURE_STAGE_LABELS: Record<CaptureStage, string> = {
  not_uploaded: "Not uploaded", uploading: "Uploading", processing: "Preparing preview", preview_ready: "Preview ready",
  generating_files: "Generating files", completed: "Files generated", error: "Needs attention",
};
export const CAPTURE_STATUS_LABELS: Record<CaptureStatus, string> = { saved: "Saved on device", paused: "Paused on device", discarded: "Discarded on device" };
// Capture ledger IDs are owner-scoped SHA-256 hashes, not Mongo user/report IDs.
export const isCaptureInventoryId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
const invalid = () => new Error("Capture information could not be verified. Refresh to try again.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 500): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = string(value, 50);
  if (!result || !Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
function identifier(value: unknown): string {
  const result = string(value, 100);
  if (!result) throw invalid();
  return result;
}
function user(value: unknown): CaptureUser {
  const data = object(value);
  return { id: identifier(data.id), username: string(data.username), email: string(data.email), companyName: string(data.companyName), isBlocked: bool(data.isBlocked) };
}
function row(value: unknown): CaptureRow {
  const data = object(value), device = object(data.device), counts = object(data.counts), server = object(data.server);
  if (!isCaptureInventoryId(data.id) || !["asset", "lotListing"].includes(string(data.reportType)) || !["saved", "paused", "discarded"].includes(string(data.localStatus)) || !Object.hasOwn(CAPTURE_STAGE_LABELS, string(server.stage))) throw invalid();
  const count = (key: string) => integer(counts[key]);
  const confirmedCount = (key: string) => server[key] == null ? null : integer(server[key]);
  return {
    id: identifier(data.id), captureId: identifier(data.captureId), schemaVersion: integer(data.schemaVersion, 1), revision: integer(data.revision, 1),
    reportType: data.reportType as CaptureRow["reportType"], clientSubmissionId: string(data.clientSubmissionId), contractNo: string(data.contractNo), localStatus: data.localStatus as CaptureStatus,
    creator: user(data.creator), device: { platform: string(device.platform), appVersion: string(device.appVersion), registrationId: string(device.registrationId) || null, verified: bool(device.verified) },
    deviceCreatedAt: date(data.deviceCreatedAt), deviceSavedAt: date(data.deviceSavedAt), firstCapturedAt: date(data.firstCapturedAt), lastCapturedAt: date(data.lastCapturedAt), firstReceivedAt: date(data.firstReceivedAt), lastReceivedAt: date(data.lastReceivedAt),
    counts: { lotCount: count("lotCount"), photoCount: count("photoCount"), mainPhotoCount: count("mainPhotoCount"), extraPhotoCount: count("extraPhotoCount"), availablePhotoCount: count("availablePhotoCount"), missingPhotoCount: count("missingPhotoCount") },
    server: {
      stage: server.stage as CaptureStage, uploadedPhotoCount: confirmedCount("uploadedPhotoCount"), expectedPhotoCount: confirmedCount("expectedPhotoCount"),
      reportId: string(server.reportId) || null, uploadSessionId: string(server.uploadSessionId) || null,
      uploadStartedAt: date(server.uploadStartedAt), uploadCompletedAt: date(server.uploadCompletedAt), acceptedAt: date(server.acceptedAt), previewSubmittedAt: date(server.previewSubmittedAt), processingCompletedAt: date(server.processingCompletedAt),
      filesReady: bool(server.filesReady), previewAvailable: bool(server.previewAvailable), issue: string(server.issue, 2000) || null,
    },
  };
}
export function parseCaptureList(payload: unknown): CaptureList {
  const data = object(object(payload).data);
  if (!Array.isArray(data.items) || data.items.length > 100) throw invalid();
  return { items: data.items.map(row), total: integer(data.total), page: integer(data.page, 1), limit: integer(data.limit, 1), pages: integer(data.pages) };
}
export function parseCaptureDetail(payload: unknown): CaptureDetail {
  const data = object(object(payload).data);
  if (!Array.isArray(data.lots) || data.lots.length > 100) throw invalid();
  const lots = data.lots.map(value => {
    const lot = object(value);
    return { id: identifier(lot.id), lotNumber: string(lot.lotNumber), title: string(lot.title), mainPhotoCount: integer(lot.mainPhotoCount), extraPhotoCount: integer(lot.extraPhotoCount), availablePhotoCount: integer(lot.availablePhotoCount), missingPhotoCount: integer(lot.missingPhotoCount) };
  });
  return { ...row(data), lots, lotsPage: integer(data.lotsPage, 1), lotsLimit: integer(data.lotsLimit, 1), lotsTotal: integer(data.lotsTotal), lotsPages: integer(data.lotsPages) };
}
export function parseCaptureUsers(payload: unknown): { items: CaptureUser[]; hasMore: boolean } {
  const data = object(object(payload).data);
  if (!Array.isArray(data.items) || data.items.length > 50) throw invalid();
  return { items: data.items.map(user), hasMore: bool(data.hasMore) };
}
export function captureQuery(params: URLSearchParams, kind: "list" | "detail" | "users"): string {
  const allowed = kind === "users" ? ["search", "limit"] : kind === "detail" ? ["lotsPage", "lotsLimit"] : ["userId", "search", "reportType", "localStatus", "receivedFrom", "receivedTo", "page", "limit"];
  const result = new URLSearchParams();
  for (const key of allowed) {
    if (params.getAll(key).length > 1) throw new Error("Repeated filter values are not supported.");
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (key === "userId" && !/^[a-f\d]{24}$/i.test(value)) throw new Error("Select a valid user.");
    if (key === "reportType" && !["asset", "lotListing"].includes(value)) throw new Error("Select a valid report type.");
    if (key === "localStatus" && !["saved", "paused", "discarded"].includes(value)) throw new Error("Select a valid device status.");
    if (key === "search" && value.length > 100) throw new Error("Search must be 100 characters or fewer.");
    if (["receivedFrom", "receivedTo"].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error("Enter a valid synchronization date.");
    if (["page", "lotsPage", "limit", "lotsLimit"].includes(key)) {
      const max = key === "limit" && kind === "users" ? 50 : key.includes("Limit") || key === "limit" ? 100 : 100_000;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error("Invalid page size or page number.");
    }
    result.set(key, value);
  }
  if (result.has("receivedFrom") && result.has("receivedTo") && result.get("receivedFrom")! > result.get("receivedTo")!) throw new Error("The start date must be before the end date.");
  return result.toString();
}
export function captureRemovalBody(value: Record<string, unknown>): { revision: number } {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "revision") || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Reload this discarded capture before removing its history.");
  return { revision: value.revision };
}
export function captureTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC" : "Not recorded";
}
