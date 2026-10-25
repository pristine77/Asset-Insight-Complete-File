"use client";
import { useReportActivity } from "./drafts/useReportActivity";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
} from "@/components/ui/legacy";
import {
  MoreHorizontal,
  RotateCcw,
  Save,
  ScanLine,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import API from "@/lib/api";
import {
  FRESH_HIGH_ACCURACY_POSITION_OPTIONS,
  formatBrowserAccuracyStatus,
  formatBrowserLocationAttribution,
  hasUsableReportLocation,
  isValidBrowserCoordinates,
  OPENSTREETMAP_ATTRIBUTION_URL,
  parseBrowserCoordinateLocation,
} from "@/lib/browserLocation";
import { BrowserLocationService } from "@/services/browserLocation";
import { useAuthContext } from "@/context/AuthContext";
import { createLotListing } from "@/services/lotListing";
import { backgroundUploads } from "@/services/backgroundUploadManager";
import { describeOrderedFiles, orderedSubmissionFiles } from "@/services/uploadJobFiles";
import { captureAuthSession, assertAuthSessionCurrent, isAuthSessionCurrent } from "@/lib/auth-storage";
import { isUploadReviewScope, type UploadReviewIdentity } from "@/services/uploadReviewNavigation";
import {
  ReportDraftService,
  createReportDraftClientId,
  getDuplicateLotWarning,
  getReportDraftDeviceId,
  type ReportDraftRecord,
  type ReportDraftSaveProgress,
} from "@/services/reportDrafts";
import ActiveReportConflictDialog from "./ActiveReportConflictDialog";
import DuplicateDraftDialog from "./DuplicateDraftDialog";
import { saveManualDraftOnly } from "./manualDraftSave";
import AuctioneerContinueAction from "./AuctioneerContinueAction";
import { acceptedAuctioneerReportId } from "./auctioneerContinuation";
import { assertReportUploadAccepted, canSaveSeparateReportDraft, isPreviousReportReceipt, reportTransferErrorData, reportTransferErrorMessage, safeReportOperationError } from "@/services/reportTransferErrors";
import SeparateReportDraftRecovery from "./SeparateReportDraftRecovery";
import {
  auctioneerDateOnly,
  auctioneerDraftScope,
  buildAuctioneerSeedLots,
  type AuctioneerFormIntegration,
} from "./auctioneerSeed";
import type { MixedLot } from "./mixed/types";
import { buildMixedFocusBoxes } from "./mixed/focusBoxes";
import {
  DraftEnvelopeError,
  DraftPersistenceError,
  FORM_DRAFT_VERSION,
  deleteScopedDraft,
  getScopedDraftKey,
  hasScopedDraft,
  loadScopedDraft,
  parseScopedDraftEnvelope,
  requestDurableDraftStorage,
  saveScopedDraft,
} from "./drafts/storage";
import { deleteSmartUploadDraft } from "./smartUpload/storage";
import {
  ConfirmDialog,
  DraftSaveProgressPanel,
  FormActionBar,
  FormAlert,
  FormField,
  FormSection,
  FormSwitch,
  FormTransferProgressScreen,
  formClassNames,
  formControlClass,
  formSelectClass,
  iconButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
  type DraftStatus,
} from "./ui/FormUI";

const MixedSection = dynamic(() => import("./mixed/MixedSection"), {
  ssr: false,
});
const SmartUploadWorkspace = dynamic(
  () => import("./smartUpload/SmartUploadWorkspace"),
  { ssr: false }
);

type ValuationMethod = "FML" | "TKV" | "OLV" | "FLV";
const LOT_LISTING_VALUATION_METHODS: ValuationMethod[] = ["FML"];

/** Marks an acceptance that belongs to an earlier submission, not this one. */
const PREVIOUS_RECEIPT_CODE = "PREVIOUS_REPORT_RECEIPT";

/**
 * Whether a failed background upload needs a decision only this form can offer.
 * Each of these has a prompt here — the active-report conflict dialog, the
 * changed-manifest supersede choice, separate-draft recovery, and the earlier
 * receipt warning — so the draft is sent back for an inline Submit rather than
 * retried from the upload bar, where the answer cannot be given. The same test
 * as AssetForm's, so the two report types recover alike.
 */
function lotListingSubmissionNeedsForm(error: unknown): boolean {
  const failure = error as {
    code?: string;
    response?: { status?: number; data?: { code?: string } };
  };
  if (failure?.code === PREVIOUS_RECEIPT_CODE) return true;
  const code = failure?.response?.data?.code;
  if (
    failure?.response?.status === 409 &&
    (code === "ACTIVE_REPORT_EXISTS" || code === "SUBMISSION_MANIFEST_CHANGED")
  ) {
    return true;
  }
  return canSaveSeparateReportDraft(error);
}

type Props = {
  onSuccess?: (message?: string) => void;
  onAcceptedAndContinue?: (reportId: string | undefined, details?: LotContinuationDetails) => void;
  continuationDetails?: Partial<LotContinuationDetails>;
  onCancel?: () => void;
  onDraftStatusChange?: (status: DraftStatus, label?: string) => void;
  auctioneer?: AuctioneerFormIntegration;
  restoreDraftOnMount?: boolean;
  resumeDraft?: ReportDraftRecord | null;
  resumeLocalDraftScopeId?: string;
};

type DraftSnapshot = UploadReviewIdentity & {
  auctioneerWorkItemId?: string;
  contractNo: string;
  salesDate: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  language: "en" | "fr" | "es";
  currency: string;
  bankPhotosEnabled: boolean;
  watermarkImages: boolean;
  clientSubmissionId: string | null;
  lots: MixedLot[];
};

export type LotContinuationDetails = Omit<DraftSnapshot, "clientSubmissionId" | "auctioneerWorkItemId" | "lots">;

type SerializedDraftImage = {
  lotId: string;
  role: "main" | "extra";
  index: number;
  dataUrl: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
};

type SerializedDraftLot = {
  id: string;
  coverIndex: number;
  mode?: MixedLot["mode"];
  annotations?: MixedLot["annotations"];
  mainCount: number;
  extraCount: number;
};

type LegacyLotListingDraftEnvelope = {
  version: 2;
  kind: "lot-listing";
  userId: string;
  revision: number;
  savedAt: string;
  data: Omit<DraftSnapshot, "lots"> & {
    lots: SerializedDraftLot[];
  };
  media: SerializedDraftImage[];
};

type LotListingDraftEnvelope = {
  version: typeof FORM_DRAFT_VERSION;
  kind: "lot-listing";
  userId: string;
  revision: number;
  savedAt: string;
  data: DraftSnapshot;
};

type DraftIssue = {
  tone: "warning" | "error";
  title: string;
  message: string;
};

const isoDate = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

async function dataUrlToFile(image: SerializedDraftImage): Promise<File> {
  const response = await fetch(image.dataUrl);
  if (!response.ok) throw new Error("Draft media could not be restored.");
  const blob = await response.blob();
  return new File([blob], image.name, {
    type: image.mimeType || blob.type,
    lastModified: image.lastModified,
  });
}

async function hydrateLegacyDraft(envelope: LegacyLotListingDraftEnvelope) {
  let missingMediaCount = 0;
  const lots: MixedLot[] = [];

  for (const lotData of envelope.data.lots) {
    const restoreRole = async (role: "main" | "extra") => {
      const files: File[] = [];
      const entries = envelope.media
        .filter((item) => item.lotId === lotData.id && item.role === role)
        .sort((left, right) => left.index - right.index);

      for (const entry of entries) {
        try {
          files.push(await dataUrlToFile(entry));
        } catch {
          missingMediaCount += 1;
        }
      }
      return files;
    };

    const files = await restoreRole("main");
    lots.push({
      id: lotData.id,
      files,
      extraFiles: await restoreRole("extra"),
      coverIndex: Math.max(
        0,
        Math.min(files.length - 1, Number(lotData.coverIndex) || 0)
      ),
      mode: lotData.mode,
      annotations: lotData.annotations || {},
    });
  }

  return {
    data: { ...envelope.data, lots } as DraftSnapshot,
    missingMediaCount,
  };
}

function draftFailureGuidance(error: unknown): DraftIssue {
  const duplicateWarning = getDuplicateLotWarning(error);
  if (duplicateWarning) {
    return {
      tone: "warning",
      title: "Duplicate Lot Detected",
      message: duplicateWarning,
    };
  }

  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";

  if (name === "QuotaExceededError") {
    return {
      tone: "error",
      title: "Draft storage is full",
      message:
        "Your previous draft is still intact. Remove unneeded browser data or reduce the media in this listing, then save again.",
    };
  }

  if (name === "SecurityError") {
    return {
      tone: "error",
      title: "Draft storage is unavailable",
      message:
        "This browser is blocking local storage. Allow site storage or use a regular browsing window before closing this form.",
    };
  }

  if (error instanceof DraftPersistenceError) {
    return {
      tone: "error",
      title: "Draft media was not saved",
      message: error.message,
    };
  }

  return {
    tone: "warning",
    title: "Draft save needs attention",
    message: reportTransferErrorMessage(error, "save"),
  };
}

export default function LotListingForm({
  onSuccess,
  onAcceptedAndContinue,
  continuationDetails,
  onCancel: _onCancel,
  onDraftStatusChange,
  auctioneer,
  restoreDraftOnMount = false,
  resumeDraft = null,
  resumeLocalDraftScopeId,
}: Props) {
  const router = useRouter();
  const { user } = useAuthContext();
  const userId = user?._id || null;
  const draftClientIdRef = useRef(
    resumeDraft?.clientDraftId ||
      resumeLocalDraftScopeId ||
      (restoreDraftOnMount ? auctioneerDraftScope(auctioneer) : "") ||
      auctioneer?.clientSubmissionId ||
      (auctioneer
        ? `auctioneer-${auctioneer.workItemId}`
        : createReportDraftClientId("lot-listing"))
  );
  const draftScopeId = draftClientIdRef.current;
  const [unavailableSessionId, setUnavailableSessionId] = useState<string | null>(null);
  const [separateDraftSaving, setSeparateDraftSaving] = useState(false);
  const draftKey = useMemo(
    () => getScopedDraftKey(userId, "lot-listing", draftScopeId),
    [draftScopeId, userId]
  );
  const importedSalesDate =
    auctioneerDateOnly(auctioneer?.contract.eventDate) || isoDate(new Date());
  const importedLocation =
    auctioneer?.contract.location || "";

  const [mixedLots, setMixedLots] = useState<MixedLot[]>(() =>
    buildAuctioneerSeedLots(auctioneer)
  );
  const [contractNo, setContractNo] = useState(continuationDetails?.contractNo ?? (auctioneer?.contract.contractNo || ""));
  const [salesDate, setSalesDate] = useState(continuationDetails?.salesDate ?? (importedSalesDate));
  const [location, setLocation] = useState(continuationDetails?.location ?? (importedLocation));
  const [latitude, setLatitude] = useState<number | null>(continuationDetails?.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(continuationDetails?.longitude ?? null);
  const [locationStatus, setLocationStatus] = useState(
    auctioneer ? "Imported from Auctioneer" : "Detecting current location..."
  );
  const [locationAttribution, setLocationAttribution] = useState<string | null>(
    null
  );
  const [locationAttributionUrl, setLocationAttributionUrl] = useState<
    string | null
  >(null);
  const [language, setLanguage] = useState<"en" | "fr" | "es">(continuationDetails?.language ?? "en");
  const [currency, setCurrency] = useState(continuationDetails?.currency ?? ("CAD"));
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(continuationDetails?.bankPhotosEnabled ?? (false));
  const [watermarkImages, setWatermarkImages] = useState(continuationDetails?.watermarkImages ?? (false));


  const [openSections, setOpenSections] = useState({
    details: true,
    media: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submissionFinalizing, setSubmissionFinalizing] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [preparingBackgroundUpload, setPreparingBackgroundUpload] = useState(false);
  const [uploadStats, setUploadStats] = useState<{
    totalFiles: number;
    totalSize: number;
    uploadedBytes: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [activeReportConflict, setActiveReportConflict] = useState(false);
  const [duplicateDraftMessage, setDuplicateDraftMessage] = useState<
    string | null
  >(null);
  const [submissionManifestConflict, setSubmissionManifestConflict] =
    useState(false);
  const [smartUploadOpen, setSmartUploadOpen] = useState(false);
  const [smartGroupingMethod, setSmartGroupingMethod] = useState<"black_divider" | "lot_number">("black_divider");

  const [hasDraft, setHasDraft] = useState(false);
  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [draftIssue, setDraftIssue] = useState<DraftIssue | null>(null);
  const [draftSaveProgress, setDraftSaveProgress] =
    useState<ReportDraftSaveProgress | null>(null);
  const [draftSaveActive, setDraftSaveActive] = useState(false);
  const [restoringDraft, setRestoringDraft] = useState(false);
  const [restoredAccountKey, setRestoredAccountKey] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoreProgress, setRestoreProgress] = useState({ completed: 0, total: 0 });
  const accountRestoreKey = resumeDraft
    ? `${userId || ""}:${resumeDraft._id || resumeDraft.id}:${resumeDraft.revision}`
    : null;
  const accountRestoreBlocked = Boolean(resumeDraft) && restoredAccountKey !== accountRestoreKey;
  const restoreBlocked = restoringDraft || accountRestoreBlocked;
  const restoreBlockedRef = useRef(restoreBlocked);
  restoreBlockedRef.current = restoreBlocked;
  useReportActivity(userId, draftScopeId, "lot-listing", contractNo, mixedLots, watermarkImages, !restoreBlocked);
  const [confirmAction, setConfirmAction] = useState<
    "clear" | "discard" | null
  >(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  const jobIdRef = useRef<string | null>(
    draftClientIdRef.current
  );
  const supersededSubmissionIdRef = useRef<string | null>(null);
  const forceNewSubmissionRef = useRef(false);
  const submissionActivityIdRef = useRef<string | undefined>(undefined);
  const submitLockRef = useRef(false);
  const activeFormOperationRef = useRef<"draft-save" | "submit" | null>(null);
  const reportEventSentRef = useRef(false);
  const draftProgressClearTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveBlockedRef = useRef(false);
  const requestedRevisionRef = useRef(0);
  const committedRevisionRef = useRef(0);
  const saveFlightRef = useRef<Promise<boolean> | null>(null);
  const snapshotRef = useRef<DraftSnapshot | null>(null);
  const accountSyncPendingRef = useRef(false);
  const draftSaveAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const locationRequestGenerationRef = useRef(0);
  const locationLookupAbortRef = useRef<AbortController | null>(null);
  const [cancellingOperation, setCancellingOperation] = useState(false);
  const statusCallbackRef = useRef(onDraftStatusChange);
  const mountRestoreStartedRef = useRef(false);
  const shownDuplicateMessageRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      locationRequestGenerationRef.current += 1;
      draftSaveAbortRef.current?.abort();
      submitAbortRef.current?.abort();
      locationLookupAbortRef.current?.abort();
    },
    []
  );

  const syncDuplicateDraftDialog = useCallback((message: string | null) => {
    const normalized = message?.trim() || null;
    if (!normalized) {
      shownDuplicateMessageRef.current = null;
      return;
    }
    if (shownDuplicateMessageRef.current === normalized) return;
    shownDuplicateMessageRef.current = normalized;
    setDuplicateDraftMessage(normalized);
  }, []);

  useEffect(() => {
    statusCallbackRef.current = onDraftStatusChange;
  }, [onDraftStatusChange]);

  const reportDraftStatus = useCallback(
    (status: DraftStatus, label?: string) => {
      statusCallbackRef.current?.(status, label);
    },
    []
  );

  const trackDraftSaveProgress = useCallback(
    (progress: ReportDraftSaveProgress) => {
      if (draftProgressClearTimerRef.current) {
        clearTimeout(draftProgressClearTimerRef.current);
        draftProgressClearTimerRef.current = null;
      }
      setDraftSaveProgress(progress);
    },
    []
  );

  snapshotRef.current = {
    submissionActivityId: submissionActivityIdRef.current,
    forceNewSubmission: forceNewSubmissionRef.current,
    supersededSubmissionId: supersededSubmissionIdRef.current || undefined,
    contractNo,
    salesDate,
    location,
    latitude,
    longitude,
    language,
    currency,
    bankPhotosEnabled,
    watermarkImages,
    clientSubmissionId: jobIdRef.current,
    ...(auctioneer ? { auctioneerWorkItemId: auctioneer.workItemId } : {}),
    lots: mixedLots,
  };

  const locationStateRef = useRef({ location, latitude, longitude });
  locationStateRef.current = { location, latitude, longitude };

  const resolveCoordinatesToLocation = useCallback(
    async ({
      coordinates,
      requestGeneration,
      accuracy,
      restored = false,
    }: {
      coordinates: { latitude: number; longitude: number };
      requestGeneration: number;
      accuracy?: number | null;
      restored?: boolean;
    }) => {
      if (
        !isValidBrowserCoordinates(
          coordinates.latitude,
          coordinates.longitude
        )
      ) {
        if (requestGeneration === locationRequestGenerationRef.current) {
          setLocationStatus(
            "Browser coordinates were unavailable. Re-detect or enter the location manually."
          );
        }
        return;
      }
      if (requestGeneration !== locationRequestGenerationRef.current) return;

      const hadReadableLocation =
        !restored &&
        hasUsableReportLocation(locationStateRef.current.location);
      const controller = new AbortController();
      locationLookupAbortRef.current?.abort();
      locationLookupAbortRef.current = controller;
      setLocationStatus(
        restored
          ? "Finding a readable name for the saved location…"
          : "Finding the nearest readable location…"
      );

      try {
        const resolved = await BrowserLocationService.reverseGeocode(
          coordinates,
          { signal: controller.signal }
        );
        if (
          controller.signal.aborted ||
          requestGeneration !== locationRequestGenerationRef.current
        ) {
          return;
        }

        setLatitude(coordinates.latitude);
        setLongitude(coordinates.longitude);
        setLocation(resolved.location);
        setLocationAttribution(
          formatBrowserLocationAttribution(resolved.attribution)
        );
        setLocationAttributionUrl(
          resolved.attributionUrl || OPENSTREETMAP_ATTRIBUTION_URL
        );
        setLocationStatus(
          accuracy === undefined || accuracy === null
            ? "Browser location restored from draft"
            : formatBrowserAccuracyStatus(accuracy)
        );
        setErrors((current) => {
          if (!current.location) return current;
          const next = { ...current };
          delete next.location;
          return next;
        });
        requestedRevisionRef.current += 1;
        reportDraftStatus("dirty", "Unsaved changes");
      } catch {
        if (
          controller.signal.aborted ||
          requestGeneration !== locationRequestGenerationRef.current
        ) {
          return;
        }
        setLocationStatus(
          hadReadableLocation
            ? "The location name could not be refreshed. Keeping the previous location."
            : "The browser coordinates could not be named. Re-detect or enter the location manually."
        );
      } finally {
        if (locationLookupAbortRef.current === controller) {
          locationLookupAbortRef.current = null;
        }
      }
    },
    [reportDraftStatus]
  );

  const requestCurrentLocation = useCallback(() => {
    const requestGeneration = ++locationRequestGenerationRef.current;
    locationLookupAbortRef.current?.abort();
    locationLookupAbortRef.current = null;

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationStatus("Browser location access is unavailable");
      return;
    }

    setLocationStatus("Detecting current location...");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void resolveCoordinatesToLocation({
          coordinates: {
            latitude: Number(position.coords?.latitude),
            longitude: Number(position.coords?.longitude),
          },
          requestGeneration,
          accuracy: position.coords?.accuracy,
        });
      },
      () => {
        if (requestGeneration === locationRequestGenerationRef.current) {
          setLocationStatus("Browser location access denied or unavailable");
        }
      },
      FRESH_HIGH_ACCURACY_POSITION_OPTIONS
    );
  }, [resolveCoordinatesToLocation]);

  useEffect(() => {
    if (auctioneer) return;
    requestCurrentLocation();
  }, [auctioneer, requestCurrentLocation]);

  const buildDraftEnvelope = useCallback(
    async (
      snapshot: DraftSnapshot,
      revision: number
    ): Promise<LotListingDraftEnvelope> => {
      if (!userId) throw new DOMException("No authenticated user", "SecurityError");

      return {
        version: FORM_DRAFT_VERSION,
        kind: "lot-listing",
        userId,
        revision,
        savedAt: new Date().toISOString(),
        data: {
          ...snapshot,
          lots: snapshot.lots.map((lot) => ({
            ...lot,
            files: [...lot.files],
            extraFiles: [...lot.extraFiles],
            videoFiles: [...(lot.videoFiles || [])],
            annotations: lot.annotations ? { ...lot.annotations } : undefined,
          })),
        },
      };
    },
    [userId]
  );

  const flushDraft = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (!draftKey || !userId || autosaveBlockedRef.current || restoreBlockedRef.current) return false;
    if (saveFlightRef.current) return saveFlightRef.current;

    let task: Promise<boolean>;
    task = (async () => {
      let committed = false;
      const targetRevision = requestedRevisionRef.current;

      while (
        !autosaveBlockedRef.current &&
        committedRevisionRef.current < targetRevision
      ) {
        signal?.throwIfAborted();
        const revision = targetRevision;
        const snapshot = snapshotRef.current;
        if (!snapshot) break;

        reportDraftStatus("saving", "Saving draft...");
        try {
          if (autosaveBlockedRef.current) break;

          const { lots: _lots, ...formData } = snapshot;
          let accountSyncError: unknown;
          let savedDuplicateWarning: string | null = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            signal?.throwIfAborted();
            try {
              const savedDraft = await ReportDraftService.upsertWithMedia(
                {
                  clientDraftId: draftScopeId,
                  kind: "lot-listing",
                  revision,
                  deviceId: getReportDraftDeviceId(),
                  contractNo: snapshot.contractNo,
                  title: snapshot.contractNo
                    ? `Lot Listing - ${snapshot.contractNo}`
                    : "Lot Listing draft",
                  formData,
                },
                snapshot.lots,
                (_progress, message, details) => {
                  trackDraftSaveProgress(details);
                  reportDraftStatus("saving", message);
                },
                signal
              );
              const duplicateWarning = getDuplicateLotWarning(savedDraft);
              savedDuplicateWarning = duplicateWarning;
              syncDuplicateDraftDialog(duplicateWarning);
              setDraftIssue(
                duplicateWarning
                  ? {
                      tone: "warning",
                      title: "Duplicate Lot Detected",
                      message: duplicateWarning,
                    }
                  : null
              );
              accountSyncPendingRef.current = false;
              accountSyncError = undefined;
              break;
            } catch (syncError) {
              if (signal?.aborted) throw syncError;
              accountSyncPendingRef.current = true;
              accountSyncError = syncError;
            }
          }

          if (accountSyncError) throw accountSyncError;

          committedRevisionRef.current = revision;
          committed = true;
          setHasDraft(true);
          setShowDraftBanner(false);

          // Browser draft data is legacy migration state only. Remove it once
          // the complete R2-backed account revision has been verified.
          await deleteScopedDraft(userId, "lot-listing", draftScopeId).catch(
            () => undefined
          );
          if (draftKey) localStorage.removeItem(draftKey);
          if (revision === requestedRevisionRef.current) {
            reportDraftStatus(
              "saved",
              savedDuplicateWarning
                ? "Draft saved - duplicate lot number needs attention"
                : "Draft and photos saved to your account"
            );
          }
        } catch (saveError) {
          if (signal?.aborted) {
            accountSyncPendingRef.current = false;
            setDraftSaveProgress(null);
            setDraftIssue({
              tone: "warning",
              title: "Draft save cancelled",
              message:
                "Your listing and selected media are still open, but these changes are not safely stored yet.",
            });
            reportDraftStatus("dirty", "Save cancelled · unsaved changes");
            toast.info("Draft save cancelled. Your unsaved listing is still open.");
            break;
          }
          const issue = draftFailureGuidance(saveError);
          syncDuplicateDraftDialog(
            issue.title === "Duplicate Lot Detected" ? issue.message : null
          );
          setDraftSaveProgress(null);
          setDraftIssue(issue);
          reportDraftStatus(
            issue.tone === "warning" ? "partial" : "error",
            issue.title
          );
          break;
        }
      }

      return (
        committed &&
        !signal?.aborted &&
        committedRevisionRef.current >= requestedRevisionRef.current
      );
    })();

    saveFlightRef.current = task;
    try {
      return await task;
    } finally {
      if (saveFlightRef.current === task) saveFlightRef.current = null;
    }
  }, [
    draftKey,
    draftScopeId,
    reportDraftStatus,
    syncDuplicateDraftDialog,
    trackDraftSaveProgress,
    userId,
  ]);

  const markDirty = useCallback(() => {
    if (autosaveBlockedRef.current || restoreBlockedRef.current) return;
    requestedRevisionRef.current += 1;
    reportDraftStatus("dirty");
  }, [reportDraftStatus]);

  useEffect(
    () => () => {
      if (draftProgressClearTimerRef.current) {
        clearTimeout(draftProgressClearTimerRef.current);
      }
    },
    []
  );

  const applyRestoredDraft = useCallback(
    (data: DraftSnapshot, revision: number, missingMediaCount: number) => {
      submissionActivityIdRef.current = data.submissionActivityId;
      forceNewSubmissionRef.current = data.forceNewSubmission === true;
      supersededSubmissionIdRef.current = data.supersededSubmissionId || null;
      const explicitCoordinates = isValidBrowserCoordinates(
        data.latitude,
        data.longitude
      )
        ? {
            latitude: Number(data.latitude),
            longitude: Number(data.longitude),
          }
        : null;
      const legacyCoordinates = parseBrowserCoordinateLocation(data.location);
      const storedCoordinates = explicitCoordinates || legacyCoordinates;
      const hasStoredLocation = hasUsableReportLocation(data.location);
      let locationResolutionGeneration: number | null = null;
      if (storedCoordinates || hasStoredLocation) {
        locationResolutionGeneration = ++locationRequestGenerationRef.current;
        locationLookupAbortRef.current?.abort();
        locationLookupAbortRef.current = null;
      }
      setContractNo(data.contractNo || "");
      setSalesDate(data.salesDate || isoDate(new Date()));
      if (hasStoredLocation) {
        setLatitude(storedCoordinates?.latitude ?? null);
        setLongitude(storedCoordinates?.longitude ?? null);
        setLocation(data.location.trim());
        setLocationAttribution(
          storedCoordinates ? formatBrowserLocationAttribution(undefined) : null
        );
        setLocationAttributionUrl(
          storedCoordinates ? OPENSTREETMAP_ATTRIBUTION_URL : null
        );
        setLocationStatus(
          storedCoordinates
            ? "Browser location restored from draft"
            : "Inspection location restored from draft"
        );
      } else if (storedCoordinates && locationResolutionGeneration !== null) {
        setLatitude(storedCoordinates.latitude);
        setLongitude(storedCoordinates.longitude);
        setLocation("");
        setLocationAttribution(null);
        setLocationAttributionUrl(null);
        setLocationStatus("Finding a readable name for the saved location…");
        void resolveCoordinatesToLocation({
          coordinates: storedCoordinates,
          requestGeneration: locationResolutionGeneration,
          restored: true,
        });
      } else {
        setLatitude(null);
        setLongitude(null);
        setLocationAttribution(null);
        setLocationAttributionUrl(null);
        if (auctioneer) {
          setLocation(importedLocation);
          setLocationStatus("Imported from Auctioneer");
        } else {
          setLocation("");
          setLocationStatus(
            "No readable location was saved. Detect it again or enter it manually."
          );
          requestCurrentLocation();
        }
      }
      setLanguage(data.language || "en");
      setCurrency(data.currency || "CAD");
      setBankPhotosEnabled(Boolean(data.bankPhotosEnabled));
      setWatermarkImages(data.watermarkImages === true);
      setMixedLots(Array.isArray(data.lots) ? data.lots : []);
      jobIdRef.current =
        data.clientSubmissionId ||
        auctioneer?.clientSubmissionId ||
        (auctioneer ? `auctioneer-${auctioneer.workItemId}` : null);
      requestedRevisionRef.current = revision;
      committedRevisionRef.current = revision;
      setShowDraftBanner(false);
      setHasDraft(true);

      if (missingMediaCount > 0) {
        setDraftIssue({
          tone: "warning",
          title: "Some draft media could not be restored",
          message: `${missingMediaCount} file${
            missingMediaCount === 1 ? " was" : "s were"
          } skipped. Review each lot before submitting.`,
        });
        reportDraftStatus("partial", "Draft restored with missing media");
      } else {
        setDraftIssue(null);
        reportDraftStatus("saved", "Draft restored");
      }
    },
    [
      auctioneer,
      importedLocation,
      reportDraftStatus,
      requestCurrentLocation,
      resolveCoordinatesToLocation,
    ]
  );

  useEffect(() => {
    if (!draftKey || !userId || resumeDraft) return;
    let cancelled = false;
    void (async () => {
      try {
        await requestDurableDraftStorage();
        const durableDraftExists = await hasScopedDraft(
          userId,
          "lot-listing",
          draftScopeId
        );
        const legacyRaw = localStorage.getItem(draftKey);
        if (!durableDraftExists && !legacyRaw) return;

        let revision = 0;
        if (legacyRaw && !durableDraftExists) {
          const legacy = parseScopedDraftEnvelope<LegacyLotListingDraftEnvelope>(
            legacyRaw,
            { userId, kind: "lot-listing" }
          );
          revision = Number(legacy.revision) || 0;
        }
        if (cancelled) return;
        setHasDraft(true);
        setShowDraftBanner(true);
        requestedRevisionRef.current = revision;
        committedRevisionRef.current = revision;
        reportDraftStatus("saved", "Saved draft available");
      } catch (checkError) {
        if (cancelled) return;
        const unsupported =
          checkError instanceof DraftEnvelopeError &&
          checkError.code === "unsupported-version";
        setHasDraft(true);
        setShowDraftBanner(false);
        setDraftIssue({
          tone: unsupported ? "warning" : "error",
          title: unsupported
            ? "This draft cannot be restored"
            : "Draft storage is unavailable",
          message: unsupported
            ? "It was created by an unsupported form version. Discard it when you are ready to start a new draft."
            : checkError instanceof Error
              ? checkError.message
              : "The browser could not read durable draft storage.",
        });
        reportDraftStatus("error", "Draft needs attention");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftKey, draftScopeId, reportDraftStatus, resumeDraft, userId]);

  const clearFieldError = (field: string) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const handleLotsChange = useCallback(
    (lots: MixedLot[]) => {
      if (restoreBlockedRef.current) return;
      setMixedLots(lots);
      clearFieldError("media");
      markDirty();
    },
    [markDirty]
  );

  const restoreDraft = useCallback(async () => {
    if (!draftKey || !userId) return;
    setRestoringDraft(true);
    setDraftIssue(null);

    try {
      const durable = await loadScopedDraft<LotListingDraftEnvelope>(
        userId,
        "lot-listing",
        draftScopeId
      );
      if (durable) {
        applyRestoredDraft(
          durable.envelope.data,
          Number(durable.envelope.revision) || 0,
          durable.missingMediaCount
        );
      } else {
        const raw = localStorage.getItem(draftKey);
        if (!raw) throw new Error("The saved draft is no longer available.");
        const legacy = parseScopedDraftEnvelope<LegacyLotListingDraftEnvelope>(
          raw,
          { userId, kind: "lot-listing" }
        );
        const migrated = await hydrateLegacyDraft(legacy);

        // Remove v2 only after a complete v3 write/read verification. If a
        // Data URL is damaged, the legacy revision remains available to retry.
        if (migrated.missingMediaCount === 0) {
          const nextEnvelope = await buildDraftEnvelope(
            migrated.data,
            Number(legacy.revision) || 0
          );
          await saveScopedDraft(nextEnvelope, draftScopeId);
          const verified = await loadScopedDraft<LotListingDraftEnvelope>(
            userId,
            "lot-listing",
            draftScopeId
          );
          if (!verified || verified.missingMediaCount > 0) {
            throw new Error("The migrated draft could not be verified.");
          }
          localStorage.removeItem(draftKey);
        }
        applyRestoredDraft(
          migrated.data,
          Number(legacy.revision) || 0,
          migrated.missingMediaCount
        );
      }
      toast.success("Draft restored");
    } catch (restoreError) {
      const message =
        safeReportOperationError(restoreError, "The saved draft could not be restored. Check your connection and account access.");
      setDraftIssue({
        tone: "error",
        title: "Draft restore failed",
        message,
      });
      reportDraftStatus("error", "Draft restore failed");
      toast.error(message);
    } finally {
      setRestoringDraft(false);
    }
  }, [
    applyRestoredDraft,
    buildDraftEnvelope,
    draftKey,
    draftScopeId,
    reportDraftStatus,
    userId,
  ]);

  useEffect(() => {
    if (!resumeDraft || !userId) return;
    const controller = new AbortController();
    setRestoringDraft(true);
    setRestoredAccountKey(null);
    setDraftIssue(null);
    setRestoreProgress({ completed: 0, total: resumeDraft.media?.length || 0 });
    if (resumeDraft.user !== userId) {
      setMixedLots([]);
      setContractNo("");
      setDraftIssue({ tone: "error", title: "Draft belongs to another account", message: "Return to Drafts and open a draft belonging to the signed-in account." });
      setRestoringDraft(false);
      return () => controller.abort();
    }
    const applyMetadata = (resumeDraft: ReportDraftRecord) => {
    const formData = resumeDraft.formData as Record<string, unknown>;
    // Show saved fields immediately. Empty File arrays here are placeholders,
    // never editable/savable state until every saved original has downloaded.
    const metadataLots = (resumeDraft.lots || []).map((value, index) => {
      const lot = value as MixedLot & { lot_id?: string; _id?: string };
      return { ...lot, id: String(lot.id || lot.lot_id || lot._id || `draft-lot-${index + 1}`), files: [], extraFiles: [], videoFiles: [] };
    });
    const serverSnapshot: DraftSnapshot = {
      contractNo: String(
        formData.contractNo || formData.contract_no || resumeDraft.contractNo || ""
      ),
      salesDate: String(
        formData.salesDate || formData.sales_date || isoDate(new Date())
      ),
      location: String(formData.location || ""),
      latitude:
        typeof formData.latitude === "number" ? formData.latitude : null,
      longitude:
        typeof formData.longitude === "number" ? formData.longitude : null,
      language:
        formData.language === "fr" || formData.language === "es"
          ? formData.language
          : "en",
      currency: String(formData.currency || "CAD"),
      bankPhotosEnabled: Boolean(
        formData.bankPhotosEnabled ?? formData.bank_photos_enabled
      ),
      watermarkImages:
        (formData.watermarkImages ?? formData.watermark_images) === true,
      clientSubmissionId: resumeDraft.clientDraftId,
      lots: resumeDraft.storageMode === "smart_upload" ? [] : metadataLots,
    };
    applyRestoredDraft(serverSnapshot, resumeDraft.revision || 0, 0);
    };
    applyMetadata(resumeDraft);

    reportDraftStatus("partial", "Loading saved media…");
    void (async () => {
      const record = restoreAttempt ? await ReportDraftService.get(resumeDraft._id, controller.signal) : resumeDraft;
      if (controller.signal.aborted) return;
      if (record.user !== userId || record.type !== "lotListing" || record._id !== resumeDraft._id || record.clientDraftId !== resumeDraft.clientDraftId) {
        throw new Error("Return to Drafts and open a draft belonging to the signed-in account.");
      }
      if (record !== resumeDraft) applyMetadata(record);
      if (record.storageMode === "smart_upload") {
        setSmartUploadOpen(true);
      } else {
        const lots = await ReportDraftService.restoreLots<MixedLot>(record, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) setRestoreProgress(progress);
          },
        });
        if (controller.signal.aborted) return;
        setMixedLots(lots);
      }
      if (controller.signal.aborted) return;
      setRestoredAccountKey(accountRestoreKey);
      reportDraftStatus("saved", "Draft and photos restored");
      toast.success("Draft restored");
    })()
      .catch((restoreError) => {
        if (controller.signal.aborted) return;
        const message =
          safeReportOperationError(restoreError, "The saved draft could not be restored. Check your connection and account access.");
        setDraftIssue({ tone: "error", title: "Draft restore failed", message: `${message} Your saved draft is unchanged. Retry loading before editing or submitting.` });
        reportDraftStatus("error", "Draft restore failed");
        // Keep the error beside Retry. A separate toast can obscure the mobile
        // controls and remain visible after a successful restoration.
      })
      .finally(() => { if (!controller.signal.aborted) setRestoringDraft(false); });
    return () => controller.abort();
  }, [accountRestoreKey, applyRestoredDraft, reportDraftStatus, restoreAttempt, resumeDraft, userId]);

  useEffect(() => {
    if (
      !restoreDraftOnMount ||
      Boolean(resumeDraft) ||
      !hasDraft ||
      mountRestoreStartedRef.current
    ) {
      return;
    }
    mountRestoreStartedRef.current = true;
    void restoreDraft();
  }, [hasDraft, restoreDraft, restoreDraftOnMount, resumeDraft]);

  const deleteDraftStorage = useCallback(async () => {
    let durableDeleteError: unknown;
    if (userId) {
      const localDeletes = await Promise.allSettled([
        deleteScopedDraft(userId, "lot-listing", draftScopeId),
        deleteSmartUploadDraft(userId, "lot-listing", draftScopeId),
      ]);
      durableDeleteError = localDeletes.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      )?.reason;
    }
    try {
      await ReportDraftService.deleteByClientId(
        draftScopeId,
        "lot-listing"
      );
    } catch (deleteError: any) {
      if (deleteError?.response?.status !== 404) {
        durableDeleteError ||= deleteError;
      }
    }
    if (draftKey) localStorage.removeItem(draftKey);
    accountSyncPendingRef.current = false;
    if (durableDeleteError) throw durableDeleteError;
  }, [draftKey, draftScopeId, userId]);

  const deleteStoredDraft = useCallback(async () => {
    autosaveBlockedRef.current = true;
    await saveFlightRef.current;
    await deleteDraftStorage();
    requestedRevisionRef.current = 0;
    committedRevisionRef.current = 0;
    setHasDraft(false);
    setShowDraftBanner(false);
    setDraftIssue(null);
  }, [deleteDraftStorage]);

  const resetFormState = useCallback(() => {
    submissionActivityIdRef.current = undefined;
    locationRequestGenerationRef.current += 1;
    locationLookupAbortRef.current?.abort();
    locationLookupAbortRef.current = null;
    setMixedLots(buildAuctioneerSeedLots(auctioneer));
    setContractNo(auctioneer?.contract.contractNo || "");
    setSalesDate(importedSalesDate);
    setLocation(importedLocation);
    setLatitude(null);
    setLongitude(null);
    setLocationAttribution(null);
    setLocationAttributionUrl(null);
    setLocationStatus(
      auctioneer ? "Imported from Auctioneer" : "Detecting current location..."
    );
    setLanguage("en");
    setCurrency("CAD");
    setBankPhotosEnabled(false);
    setWatermarkImages(false);
    setError(null);
    setErrors({});
    setUploadPercent(0);
    setUploadStats(null);
    setOpenSections({ details: true, media: true });
    jobIdRef.current =
      auctioneer?.clientSubmissionId ||
      (auctioneer ? `auctioneer-${auctioneer.workItemId}` : null);
    forceNewSubmissionRef.current = false;
    supersededSubmissionIdRef.current = null;
    if (!auctioneer) requestCurrentLocation();
  }, [
    auctioneer,
    importedLocation,
    importedSalesDate,
    requestCurrentLocation,
  ]);

  const handleConfirmedAction = useCallback(async () => {
    if (restoreBlockedRef.current) return;
    const action = confirmAction;
    setConfirmAction(null);
    try {
      await deleteStoredDraft();
      if (action === "clear") {
        resetFormState();
        reportDraftStatus("dirty", "No draft saved");
        toast.info("Lot listing cleared.");
      } else {
        reportDraftStatus("dirty", "Draft discarded");
        toast.info("Saved draft discarded.");
      }
    } catch (deleteError) {
      const issue = draftFailureGuidance(deleteError);
      setDraftIssue(issue);
      reportDraftStatus("error", "Draft could not be removed");
    } finally {
      autosaveBlockedRef.current = false;
    }
  }, [
    confirmAction,
    deleteStoredDraft,
    reportDraftStatus,
    resetFormState,
  ]);

  const handleSaveDraft = useCallback(async () => {
    if (
      activeFormOperationRef.current ||
      restoreBlockedRef.current ||
      submitting ||
      restoringDraft ||
      draftSaveAbortRef.current ||
      saveFlightRef.current
    ) {
      return;
    }
    activeFormOperationRef.current = "draft-save";
    requestedRevisionRef.current += 1;
    const controller = new AbortController();
    draftSaveAbortRef.current = controller;
    if (draftProgressClearTimerRef.current) {
      clearTimeout(draftProgressClearTimerRef.current);
      draftProgressClearTimerRef.current = null;
    }
    setDraftSaveProgress(null);
    setDraftSaveActive(true);
    setCancellingOperation(false);
    try {
      await saveManualDraftOnly(() => flushDraft(controller.signal), () => {
        reportDraftStatus("saved", "Draft and photos saved to your account");
        toast.success("Draft and photos saved.");
      });
    } finally {
      if (draftSaveAbortRef.current === controller) {
        draftSaveAbortRef.current = null;
      }
      if (activeFormOperationRef.current === "draft-save") {
        activeFormOperationRef.current = null;
      }
      setDraftSaveActive(false);
      setCancellingOperation(false);
      if (draftProgressClearTimerRef.current) {
        clearTimeout(draftProgressClearTimerRef.current);
      }
      draftProgressClearTimerRef.current = setTimeout(() => {
        setDraftSaveProgress(null);
        draftProgressClearTimerRef.current = null;
      }, 2500);
    }
  }, [flushDraft, reportDraftStatus, restoringDraft, submitting]);

  const validateForm = useCallback(
    ({ requireMedia = true }: { requireMedia?: boolean } = {}) => {
      const nextErrors: Record<string, string> = {};
      if (!contractNo.trim()) {
        nextErrors.contractNo = "Enter a contract number.";
      }
      if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) {
        nextErrors.currency = "Use a three-letter currency code such as CAD.";
      }
      if (!hasUsableReportLocation(location)) {
        nextErrors.location =
          "Wait for browser location detection or enter the inspection location.";
      }

      if (requireMedia) {
        const hasMainImages = mixedLots.some((lot) => lot.files.length > 0);
        const everyLotReady =
          mixedLots.length > 0 &&
          mixedLots.every((lot) => lot.files.length > 0 && Boolean(lot.mode));
        if (!hasMainImages) {
          nextErrors.media = "Add at least one main photo.";
        } else if (!everyLotReady) {
          nextErrors.media =
            "Every lot needs a main photo and a Bundle, Per Item, or Per Photo mode.";
        }
      }

      setErrors(nextErrors);
      if (nextErrors.contractNo || nextErrors.currency) {
        setOpenSections((current) => ({ ...current, details: true }));
      }
      if (nextErrors.media) {
        setOpenSections((current) => ({ ...current, media: true }));
      }

      return Object.keys(nextErrors).length === 0;
    },
    [contractNo, currency, location, mixedLots]
  );

  const clearAcceptedDraft = useCallback(async (): Promise<unknown | null> => {
    autosaveBlockedRef.current = true;

    let cleanupError: unknown | null = null;
    try {
      await saveFlightRef.current;
      await deleteDraftStorage();
    } catch (draftError) {
      // The server has already accepted the report at this point. Local cleanup
      // must never turn that successful submission into a retryable upload error.
      cleanupError = draftError;
    }

    requestedRevisionRef.current = 0;
    committedRevisionRef.current = 0;
    setHasDraft(false);
    setShowDraftBanner(false);
    setDraftIssue(null);
    resetFormState();
    autosaveBlockedRef.current = false;
    return cleanupError;
  }, [deleteDraftStorage, resetFormState]);

  const dispatchReportCreated = useCallback(() => {
    if (reportEventSentRef.current || typeof window === "undefined") return;
    reportEventSentRef.current = true;
    window.dispatchEvent(new Event("cv:report-created"));
  }, []);

  const smartUploadDetails = useMemo<Record<string, unknown>>(
    () => ({
      smart_upload: true,
      grouping_mode: "mixed",
      contract_no: contractNo.trim(),
      sales_date: salesDate,
      location: location.trim(),
      ...(isValidBrowserCoordinates(latitude, longitude)
        ? {
            latitude: Number(latitude),
            longitude: Number(longitude),
          }
        : {}),
      language,
      currency: currency.trim().toUpperCase(),
      valuation_methods: LOT_LISTING_VALUATION_METHODS,
      include_damage_analysis: true,
      bank_photos_enabled: bankPhotosEnabled,
      watermark_images: watermarkImages,
      activity_id: draftScopeId,
      force_new: forceNewSubmissionRef.current,
      ...(auctioneer && {
        auctioneer_work_item_id: auctioneer.workItemId,
      }),
    }),
    [
      auctioneer,
      bankPhotosEnabled,
      contractNo,
      currency,
      language,
      latitude,
      location,
      longitude,
      salesDate,
      watermarkImages,
    ]
  );

  const openSmartUploadWorkspace = useCallback((method: "black_divider" | "lot_number" = "black_divider") => {
    if (mixedLots.length > 0) {
      toast.info(
        "Smart Upload starts with an empty media form. Clear the manually created lots first."
      );
      return;
    }
    if (!validateForm({ requireMedia: false })) {
      const message =
        "Complete the highlighted listing details before starting Smart Upload.";
      setError(message);
      toast.error(message);
      return;
    }
    setError(null);
    setSmartGroupingMethod(method);
    setSmartUploadOpen(true);
  }, [mixedLots.length, validateForm]);

  const handleSmartUploadSubmitted = useCallback(async () => {
    const accepted =
      "Smart Upload accepted - preview processing continues in My Reports.";
    setSmartUploadOpen(false);
    reportEventSentRef.current = false;
    const cleanupError = await clearAcceptedDraft();
    forceNewSubmissionRef.current = false;
    supersededSubmissionIdRef.current = null;
    dispatchReportCreated();
    toast.success(accepted);
    if (cleanupError) {
      toast.warning(
        "The report was accepted, but its previous manual draft could not be removed."
      );
    }
    onSuccess?.(accepted);
  }, [clearAcceptedDraft, dispatchReportCreated, onSuccess]);

  const onSubmit = useCallback(
    async (event?: React.FormEvent, continueWithNewLot = false) => {
      event?.preventDefault();
      if (activeFormOperationRef.current || submitLockRef.current || restoreBlockedRef.current) return;
      setError(null);

      if (!validateForm()) {
        const message = "Review the highlighted fields before submitting.";
        setError(message);
        toast.error(message);
        return;
      }

      activeFormOperationRef.current = "submit";
      submitLockRef.current = true;
      reportEventSentRef.current = false;
      autosaveBlockedRef.current = true;
      const controller = new AbortController();
      submitAbortRef.current = controller;
      const submitSession = captureAuthSession();
      setCancellingOperation(false);
      setSubmissionFinalizing(false);

      const lotsForSubmission = mixedLots;
      const filesToSend = lotsForSubmission.flatMap((lot) => [
        ...lot.files,
        ...lot.extraFiles,
      ]);
      const videoFilesToSend = lotsForSubmission.flatMap(
        (lot) => lot.videoFiles || []
      );
      const allFilesToSend = [...filesToSend, ...videoFilesToSend];
      const totalSize = allFilesToSend.reduce((sum, file) => sum + file.size, 0);

      setSubmitting(true);
      setUploadPercent(0);
      setUploadStats({
        totalFiles: allFilesToSend.length,
        totalSize,
        uploadedBytes: 0,
      });

      const jobId =
        jobIdRef.current ||
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : "ll-" +
            Date.now() +
            "-" +
            Math.random().toString(36).slice(2, 9));
      jobIdRef.current = jobId;

      const focusBoxes = buildMixedFocusBoxes(lotsForSubmission);

      const details = {
        contract_no: contractNo.trim(),
        sales_date: salesDate,
        location: location.trim(),
        ...(isValidBrowserCoordinates(latitude, longitude)
          ? {
              latitude: Number(latitude),
              longitude: Number(longitude),
            }
          : {}),
        language,
        currency: currency.trim().toUpperCase(),
        valuation_methods: LOT_LISTING_VALUATION_METHODS,
        include_damage_analysis: true,
        bank_photos_enabled: bankPhotosEnabled,
        watermark_images: watermarkImages,
        progress_id: jobId,
        activity_id: submissionActivityIdRef.current || draftScopeId,
        client_submission_id: jobId,
        force_new: forceNewSubmissionRef.current,
        ...(supersededSubmissionIdRef.current
          ? {
              supersedes_client_submission_id:
                supersededSubmissionIdRef.current,
            }
          : {}),
        ...(auctioneer && {
          auctioneer_work_item_id: auctioneer.workItemId,
        }),
        mixed_lots: lotsForSubmission.map((lot) => ({
          count: lot.files.length,
          extra_count: lot.extraFiles.length,
          video_count: (lot.videoFiles || []).length,
          cover_index: Math.max(
            0,
            Math.min(lot.files.length - 1, lot.coverIndex || 0)
          ),
          mode: lot.mode,
          ...(lot.source && {
            source_key: lot.source.key,
            ...(lot.source.parentKey ? { source_parent_key: lot.source.parentKey } : {}),
            source_lot_id: lot.source.lotId,
            source_submission_id: lot.source.submissionId,
          }),
        })),
        ...(focusBoxes.length > 0 ? { focus_boxes: focusBoxes } : {}),
      };

      /*
         Hand the upload to the background line and close the form, unless this
         submission needs to stay here. Auctioneer work does: its continuation
         can only be requested against an accepted reportId, and the decision
         prompts (active report, changed manifest) live in this component. A
         draft whose last background attempt hit one of those is marked
         foreground, so its next Submit runs inline where it can be answered.
      */
      try {
      if (saveFlightRef.current) await saveFlightRef.current;
      assertAuthSessionCurrent(submitSession);
      controller.signal.throwIfAborted();
      const mustStayInForm =
        Boolean(auctioneer) ||
        isUploadReviewScope(draftScopeId) ||
        backgroundUploads.isForegroundRequired("lot-listing", draftScopeId);
      if (!mustStayInForm && userId) {
        setPreparingBackgroundUpload(true);
        const orderedFiles = orderedSubmissionFiles("lot-listing", lotsForSubmission);
        const draftSnapshot = await buildDraftEnvelope({
          ...snapshotRef.current!, clientSubmissionId: jobId, lots: lotsForSubmission,
        }, requestedRevisionRef.current);
        assertAuthSessionCurrent(submitSession);
        controller.signal.throwIfAborted();
        await backgroundUploads.enqueue({
          ownerId: userId,
          kind: "lot-listing",
          scopeId: draftScopeId,
          endpoint: "/lot-listing",
          title: contractNo.trim() || "Lot listing",
          totalFiles: orderedFiles.length,
          clientSubmissionId: jobId,
          details,
          files: describeOrderedFiles(orderedFiles),
          media: orderedFiles,
          draftSnapshot,
          signal: controller.signal,
          needsFormDecision: lotListingSubmissionNeedsForm,
          upload: async (onProgress, signal) => {
            const response = await createLotListing(details, lotsForSubmission, {
              onUploadProgress: onProgress,
              signal,
            });
            assertReportUploadAccepted(response);
            // Exact immutable retries are reconciled by the manager.
            return response;
          },
        });
        assertAuthSessionCurrent(submitSession);
        controller.signal.throwIfAborted();
        /*
           The next listing needs its own draft scope: the handed-off upload
           still owns the saved media behind the old one.
        */
        draftClientIdRef.current = createReportDraftClientId("lot-listing");
        jobIdRef.current = null;
        dispatchReportCreated();
        resetFormState();
        forceNewSubmissionRef.current = false;
        supersededSubmissionIdRef.current = null;
        /*
           Release this form's submit locks. The busy state set at the top of
           onSubmit belongs to an inline upload; the upload is the line's now,
           and left set it kept the cleared form inert and refused every later
           Submit and Save Draft until the form was reopened. The new scope
           starts with nothing to save. Draft saving stays blocked until the
           reset has rendered, so clearing the form never reads as an edit.
        */
        setSubmitting(false);
        setPreparingBackgroundUpload(false);
        submitLockRef.current = false;
        if (activeFormOperationRef.current === "submit") {
          activeFormOperationRef.current = null;
        }
        if (submitAbortRef.current === controller) submitAbortRef.current = null;
        setCancellingOperation(false);
        setSubmissionFinalizing(false);
        requestedRevisionRef.current = 0;
        committedRevisionRef.current = 0;
        setHasDraft(false);
        setShowDraftBanner(false);
        setDraftIssue(null);
        window.setTimeout(() => {
          if (!isAuthSessionCurrent(submitSession)) return;
          autosaveBlockedRef.current = false;
        }, 0);
        reportDraftStatus("saved", "Upload continues in the background");
        const handedOff =
          "Report saved on this browser. Upload continues while this tab stays open; use the upload bar to pause or resume.";
        toast.success(handedOff);
        onSuccess?.(handedOff);
        return;
      }
      // This attempt is answering the conflict that sent it back here.
      backgroundUploads.clearForegroundRequirement("lot-listing", draftScopeId);

      const updateUploadProgress = (fraction: number) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        setUploadPercent((current) =>
          Math.max(current, Math.round(clamped * 100))
        );
        setUploadStats((current) =>
          current
            ? {
                ...current,
                uploadedBytes: Math.floor(clamped * current.totalSize),
              }
            : current
        );
      };

        /*
           One transport, shared with the background line and with a resumed
           upload: the per-lot ordering is part of the manifest identity, so it
           must not be rebuilt differently anywhere else.
        */
        const responseData = await createLotListing(details, lotsForSubmission, {
          onUploadProgress: updateUploadProgress,
          signal: controller.signal,
        });
        assertReportUploadAccepted(responseData);
        assertAuthSessionCurrent(submitSession);
        if (isPreviousReportReceipt(responseData)) {
          throw new Error("An earlier submission was already accepted. Your current edits have not been submitted again. Open My Reports in another tab to check the existing report before continuing.");
        }

        if (submitAbortRef.current === controller) submitAbortRef.current = null;
        setSubmissionFinalizing(true);
        updateUploadProgress(1);
        const acceptedMessage =
          "Submission accepted — processing continues in My Reports.";
        const continuing = Boolean(continueWithNewLot && auctioneer && onAcceptedAndContinue);
        if (continuing) {
          // Open the successor at upload acceptance; cleanup remains scoped to
          // the old draft and does not delay or authorize another upload.
          dispatchReportCreated();
          onAcceptedAndContinue?.(acceptedAuctioneerReportId(responseData), {
            contractNo, salesDate, location, latitude, longitude, language, currency,
            bankPhotosEnabled, watermarkImages,
          });
        }
        const cleanupError = await clearAcceptedDraft();
        forceNewSubmissionRef.current = false;
        supersededSubmissionIdRef.current = null;
        dispatchReportCreated();
        toast.success(acceptedMessage);
        if (cleanupError) {
          toast.warning(
            "Report submitted, but its local draft could not be removed. You can discard the old local copy later."
          );
        }
        if (!continuing) {
          onSuccess?.(acceptedMessage);
        }
      } catch (submitError: any) {
        setPreparingBackgroundUpload(false);
        const isConflict =
          submitError?.response?.status === 409 &&
          submitError?.response?.data?.code === "ACTIVE_REPORT_EXISTS";
        const isManifestConflict =
          submitError?.response?.status === 409 &&
          submitError?.response?.data?.code === "SUBMISSION_MANIFEST_CHANGED";
        autosaveBlockedRef.current = false;
        setSubmitting(false);
        submitLockRef.current = false;
        if (activeFormOperationRef.current === "submit") {
          activeFormOperationRef.current = null;
        }
        if (submitAbortRef.current === controller) submitAbortRef.current = null;
        setCancellingOperation(false);
        setSubmissionFinalizing(false);

        if (!isAuthSessionCurrent(submitSession)) return;

        if (controller.signal.aborted) {
          const message =
            "Upload stopped. Your listing details and selected media are still here and have not been cleared.";
          setError(message);
          reportDraftStatus("dirty", "Upload stopped · unsaved changes");
          toast.info(message);
          return;
        }

        if (isConflict) {
          setActiveReportConflict(true);
          return;
        }

        if (isManifestConflict) {
          if (auctioneer || reportTransferErrorData(submitError).data.canSupersede !== true || reportTransferErrorData(submitError).data.accepted !== false) {
            setError(
              "This upload was started with different media. Its acceptance has not been ruled out. Check My Reports before retrying; your current form and media have not been cleared."
            );
          } else {
            setSubmissionManifestConflict(true);
            setError(
              "The selected media changed after the previous upload attempt. Start a new upload to submit the current listing safely."
            );
          }
          reportDraftStatus("dirty", "New upload identity required");
          return;
        }

        if (!auctioneer && canSaveSeparateReportDraft(submitError)) {
          const sessionId = reportTransferErrorData(submitError).data.sessionId;
          if (typeof sessionId === "string" && sessionId.trim()) setUnavailableSessionId(sessionId);
        }
        const message = reportTransferErrorMessage(submitError, "submit");
        setError(message);
        reportDraftStatus("dirty", "Submission failed · unsaved changes");
        toast.error(message);
        return;
      }

      setSubmitting(false);
      submitLockRef.current = false;
      if (activeFormOperationRef.current === "submit") {
        activeFormOperationRef.current = null;
      }
      if (submitAbortRef.current === controller) submitAbortRef.current = null;
      setCancellingOperation(false);
      setSubmissionFinalizing(false);
    },
    [
      auctioneer,
      buildDraftEnvelope,
      draftScopeId,
      userId,
      bankPhotosEnabled,
      clearAcceptedDraft,
      contractNo,
      currency,
      dispatchReportCreated,
      language,
      latitude,
      location,
      longitude,
      mixedLots,
      onSuccess,
      onAcceptedAndContinue,
      reportDraftStatus,
      salesDate,
      watermarkImages,
      validateForm,
    ]
  );

  const totalMainPhotos = mixedLots.reduce(
    (sum, lot) => sum + lot.files.length,
    0
  );
  const totalExtraPhotos = mixedLots.reduce(
    (sum, lot) => sum + lot.extraFiles.length,
    0
  );
  const mediaSummary =
    mixedLots.length === 0
      ? "No lots added"
      : mixedLots.length +
        " " +
        (mixedLots.length === 1 ? "lot" : "lots") +
        " · " +
        (totalMainPhotos + totalExtraPhotos) +
        ((totalMainPhotos + totalExtraPhotos) === 1 ? " photo" : " photos");
  const detailsComplete =
    Boolean(contractNo.trim()) &&
    /^[A-Z]{3}$/.test(currency.trim()) &&
    hasUsableReportLocation(location);
  const locationHint = locationAttribution ? (
    <>
      {locationStatus} ·{" "}
      <a
        href={locationAttributionUrl || OPENSTREETMAP_ATTRIBUTION_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[var(--app-accent)] underline underline-offset-2"
      >
        {locationAttribution}
      </a>
    </>
  ) : (
    locationStatus
  );
  const mediaComplete =
    mixedLots.length > 0 &&
    mixedLots.every((lot) => lot.files.length > 0 && Boolean(lot.mode));
  const fieldErrorCount = [
    errors.contractNo,
    errors.currency,
    errors.location,
  ].filter(Boolean).length;

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };
  const draftSaving = draftSaveActive;
  const transferActive = draftSaving || submitting;

  const cancelActiveOperation = () => {
    const controllers = [draftSaveAbortRef.current, submitAbortRef.current].filter(
      (controller): controller is AbortController => Boolean(controller)
    );
    if (!controllers.some((controller) => !controller.signal.aborted)) return;
    setCancellingOperation(true);
    controllers.forEach((controller) => {
      if (!controller.signal.aborted) controller.abort();
    });
  };

  useEffect(() => {
    if (!draftSaving && !submitting && !separateDraftSaving) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [draftSaving, submitting, separateDraftSaving]);

  return (
    <form
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]"
      onSubmit={onSubmit}
      aria-busy={submitting || draftSaving || restoringDraft}
      noValidate
    >
      {draftSaving ? (
        <FormTransferProgressScreen
          mode="draft-save"
          percent={draftSaveProgress?.percent ?? 0}
          message={draftSaveProgress?.message ?? "Preparing your draft for secure upload…"}
          totalFiles={draftSaveProgress?.totalFiles}
          transferredFiles={draftSaveProgress?.uploadedFiles}
          totalBytes={draftSaveProgress?.totalBytes}
          transferredBytes={draftSaveProgress?.uploadedBytes}
          cancelling={cancellingOperation}
          finalizing={draftSaveProgress?.phase === "complete"}
          onCancel={cancelActiveOperation}
        />
      ) : null}
      {submitting && uploadStats ? (
        <FormTransferProgressScreen
          mode="report-upload"
          percent={uploadPercent}
          message={preparingBackgroundUpload ? "Saving the report and original media on this browser before closing the form. Keep this page open." : `Uploading ${uploadStats.totalFiles} file${
            uploadStats.totalFiles === 1 ? "" : "s"
          }`}
          totalFiles={uploadStats.totalFiles}
          totalBytes={uploadStats.totalSize}
          transferredBytes={uploadStats.uploadedBytes}
          cancelling={cancellingOperation}
          finalizing={submissionFinalizing}
          onCancel={cancelActiveOperation}
        />
      ) : null}
      {separateDraftSaving ? <p role="status" className="p-4 text-sm">Saving the separate draft and media. Keep this page open.</p> : null}
      <div
        className="contents"
        inert={transferActive || separateDraftSaving ? true : undefined}
        aria-hidden={transferActive || separateDraftSaving ? true : undefined}
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto grid w-full max-w-[920px] gap-4 sm:gap-5">
          {error ? (
            <FormAlert tone="error" title="The listing needs attention">
              {error}
            </FormAlert>
          ) : null}

          {error ? <a href="/reports" target="_blank" rel="noopener noreferrer" className="text-sm font-semibold underline">Open My Reports (new tab)</a> : null}
          {unavailableSessionId && !auctioneer ? <SeparateReportDraftRecovery userId={userId || ""} kind="lot-listing" sourceSessionId={unavailableSessionId} getSnapshot={() => {
            const { lots, ...formData } = snapshotRef.current!;
            return { formData, lots, contractNo: formData.contractNo };
          }} onBusyChange={(busy) => { activeFormOperationRef.current = busy ? "draft-save" : null; setSeparateDraftSaving(busy); }} /> : null}

          {draftSaveProgress ? (
            <DraftSaveProgressPanel progress={draftSaveProgress} />
          ) : null}

          {submitting && uploadStats ? (
            <FormAlert tone="info" title="Uploading listing media">
              <div className="mt-2 grid gap-2">
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadPercent}
                  className="h-2 overflow-hidden rounded-full bg-[var(--app-control-border)]"
                >
                  <div
                    className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-200"
                    style={{ width: uploadPercent + "%" }}
                  />
                </div>
                <p className="flex flex-wrap justify-between gap-2 text-xs">
                  <span>
                    {uploadPercent}% · {uploadStats.totalFiles} files
                  </span>
                  <span>
                    {formatFileSize(uploadStats.uploadedBytes)} of{" "}
                    {formatFileSize(uploadStats.totalSize)}
                  </span>
                </p>
              </div>
            </FormAlert>
          ) : null}

          {draftIssue ? (
            <FormAlert
              tone={draftIssue.tone}
              title={draftIssue.title}
              onDismiss={accountRestoreBlocked ? undefined : () => setDraftIssue(null)}
            >
              {draftIssue.message}
              {accountRestoreBlocked && resumeDraft?.user === userId && !restoringDraft ? (
                <button type="button" className={secondaryButtonClass + " mt-3"} onClick={() => setRestoreAttempt((value) => value + 1)}>
                  Retry loading draft
                </button>
              ) : null}
            </FormAlert>
          ) : null}

          {accountRestoreBlocked && !draftIssue ? (
            <FormAlert tone="info" title="Loading your saved draft">
              <p role="status">{userId ? `${resumeDraft?.lots.length || 0} saved lots · ${restoreProgress.completed} of ${restoreProgress.total} media files loaded` : "Waiting for your account…"}</p>
              <p>Saved details appear below. Photos download in their saved order; large drafts can take several minutes. Editing, saving and submitting stay disabled until loading finishes. Your saved draft is unchanged.</p>
              <progress aria-label="Saved media loading" value={restoreProgress.completed} max={Math.max(1, restoreProgress.total)} className="mt-2 w-full" />
            </FormAlert>
          ) : null}

          {hasDraft && showDraftBanner ? (
            <FormAlert tone="info" title="Continue your saved draft">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Restore the fields, lot modes, cover choices, annotations,
                  and locally stored photos from this account&apos;s draft.
                </span>
                <span className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void restoreDraft()}
                    disabled={restoringDraft}
                    className={secondaryButtonClass}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    {restoringDraft ? "Restoring..." : "Restore"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction("discard")}
                    className={secondaryButtonClass}
                  >
                    Discard
                  </button>
                </span>
              </div>
            </FormAlert>
          ) : null}

          <fieldset disabled={restoreBlocked} className="contents">
          <FormSection
            id="lot-listing-details"
            sectionNumber={1}
            title="Listing Details"
            description="Core settings used to identify and format the listing. Sales date and current location are captured automatically."
            open={openSections.details}
            onOpenChange={(open) =>
              setOpenSections((current) => ({ ...current, details: open }))
            }
            status={
              fieldErrorCount > 0
                ? "error"
                : detailsComplete
                  ? "complete"
                  : "incomplete"
            }
            summary={
              detailsComplete
                ? contractNo.trim() + " · " + currency.trim().toUpperCase()
                : "Contract, language, and currency"
            }
            errorSummary={
              fieldErrorCount > 0
                ? fieldErrorCount +
                  " " +
                  (fieldErrorCount === 1 ? "field needs" : "fields need") +
                  " attention"
                : undefined
            }
          >
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField
                id="lot-contract-number"
                label="Contract Number"
                required
                error={errors.contractNo}
              >
                <input
                  type="text"
                  value={contractNo}
                  readOnly={Boolean(auctioneer)}
                  aria-readonly={Boolean(auctioneer)}
                  onChange={(event) => {
                    setContractNo(event.target.value);
                    clearFieldError("contractNo");
                    markDirty();
                  }}
                  placeholder="e.g., CTR-2026-001"
                  autoComplete="off"
                  disabled={submitting}
                  className={formControlClass}
                />
              </FormField>

              <FormField id="lot-language" label="Language">
                <select
                  value={language}
                  onChange={(event) => {
                    setLanguage(
                      event.target.value as "en" | "fr" | "es"
                    );
                    markDirty();
                  }}
                  disabled={submitting}
                  className={formSelectClass}
                >
                  <option value="en">English</option>
                  <option value="fr">French</option>
                  <option value="es">Spanish</option>
                </select>
              </FormField>

              <FormField
                id="lot-currency"
                label="Currency"
                required
                hint="Use the three-letter ISO code."
                error={errors.currency}
              >
                <input
                  type="text"
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value.toUpperCase());
                    clearFieldError("currency");
                    markDirty();
                  }}
                  placeholder="CAD"
                  maxLength={3}
                  autoComplete="off"
                  disabled={submitting}
                  className={formClassNames(
                    formControlClass,
                    "uppercase"
                  )}
                />
              </FormField>

              <FormField
                id="lot-location"
                label="Current inspection location"
                required
                hint={locationHint}
                error={errors.location}
                className="sm:col-span-2"
                labelAction={
                  <button
                    type="button"
                    className="font-semibold text-[var(--app-accent)] hover:underline"
                    onClick={requestCurrentLocation}
                  >
                    Re-detect
                  </button>
                }
              >
                <input
                  type="text"
                  value={location}
                  onChange={(event) => {
                    locationRequestGenerationRef.current += 1;
                    locationLookupAbortRef.current?.abort();
                    locationLookupAbortRef.current = null;
                    setLocation(event.target.value);
                    setLatitude(null);
                    setLongitude(null);
                    setLocationAttribution(null);
                    setLocationAttributionUrl(null);
                    setLocationStatus("Manually entered inspection location");
                    clearFieldError("location");
                    markDirty();
                  }}
                  placeholder="Detecting browser location…"
                  autoComplete="off"
                  disabled={submitting}
                  className={formControlClass}
                />
              </FormField>

              <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-4 py-3">
                <FormSwitch
                  id="lot-bank-photos"
                  label="Include all photos in CR"
                  description="Include report-only photos in the condition report."
                  checked={bankPhotosEnabled}
                  onChange={(event) => {
                    setBankPhotosEnabled(event.target.checked);
                    markDirty();
                  }}
                  disabled={submitting}
                />
              </div>

              <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-4 py-3">
                <FormSwitch
                  id="lot-watermark-images"
                  label="Apply watermark"
                  description="Off by default. Enable only to add a watermark to new, unwatermarked photos."
                  checked={watermarkImages}
                  onChange={(event) => {
                    setWatermarkImages(event.target.checked);
                    markDirty();
                  }}
                  disabled={submitting}
                />
              </div>
            </div>
          </FormSection>

          <FormSection
            id="lot-listing-media"
            sectionNumber={2}
            title="Lots & Media"
            description="Create each lot, choose how its photos should be interpreted, and then add main or report-only images."
            open={openSections.media}
            onOpenChange={(open) =>
              setOpenSections((current) => ({ ...current, media: open }))
            }
            status={
              errors.media ? "error" : mediaComplete ? "complete" : "incomplete"
            }
            summary={mediaSummary}
            errorSummary={errors.media}
          >
            <div
              id="lot-media-workspace"
              tabIndex={errors.media ? -1 : undefined}
              data-invalid={errors.media ? "true" : undefined}
              aria-describedby={
                errors.media ? "lot-media-workspace-error" : undefined
              }
              className={formClassNames(
                submitting ? "pointer-events-none opacity-70" : undefined
              )}
            >
              {errors.media ? (
                <p
                  id="lot-media-workspace-error"
                  className="border-b border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--app-danger)] sm:px-5"
                  role="alert"
                >
                  {errors.media}
                </p>
              ) : null}
              <div className="mb-4 flex flex-col gap-3 rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ScanLine
                      className="h-5 w-5 shrink-0 text-[var(--app-accent)]"
                      aria-hidden="true"
                    />
                    <p className="font-bold text-[var(--app-text)]">
                      Smart Upload
                    </p>
                  </div>
                  <p className="mt-1 text-sm leading-5 text-[var(--app-text-muted)]">
                    Upload one ordered image sequence. Black images separate
                    Bundle lots and are excluded from every output.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openSmartUploadWorkspace()}
                  disabled={submitting || mixedLots.length > 0}
                  className={formClassNames(
                    secondaryButtonClass,
                    "shrink-0 justify-center"
                  )}
                  title={
                    mixedLots.length
                      ? "Clear manually created lots before using Smart Upload"
                      : undefined
                  }
                >
                  <ScanLine className="h-4 w-4" aria-hidden="true" />
                  Smart Upload
                </button>
                <button type="button" onClick={() => openSmartUploadWorkspace("lot_number")}
                  disabled={submitting || mixedLots.length > 0}
                  className={formClassNames(secondaryButtonClass, "shrink-0 justify-center")}>
                  <ScanLine className="h-4 w-4" aria-hidden="true" />
                  Lot Number Upload
                </button>
              </div>
              <MixedSection
                value={mixedLots}
                onChange={handleLotsChange}
                downloadPrefix={contractNo || "lot-listing"}
                allowVideo
                analysisImageLimit={50}
                sourceMappedLots={auctioneer?.kind === "scheduleA"}
              />
            </div>
          </FormSection>
          </fieldset>
        </div>
      </div>

      <FormActionBar className="static">
        <div className="hidden items-center gap-2 sm:flex">
          <button
            type="button"
            onClick={() => void handleSaveDraft()}
            disabled={submitting || restoreBlocked || draftSaving}
            className={secondaryButtonClass}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {draftSaving ? "Saving..." : "Save Draft"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmAction("clear")}
            disabled={submitting || restoreBlocked}
            className={secondaryButtonClass}
          >
            Clear
          </button>
        </div>

        <div className={formClassNames("grid w-full min-w-0 gap-2 sm:hidden", auctioneer && onAcceptedAndContinue ? "grid-cols-[minmax(0,1fr)_44px]" : "grid-cols-[minmax(0,1fr)_44px_minmax(0,1.25fr)]")}>
          <button
            type="button"
            onClick={() => void handleSaveDraft()}
            disabled={submitting || restoreBlocked || draftSaving}
            className={formClassNames(secondaryButtonClass, "min-w-0 px-2")}
          >
            <Save className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {draftSaving ? "Saving..." : "Save Draft"}
            </span>
          </button>
          <button
            type="button"
            aria-label="More form actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(moreAnchor)}
            onClick={(event) => setMoreAnchor(event.currentTarget)}
            disabled={submitting || restoreBlocked || draftSaving}
            className={iconButtonClass}
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
          {!(auctioneer && onAcceptedAndContinue) ? <button
            type="submit"
            disabled={submitting || restoreBlocked || draftSaving}
            className={formClassNames(primaryButtonClass, "min-w-0 px-2")}
          >
            <span className="truncate">
              {submitting ? "Uploading..." : "Create Listing"}
            </span>
          </button> : null}
        </div>

        {!(auctioneer && onAcceptedAndContinue) ? <span className="hidden sm:inline">
          <button
            type="submit"
            disabled={submitting || restoreBlocked || draftSaving}
            className={primaryButtonClass}
          >
            {submitting ? "Uploading..." : "Create Lot Listing"}
          </button>
        </span> : null}
        {auctioneer && onAcceptedAndContinue ? (
          <AuctioneerContinueAction
            disabled={submitting || restoreBlocked || draftSaving}
            onClick={() => void onSubmit(undefined, true)}
          />
        ) : null}
        </FormActionBar>
      </div>

      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={() => setMoreAnchor(null)}
        slotProps={{
          paper: {
            sx: {
              mt: 1,
              minWidth: 200,
              border: "1px solid var(--app-border)",
              borderRadius: "10px",
              bgcolor: "var(--app-panel)",
              color: "var(--app-text)",
              backgroundImage: "none",
              boxShadow: "var(--app-shadow-modal)",
            },
          },
        }}
      >
        <MenuItem
          onClick={() => {
            setMoreAnchor(null);
            setConfirmAction("clear");
          }}
          sx={{ minHeight: 44 }}
        >
          <ListItemIcon>
            <Trash2 className="h-4 w-4 text-[var(--app-danger)]" />
          </ListItemIcon>
          <ListItemText>Clear form</ListItemText>
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirmAction === "clear"}
        title="Clear this lot listing?"
        description="All fields, lots, photos, modes, covers, and annotations in this form will be removed. The saved draft will also be deleted."
        confirmLabel="Clear listing"
        tone="danger"
        onConfirm={() => void handleConfirmedAction()}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "discard"}
        title="Discard the saved draft?"
        description="The saved fields and locally stored media for this account will be removed. Legacy drafts are not changed."
        confirmLabel="Discard draft"
        tone="danger"
        onConfirm={() => void handleConfirmedAction()}
        onCancel={() => setConfirmAction(null)}
      />

      <ActiveReportConflictDialog
        open={activeReportConflict}
        reportLabel="lot listing"
        allowCreateSeparate={!auctioneer}
        onCancel={() => setActiveReportConflict(false)}
        onResume={() => {
          setActiveReportConflict(false);
          toast.info(
            "The existing report is still processing. Check My Reports for its status."
          );
        }}
        onCreateSeparate={() => {
          setActiveReportConflict(false);
          // Preserve the rejected upload identity. It may reference a
          // completed session whose placeholder lost the contract-claim race;
          // the backend can supersede and clean that session only when the
          // replacement explicitly carries this alias.
          supersededSubmissionIdRef.current = jobIdRef.current;
          jobIdRef.current =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : "ll-" +
                Date.now() +
                "-" +
                Math.random().toString(36).slice(2, 9);
          forceNewSubmissionRef.current = true;
          window.setTimeout(() => void onSubmit(), 0);
        }}
      />

      <ConfirmDialog
        open={submissionManifestConflict && !auctioneer}
        title="Start a new upload?"
        description="The photos changed after the previous upload was stopped, so that upload identity cannot be reused safely. Start a new upload with the current listing and media, or keep editing without submitting."
        confirmLabel="Start new upload"
        cancelLabel="Keep editing"
        onCancel={() => setSubmissionManifestConflict(false)}
        onConfirm={() => {
          setSubmissionManifestConflict(false);
          setError(null);
          supersededSubmissionIdRef.current = jobIdRef.current;
          jobIdRef.current =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : "ll-" +
                Date.now() +
                "-" +
                Math.random().toString(36).slice(2, 9);
          forceNewSubmissionRef.current = false;
          window.setTimeout(() => void onSubmit(), 0);
        }}
      />

      <DuplicateDraftDialog
        open={Boolean(duplicateDraftMessage) && !transferActive}
        message={duplicateDraftMessage || "A matching draft already exists."}
        onClose={() => setDuplicateDraftMessage(null)}
        onCheckDraft={() => {
          setDuplicateDraftMessage(null);
          router.push("/previews?tab=drafts");
        }}
      />

      <SmartUploadWorkspace
        groupingMethod={smartGroupingMethod}
        open={smartUploadOpen}
        kind="lot-listing"
        userId={userId || ""}
        scopeId={draftScopeId}
        clientSubmissionId={draftScopeId}
        resumeSessionId={resumeDraft?.smartUploadSession}
        details={smartUploadDetails}
        onClose={() => setSmartUploadOpen(false)}
        onSubmitted={() => handleSmartUploadSubmitted()}
      />
    </form>
  );
}
