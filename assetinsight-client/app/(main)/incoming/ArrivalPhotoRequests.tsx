"use client";

import { useRouter } from "next/navigation";
import { Camera, CheckCircle2, Inbox, RefreshCw } from "lucide-react";
import type { ArrivalPhotoRequest, CompletedArrivalPhotoRequest } from "@/services/auctioneer";

/**
 * Incoming → Arrival Photo Requests (owner, 2026-11-03). Auctioneer's Awaiting
 * Arrival board asks this user to photograph an arrived lot. "Take photos"
 * opens Lot Listing with the Arrival Photos switch on for that request: the
 * photos are watermarked, not processed, and kept on the lot's Office Only
 * section in Auctioneer. A request leaves this list once its photos arrive,
 * and is then on the Completed list below (owner, 2026-11-04).
 */
export default function ArrivalPhotoRequests({
  requests,
  loading,
  error,
  onRefresh,
}: {
  requests: ArrivalPhotoRequest[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}) {
  const router = useRouter();
  if (error || (loading && !requests.length)) {
    return <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role={error ? "alert" : "status"}>
      <p>{error || "Loading arrival photo requests…"}</p>
      {error ? <button type="button" className="app-button app-button--secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} aria-hidden /> Try again
      </button> : null}
    </div>;
  }
  if (!requests.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <Inbox size={22} aria-hidden className="text-[var(--app-text-muted)]" />
        <h2 className="text-base font-semibold">No arrival photo requests</h2>
        <p className="max-w-md text-sm text-[var(--app-text-muted)]">
          When the office asks you to photograph a lot that has arrived, it is listed here.
        </p>
        <button className="app-button app-button--secondary" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} aria-hidden />
          Check again
        </button>
      </div>
    );
  }
  return (
    <div className="app-table-wrap">
      <table className="app-table app-table--responsive">
        <thead>
          <tr>
            <th>Lot</th>
            <th>Description</th>
            <th>Contract</th>
            <th>Consignor</th>
            <th>Location</th>
            <th>Requested</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.requestId} data-testid="arrival-photo-request">
              <td data-label="Lot">
                <strong>{request.lotNumber || "—"}</strong>
                {request.officeOnlyPhotoCount > 0 ? (
                  <div className="text-xs text-[var(--app-text-muted)]">
                    {request.officeOnlyPhotoCount} Office Only photo{request.officeOnlyPhotoCount === 1 ? "" : "s"} already
                  </div>
                ) : null}
              </td>
              <td data-label="Description" title={request.description || undefined}>
                {request.description || [request.year, request.make, request.model].filter(Boolean).join(" ") || "—"}
                {request.serialNumber ? (
                  <div className="text-xs text-[var(--app-text-muted)]">S/N {request.serialNumber}</div>
                ) : null}
              </td>
              <td data-label="Contract">{request.contractNumber || "—"}</td>
              <td data-label="Consignor">{request.consignorName || "—"}</td>
              <td data-label="Location">{request.location || "—"}</td>
              <td data-label="Requested">
                {request.requestedBy || "Office"}
                {request.requestedAt ? (
                  <div className="text-xs text-[var(--app-text-muted)]">
                    {new Date(request.requestedAt).toLocaleString()}
                  </div>
                ) : null}
              </td>
              <td>
                <button
                  type="button"
                  className="app-button app-button--primary whitespace-nowrap"
                  onClick={() => router.push(`/create/lot-listing?arrivalRequest=${encodeURIComponent(request.requestId)}`)}
                >
                  <Camera size={15} aria-hidden />
                  Take photos
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Incoming → Arrival Photo Requests → Completed (owner, 2026-11-04: "Have
 * 'Completed' tab so arrival photo completed goes there"). The requests whose
 * photos reached Auctioneer, most recently sent first, newest hundred. Nothing
 * to do here: the photos are on the lot's Office Only section in Auctioneer.
 */
export function CompletedArrivalPhotos({
  requests,
  loading,
  error,
  onRefresh,
}: {
  requests: CompletedArrivalPhotoRequest[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}) {
  if (error || (loading && !requests.length)) {
    return <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role={error ? "alert" : "status"}>
      <p>{error || "Loading completed arrival photos…"}</p>
      {error ? <button type="button" className="app-button app-button--secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} aria-hidden /> Try again
      </button> : null}
    </div>;
  }
  if (!requests.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <CheckCircle2 size={22} aria-hidden className="text-[var(--app-text-muted)]" />
        <h2 className="text-base font-semibold">No arrival photos sent yet</h2>
        <p className="max-w-md text-sm text-[var(--app-text-muted)]">
          Once you send a request&apos;s photos, it moves here.
        </p>
      </div>
    );
  }
  return (
    <div className="app-table-wrap">
      <table className="app-table app-table--responsive">
        <thead>
          <tr>
            <th>Lot</th>
            <th>Description</th>
            <th>Contract</th>
            <th>Consignor</th>
            <th>Requested</th>
            <th>Sent</th>
            <th>Photos</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.requestId} data-testid="completed-arrival-photo-request">
              <td data-label="Lot"><strong>{request.lotNumber || "—"}</strong></td>
              <td data-label="Description" title={request.description || undefined}>
                {request.description || [request.year, request.make, request.model].filter(Boolean).join(" ") || "—"}
                {request.serialNumber ? (
                  <div className="text-xs text-[var(--app-text-muted)]">S/N {request.serialNumber}</div>
                ) : null}
              </td>
              <td data-label="Contract">{request.contractNumber || "—"}</td>
              <td data-label="Consignor">{request.consignorName || "—"}</td>
              <td data-label="Requested">
                {request.requestedBy || "Office"}
                {request.requestedAt ? (
                  <div className="text-xs text-[var(--app-text-muted)]">
                    {new Date(request.requestedAt).toLocaleString()}
                  </div>
                ) : null}
              </td>
              <td data-label="Sent">{request.receivedAt ? new Date(request.receivedAt).toLocaleString() : "—"}</td>
              <td data-label="Photos" className="tabular-nums">{request.photoCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
