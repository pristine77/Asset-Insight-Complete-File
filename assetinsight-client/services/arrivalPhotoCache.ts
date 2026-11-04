import type { ScopedMutator } from "swr";
import { isAuthSessionCurrent, type AuthSessionSnapshot } from "@/lib/auth-storage";

export function arrivalPhotoListKey(
  ownerId: string,
  sessionRevision: number,
  view: "waiting" | "completed",
) {
  return [
    view === "completed"
      ? "auctioneer/arrival-photo-requests/completed"
      : "auctioneer/arrival-photo-requests",
    ownerId,
    sessionRevision,
  ] as const;
}

/** Invalidate only after a confirmed receipt, using the current SWR provider. */
export async function invalidateArrivalPhotoLists(
  mutate: ScopedMutator,
  ownerId: string,
  session: AuthSessionSnapshot,
) {
  if (!isAuthSessionCurrent(session)) return;
  // Supplying undefined creates a mutation fence for older GETs. Revalidation
  // also clears their dedupe markers, even while Incoming is unmounted. A plain
  // mutate(key) can leave an old response eligible to repopulate the cache.
  // A subsequent read failure must not turn a confirmed upload into a failure.
  await Promise.allSettled((["waiting", "completed"] as const).map((view) =>
    mutate(arrivalPhotoListKey(ownerId, session.revision, view), undefined, { revalidate: true }),
  ));
}
