"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Loading from "@/components/common/Loading";
import { AuctioneerService, type AuctioneerWorkItemSetup } from "@/services/auctioneer";
import { auctioneerSuccessorState } from "./auctioneerContinuation";
import { primaryButtonClass, secondaryButtonClass, type DraftStatus } from "./ui/FormUI";
import {
  consumeReportFormHandoff,
  type ReportFormHandoff,
  type ReportFormKind,
} from "@/services/reportFormNavigation";
import styles from "./ReportFormPage.module.css";
import type { AssetContinuationDetails } from "./AssetForm";
import type { LotContinuationDetails } from "./LotListingForm";
import { safeReportOperationError } from "@/services/reportTransferErrors";

type ContinuationDetails = Partial<AssetContinuationDetails & LotContinuationDetails>;

const AssetForm = dynamic(() => import("@/components/forms/AssetForm"), {
  ssr: false,
  loading: () => <Loading message="Loading asset workspace…" />,
});
const LotListingForm = dynamic(
  () => import("@/components/forms/LotListingForm"),
  {
    ssr: false,
    loading: () => <Loading message="Loading lot listing workspace…" />,
  }
);

type Props = {
  kind: ReportFormKind;
};

type AcceptedContinuation = {
  details?: ContinuationDetails;
  previous: AuctioneerWorkItemSetup;
  reportId?: string;
  pending: boolean;
  error?: string;
  alreadyUsed?: boolean;
};

export default function ReportFormPage({ kind }: Props) {
  const router = useRouter();
  const [handoff, setHandoff] = useState<ReportFormHandoff | null | undefined>();
  const consumedHandoffKindRef = useRef<ReportFormKind | null>(null);
  const continuationLockRef = useRef(false);
  const [draftSetup, setDraftSetup] = useState<{
    key: string;
    state: "loading" | "ready" | "error";
    message?: string;
  } | null>(null);
  const [draftSetupRetry, setDraftSetupRetry] = useState(0);
  const [continuation, setContinuation] = useState<AcceptedContinuation | null>(null);
  const [freshLotOpened, setFreshLotOpened] = useState(false);
  const [continuationDetails, setContinuationDetails] = useState<ContinuationDetails>();
  const continuationHeadingRef = useRef<HTMLHeadingElement>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const [draftStatus, setDraftStatus] = useState<{
    status: DraftStatus;
    label?: string;
  } | null>(null);

  const resumeWorkItemId = handoff?.resumeDraft?.formData?.auctioneerWorkItemId;
  const resumeDraftId = handoff?.resumeDraft?.clientDraftId;
  const resumeSubmissionId = handoff?.resumeDraft?.formData?.clientSubmissionId;
  const resumeDraftType = handoff?.resumeDraft?.type;
  const resumeContractNo = handoff?.resumeDraft?.contractNo;
  const draftSetupKey = resumeWorkItemId === undefined
    ? null
    : `${resumeDraftId}:${String(resumeWorkItemId)}`;

  useEffect(() => {
    // Consuming removes the single-use handoff from session storage. React
    // Strict Mode replays effects in development, so guard the destructive
    // read or the replay replaces a valid incoming/draft handoff with null.
    if (consumedHandoffKindRef.current === kind) return;
    consumedHandoffKindRef.current = kind;
    setHandoff(consumeReportFormHandoff(kind));
  }, [kind]);

  useEffect(() => {
    if (draftSetupKey === null) return;
    const controller = new AbortController();
    setDraftSetup({ key: draftSetupKey, state: "loading" });
    const restoreIntegration = async () => {
      try {
        if (typeof resumeWorkItemId !== "string" || !resumeWorkItemId.trim()) {
          throw new Error("This draft's imported contract reference is invalid. Return to Incoming to open its work item.");
        }
        const setup = await AuctioneerService.getSetup(resumeWorkItemId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const expectedType = kind === "asset" ? "asset" : "lotListing";
        // Linking a placeholder precedes upload acceptance. Resume it only
        // with the server capability and the exact saved identity below.
        const canResume = (setup.status === "claimed" && !setup.reportId) || (
          setup.status === "report_created" && Boolean(setup.reportId) && setup.canResumeUpload === true
        );
        if (
          setup.workItemId !== resumeWorkItemId ||
          setup.reportType !== expectedType ||
          resumeDraftType !== expectedType ||
          setup.clientSubmissionId !== resumeDraftId ||
          setup.clientSubmissionId !== resumeSubmissionId ||
          !resumeContractNo || setup.contract.contractNo !== resumeContractNo ||
          !canResume
        ) {
          throw new Error("This imported draft can no longer be opened as a new report. Check Incoming or your reports for its current status.");
        }
        setHandoff((current) => current ? { ...current, auctioneer: setup } : current);
        setDraftSetup({ key: draftSetupKey, state: "ready" });
      } catch (error) {
        if (controller.signal.aborted) return;
        setDraftSetup({
          key: draftSetupKey,
          state: "error",
          message: safeReportOperationError(error, "Could not verify this draft's imported contract. Retry when your connection is available."),
        });
      }
    };
    void restoreIntegration();
    return () => controller.abort();
  }, [draftSetupKey, draftSetupRetry, kind, resumeContractNo, resumeDraftId, resumeDraftType, resumeSubmissionId, resumeWorkItemId]);

  useEffect(() => {
    if (continuation) continuationHeadingRef.current?.focus();
  }, [continuation]);

  useEffect(() => {
    if (freshLotOpened && !continuation) workspaceHeadingRef.current?.focus();
  }, [freshLotOpened, continuation, handoff?.auctioneer?.workItemId]);

  const returnTo = handoff?.returnTo || "/dashboard";
  const title = kind === "asset" ? "Asset Report" : "Lot Listing";
  const showingFreshLot = freshLotOpened && !continuation;
  const statusLabel =
    draftStatus?.label ||
    (draftStatus?.status === "saving"
      ? "Saving draft…"
      : draftStatus?.status === "saved"
        ? "Draft saved"
        : draftStatus?.status === "dirty"
          ? "Unsaved changes"
          : "Draft status");

  const complete = () => {
    window.dispatchEvent(new Event("cv:report-created"));
    router.push("/previews");
  };

  const openNextLot = async (accepted: AcceptedContinuation) => {
    if (continuationLockRef.current) return;
    continuationLockRef.current = true;
    setDraftStatus(null);
    setContinuation({ ...accepted, pending: true, error: undefined });

    try {
      if (!accepted.reportId) {
        throw new Error("The accepted report did not return its report ID. Open previews to review it; do not submit it again.");
      }
      const next = await AuctioneerService.continueWorkItem(
        accepted.previous.workItemId,
        accepted.reportId
      );
      const nextState = auctioneerSuccessorState(accepted.previous, next);
      if (nextState === "used") {
        setContinuation({ ...accepted, pending: false, alreadyUsed: true });
        return;
      }
      if (nextState !== "fresh") {
        throw new Error("A fresh form could not be confirmed. Retry opening it; the accepted report will not be submitted again.");
      }

      // Drop all prior draft/resume/saved-input state. A different key remounts
      // the form, including its immutable draft scope and submission refs.
      setHandoff({ version: 1, kind, returnTo, auctioneer: next });
      setContinuationDetails(accepted.details);
      setFreshLotOpened(true);
      setContinuation(null);
    } catch (error) {
      setContinuation({
        ...accepted,
        pending: false,
        error: safeReportOperationError(error, "Could not open the next form. Retry when your connection is available. Your accepted report will not be submitted again."),
      });
    } finally {
      continuationLockRef.current = false;
    }
  };

  const continueAfterAccepted = (reportId: string | undefined, details?: ContinuationDetails) => {
    if (!handoff?.auctioneer) return;
    void openNextLot({ previous: handoff.auctioneer, reportId, details, pending: true });
  };

  if (handoff === undefined) {
    return (
      <div className={styles.loading}>
        <Loading message={`Opening ${title.toLowerCase()}…`} />
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <header className={showingFreshLot ? `${styles.header} ${styles.freshLotHeader}` : styles.header}>
        <div className={styles.headingGroup}>
          <p className={styles.eyebrow}>Report workspace</p>
          <h1 ref={workspaceHeadingRef} tabIndex={-1} className={styles.title}>{title}</h1>
          <p
            className={showingFreshLot ? `${styles.description} ${styles.freshLotDescription}` : styles.description}
            role={showingFreshLot ? "status" : undefined}
          >
            {showingFreshLot
              ? `Fresh lot for contract ${handoff?.auctioneer?.contract.contractNo}. Add new media when ready.`
              : "Complete details, organize media, and save or submit when ready."}
          </p>
        </div>
        <div className={styles.actions}>
          {draftStatus ? (
            <span
              className={styles.draftStatus}
              data-status={draftStatus.status}
              title={statusLabel}
            >
              {statusLabel}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.backButton}
            onClick={() => router.push("/dashboard")}
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={17} aria-hidden />
            <span className={styles.backLabel}>Back to dashboard</span>
          </button>
        </div>
      </header>

      <section className={styles.body} aria-label={`${title} form`}>
        {draftSetupKey !== null && (draftSetup?.key !== draftSetupKey || draftSetup.state !== "ready") ? (
          draftSetup?.key === draftSetupKey && draftSetup.state === "error" ? (
            <div className={styles.continuation}>
              <h2>Imported draft unavailable</h2>
              <p role="alert">{draftSetup.message}</p>
              <div className={styles.continuationActions}>
                <button type="button" className={primaryButtonClass} onClick={() => setDraftSetupRetry((count) => count + 1)}>Retry imported draft</button>
                <Link className={secondaryButtonClass} href="/incoming">Open Incoming</Link>
              </div>
            </div>
          ) : <Loading message="Verifying imported draft…" />
        ) : continuation ? (
          <div className={styles.continuation}>
            <h2 ref={continuationHeadingRef} tabIndex={-1}>Report accepted</h2>
            <p>Your upload was accepted. Processing continues in the background; review its preview before generating files.</p>
            {continuation.pending ? (
              <p role="status">Opening a fresh {title.toLowerCase()} form for this contract…</p>
            ) : continuation.alreadyUsed ? (
              <p role="status">The next form already has a report. Open your reports to continue; no new submission was made.</p>
            ) : (
              <>
                <p role="alert">{continuation.error}</p>
                <p>The accepted upload will not be submitted again. Retry only opens the next form once the server confirms this contract is available to you.</p>
              </>
            )}
            <div className={styles.continuationActions}>
              {!continuation.pending && !continuation.alreadyUsed && continuation.reportId ? (
                <button type="button" className={primaryButtonClass} onClick={() => void openNextLot(continuation)}>
                  Retry open new form
                </button>
              ) : null}
              <Link className={secondaryButtonClass} href={continuation.alreadyUsed ? "/reports" : "/previews"}>
                {continuation.alreadyUsed ? "Open reports" : "Open previews"}
              </Link>
            </div>
          </div>
        ) : kind === "asset" ? (
          <AssetForm
            continuationDetails={continuationDetails}
            key={handoff?.resumeDraft?.clientDraftId || handoff?.auctioneer?.workItemId || "asset"}
            onSuccess={complete}
            onAcceptedAndContinue={handoff?.auctioneer ? continueAfterAccepted : undefined}
            onCancel={() => router.push(returnTo)}
            auctioneer={handoff?.auctioneer}
            initialSavedInput={handoff?.savedInput}
            resumeDraft={
              handoff?.resumeDraft?.type === "asset"
                ? handoff.resumeDraft
                : null
            }
            restoreDraftOnMount={Boolean(handoff?.resumeLocalDraftScopeId)}
            resumeLocalDraftScopeId={handoff?.resumeLocalDraftScopeId}
            onDraftStatusChange={(status, label) =>
              setDraftStatus({ status, label })
            }
          />
        ) : (
          <LotListingForm
            continuationDetails={continuationDetails}
            key={handoff?.resumeDraft?.clientDraftId || handoff?.auctioneer?.workItemId || "lot-listing"}
            onSuccess={complete}
            onAcceptedAndContinue={handoff?.auctioneer ? continueAfterAccepted : undefined}
            onCancel={() => router.push(returnTo)}
            auctioneer={handoff?.auctioneer}
            resumeDraft={
              handoff?.resumeDraft?.type === "lotListing"
                ? handoff.resumeDraft
                : null
            }
            restoreDraftOnMount={Boolean(handoff?.resumeLocalDraftScopeId)}
            resumeLocalDraftScopeId={handoff?.resumeLocalDraftScopeId}
            onDraftStatusChange={(status, label) =>
              setDraftStatus({ status, label })
            }
          />
        )}
      </section>
    </main>
  );
}
