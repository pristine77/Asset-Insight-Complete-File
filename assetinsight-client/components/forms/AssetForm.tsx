"use client";
import { useReportActivity } from "./drafts/useReportActivity";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Menu, MenuItem } from "@/components/ui/legacy";
import { MoreHorizontal, Save, ScanLine } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  AssetService,
  type AssetCreateDetails,
} from "@/services/asset";
import {
  SavedInputService,
  type AssetFormData,
  type DraftFileMetadata,
  type SavedInput,
  getDraftFileMetadata,
} from "@/services/savedInputs";
import {
  ReportDraftService,
  createReportDraftClientId,
  getDuplicateLotWarning,
  getReportDraftDeviceId,
  type ReportDraftRecord,
  type ReportDraftSaveProgress,
} from "@/services/reportDrafts";
import { useAuthContext } from "@/context/AuthContext";
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
import ActiveReportConflictDialog from "./ActiveReportConflictDialog";
import DuplicateDraftDialog from "./DuplicateDraftDialog";
import { saveManualDraftOnly } from "./manualDraftSave";
import AuctioneerContinueAction from "./AuctioneerContinueAction";
import { acceptedAuctioneerReportId } from "./auctioneerContinuation";
import { assertReportUploadAccepted, canSaveSeparateReportDraft, isPreviousReportReceipt, reportTransferErrorData, reportTransferErrorMessage, safeReportOperationError } from "@/services/reportTransferErrors";
import { backgroundUploads } from "@/services/backgroundUploadManager";
import { describeOrderedFiles } from "@/services/uploadJobFiles";
import { captureAuthSession, assertAuthSessionCurrent, isAuthSessionCurrent } from "@/lib/auth-storage";
import { isUploadReviewScope, type UploadReviewIdentity } from "@/services/uploadReviewNavigation";
import SeparateReportDraftRecovery from "./SeparateReportDraftRecovery";
import {
  auctioneerDateOnly,
  auctioneerDraftScope,
  auctioneerIndustry,
  buildAuctioneerSeedLots,
  type AuctioneerFormIntegration,
} from "./auctioneerSeed";
import {
  getMixedFileKey,
  type MixedLot,
} from "./mixed/types";
import { buildMixedFocusBoxes } from "./mixed/focusBoxes";
import {
  FORM_DRAFT_VERSION,
  deleteScopedDraft,
  getScopedDraftKey,
  loadScopedDraft,
  parseScopedDraftEnvelope,
  requestDurableDraftStorage,
  saveScopedDraft,
} from "./drafts/storage";
import { deleteSmartUploadDraft } from "./smartUpload/storage";
import {
  ConfirmDialog,
  FormActionBar,
  FormAlert,
  DraftSaveProgressPanel,
  FormTransferProgressScreen,
  FormField,
  FormSection,
  FormSwitch,
  formClassNames,
  formControlClass,
  formSelectClass,
  formTextareaClass,
  iconButtonClass,
  primaryButtonClass,
  quietButtonClass,
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

type Props = {
  onSuccess?: (message?: string) => void;
  onAcceptedAndContinue?: (reportId: string | undefined, details?: AssetContinuationDetails) => void;
  continuationDetails?: Partial<AssetContinuationDetails>;
  onCancel?: () => void;
  onDraftStatusChange?: (status: DraftStatus, label?: string) => void;
  auctioneer?: AuctioneerFormIntegration;
  resumeDraft?: ReportDraftRecord | null;
  restoreDraftOnMount?: boolean;
  resumeLocalDraftScopeId?: string;
  initialSavedInput?: SavedInput | null;
};

export type AssetFormHandle = {
  loadSavedInput: (savedInput: SavedInput) => void;
};

type SectionId = "report" | "factors" | "comparison" | "media";
type ValuationMethod = "FML" | "TKV" | "OLV" | "FLV";

type FileDescriptor = {
  clientFileId?: string;
  name: string;
  size: number;
  mimeType: string;
  lastModified: number;
};

type DraftMediaType = "main" | "extra" | "video";

type DraftMediaLocation = DraftFileMetadata & {
  lotId: string;
  type: DraftMediaType;
  index: number;
};

type SerializedLot = {
  id: string;
  coverIndex: number;
  mode?: "single_lot" | "per_item" | "per_photo";
  mainFiles: FileDescriptor[];
  extraFiles: FileDescriptor[];
  videoFiles: FileDescriptor[];
  annotations?: MixedLot["annotations"];
};

type LocalDraftMedia = FileDescriptor & {
  lotId: string;
  type: "main" | "extra" | "video";
  dataUrl: string;
};

type AssetDraftFormData = UploadReviewIdentity & {
  clientSubmissionId: string;
  auctioneerWorkItemId?: string;
  clientName: string;
  effectiveDate: string;
  appraisalPurpose: string;
  ownerName: string;
  appraiser: string;
  appraisalCompany: string;
  industry: string;
  inspectionDate: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  contractNo: string;
  language: "en" | "fr" | "es";
  currency: string;
  includeValuationTable: boolean;
  selectedValuationMethods: ValuationMethod[];
  includeDamageAnalysis: boolean;
  bankPhotosEnabled: boolean;
  watermarkImages: boolean;
  preparedFor: string;
  factorsAgeCondition: string;
  factorsQuality: string;
  factorsAnalysis: string;
};

export type AssetContinuationDetails = Omit<AssetDraftFormData, "clientSubmissionId" | "auctioneerWorkItemId">;

type LegacyAssetDraftEnvelope = {
  version: 2;
  kind: "asset";
  userId: string;
  revision: number;
  savedAt: string;
  deviceId: string;
  formData: AssetDraftFormData;
  lots: SerializedLot[];
  media: LocalDraftMedia[];
};

type AssetDraftEnvelope = {
  version: typeof FORM_DRAFT_VERSION;
  kind: "asset";
  userId: string;
  revision: number;
  savedAt: string;
  deviceId: string;
  formData: AssetDraftFormData;
  lots: MixedLot[];
  mediaMetadata?: DraftMediaLocation[];
};

type DraftSnapshot = {
  revision: number;
  formData: AssetDraftFormData;
  lots: MixedLot[];
  serializedLots: SerializedLot[];
};

const MAX_ASSET_LOT_PHOTOS = 200;
const DEVICE_ID_KEY = "cv_device_id";

/** Marks an acceptance that belongs to an earlier submission, not this one. */
const PREVIOUS_RECEIPT_CODE = "PREVIOUS_REPORT_RECEIPT";

/**
 * Whether a failed background upload needs a decision only this form can offer.
 * Each of these has a prompt here — the active-report conflict dialog, the
 * changed-manifest supersede choice, separate-draft recovery, and the earlier
 * receipt warning — so the draft is sent back for an inline Submit rather than
 * being retried from the upload bar, where the answer cannot be given.
 */
function assetSubmissionNeedsForm(error: unknown): boolean {
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

const isoDate = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const describeFile = (file: File): FileDescriptor => ({
  ...getDraftFileMetadata(file),
  name: file.name,
  size: file.size,
  mimeType: file.type,
  lastModified: file.lastModified || 0,
});

const getLotFileBucket = (lot: MixedLot, type: DraftMediaType) => {
  if (type === "main") return lot.files;
  if (type === "extra") return lot.extraFiles;
  return lot.videoFiles || [];
};

const listDraftMediaLocations = (
  lots: MixedLot[]
): DraftMediaLocation[] =>
  lots.flatMap((lot) =>
    (["main", "extra", "video"] as const).flatMap((type) =>
      getLotFileBucket(lot, type).map((file, index) => ({
        ...getDraftFileMetadata(file),
        lotId: lot.id,
        type,
        index,
      }))
    )
  );

const applyDraftMediaLocations = (
  lots: MixedLot[],
  locations: DraftMediaLocation[] = []
) => {
  const byLocation = new Map(
    locations.map((item) => [
      JSON.stringify([item.lotId, item.type, item.index]),
      item,
    ])
  );
  for (const lot of lots) {
    for (const type of ["main", "extra", "video"] as const) {
      getLotFileBucket(lot, type).forEach((file, index) => {
        const persisted = byLocation.get(
          JSON.stringify([lot.id, type, index])
        );
        if (persisted) getDraftFileMetadata(file, persisted);
      });
    }
  }
};

const getDeviceId = () => {
  if (typeof window === "undefined") return "";
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
};

const dataUrlToFile = async (media: LocalDraftMedia) => {
  const response = await fetch(media.dataUrl);
  const blob = await response.blob();
  return new File([blob], media.name, {
    type: media.mimeType || blob.type,
    lastModified: media.lastModified,
  });
};

const valuationOptions: Array<{
  value: ValuationMethod;
  label: string;
  description: string;
}> = [
  {
    value: "FML",
    label: "FML · Fair Market Value",
    description: "Retail value for insurance or estate purposes.",
  },
  {
    value: "TKV",
    label: "TKV · Trade Value",
    description: "Dealer trade-in value for wholesale transactions.",
  },
  {
    value: "OLV",
    label: "OLV · Orderly Liquidation",
    description: "Auction value with reasonable marketing time.",
  },
  {
    value: "FLV",
    label: "FLV · Forced Liquidation",
    description: "Quick-sale value under immediate liquidation pressure.",
  },
];

const AssetForm = forwardRef<AssetFormHandle, Props>(function AssetForm(
  {
    onSuccess,
    onAcceptedAndContinue,
    continuationDetails,
    onCancel,
    onDraftStatusChange,
    auctioneer,
    resumeDraft = null,
    restoreDraftOnMount = false,
    resumeLocalDraftScopeId,
    initialSavedInput = null,
  },
  ref
) {
  const router = useRouter();
  const { user } = useAuthContext();
  const userId = user?._id || "";
  const draftClientIdRef = useRef(
    resumeDraft?.clientDraftId ||
      resumeLocalDraftScopeId ||
      (restoreDraftOnMount ? auctioneerDraftScope(auctioneer) : "") ||
      auctioneer?.clientSubmissionId ||
      (auctioneer
        ? `auctioneer-${auctioneer.workItemId}`
        : createReportDraftClientId("asset"))
  );
  const draftScopeId = draftClientIdRef.current;
  const [unavailableSessionId, setUnavailableSessionId] = useState<string | null>(null);
  const [separateDraftSaving, setSeparateDraftSaving] = useState(false);
  const draftStorageKey =
    getScopedDraftKey(userId, "asset", draftScopeId) || "";
  const importedEventDate =
    auctioneerDateOnly(auctioneer?.contract.eventDate) || isoDate(new Date());
  const importedLocation =
    auctioneer?.contract.location || "";

  const [clientName, setClientName] = useState(continuationDetails?.clientName ?? (auctioneer?.contract.customerName || ""));
  const [effectiveDate, setEffectiveDate] = useState(continuationDetails?.effectiveDate ?? (importedEventDate));
  const [appraisalPurpose, setAppraisalPurpose] = useState(continuationDetails?.appraisalPurpose ?? ((auctioneer ? "Auction listing and condition report" : "")));
  const [ownerName, setOwnerName] = useState(continuationDetails?.ownerName ?? (auctioneer?.contract.customerName || ""));
  const [preparedFor, setPreparedFor] = useState(continuationDetails?.preparedFor ?? (auctioneer?.contract.customerName || ""));
  const [appraiser, setAppraiser] = useState(continuationDetails?.appraiser ?? (user?.username || ""));
  const [appraisalCompany, setAppraisalCompany] = useState(continuationDetails?.appraisalCompany ?? (user?.companyName || ""));
  const [industry, setIndustry] = useState(continuationDetails?.industry ?? (auctioneerIndustry(auctioneer)));
  const [inspectionDate, setInspectionDate] = useState(continuationDetails?.inspectionDate ?? (isoDate(new Date())));
  const [location, setLocation] = useState(continuationDetails?.location ?? (importedLocation));
  const [latitude, setLatitude] = useState<number | null>(continuationDetails?.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(continuationDetails?.longitude ?? null);
  const [locationStatus, setLocationStatus] = useState(
    auctioneer ? "Imported from Auctioneer" : "Detecting current location…"
  );
  const [locationAttribution, setLocationAttribution] = useState<string | null>(
    null
  );
  const [locationAttributionUrl, setLocationAttributionUrl] = useState<
    string | null
  >(null);
  const [contractNo, setContractNo] = useState(continuationDetails?.contractNo ?? (auctioneer?.contract.contractNo || ""));
  const [language, setLanguage] = useState<"en" | "fr" | "es">(continuationDetails?.language ?? "en");
  const [currency, setCurrency] = useState(continuationDetails?.currency ?? ((auctioneer ? "CAD" : "")));
  const [currencyTouched, setCurrencyTouched] = useState(Boolean(auctioneer));
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const [includeDamageAnalysis, setIncludeDamageAnalysis] = useState(continuationDetails?.includeDamageAnalysis ?? (true));
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(continuationDetails?.bankPhotosEnabled ?? (false));
  const [watermarkImages, setWatermarkImages] = useState(continuationDetails?.watermarkImages ?? (false));
  const [factorsAgeCondition, setFactorsAgeCondition] = useState(continuationDetails?.factorsAgeCondition ?? (""));
  const [factorsQuality, setFactorsQuality] = useState(continuationDetails?.factorsQuality ?? (""));
  const [factorsAnalysis, setFactorsAnalysis] = useState(continuationDetails?.factorsAnalysis ?? (""));
  const [includeValuationTable, setIncludeValuationTable] = useState(continuationDetails?.includeValuationTable ?? (false));
  const [selectedValuationMethods, setSelectedValuationMethods] = useState<
    ValuationMethod[]
  >(continuationDetails?.selectedValuationMethods ?? (["FML"]));
  const [mixedLots, setMixedLots] = useState<MixedLot[]>(() =>
    buildAuctioneerSeedLots(auctioneer)
  );


  const [openSections, setOpenSections] = useState<Set<SectionId>>(
    () => new Set(["report", "media"])
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [draftGuidance, setDraftGuidance] = useState<{
    tone: "warning" | "error";
    message: string;
  } | null>(null);
  const [draftSaveProgress, setDraftSaveProgress] =
    useState<ReportDraftSaveProgress | null>(null);
  const [draftSaveActive, setDraftSaveActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionFinalizing, setSubmissionFinalizing] = useState(false);
  const submitLockRef = useRef(false);
  const activeFormOperationRef = useRef<"draft-save" | "submit" | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [preparingBackgroundUpload, setPreparingBackgroundUpload] = useState(false);
  const [uploadStats, setUploadStats] = useState<{
    totalFiles: number;
    totalSize: number;
    uploadedBytes: number;
    startTime: number;
  } | null>(null);
  const [acceptedMessage, setAcceptedMessage] = useState<string | null>(null);
  const [activeReportConflict, setActiveReportConflict] = useState(false);
  const [submissionManifestConflict, setSubmissionManifestConflict] =
    useState(false);
  const [duplicateDraftMessage, setDuplicateDraftMessage] = useState<
    string | null
  >(null);
  const [smartUploadOpen, setSmartUploadOpen] = useState(false);
  const [smartGroupingMethod, setSmartGroupingMethod] = useState<"black_divider" | "lot_number">("black_divider");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoringAccountDraft, setRestoringAccountDraft] = useState(false);
  const [restoredAccountKey, setRestoredAccountKey] = useState<string | null>(null);
  const accountRestoreKey = resumeDraft ? `${userId}:${resumeDraft._id}:${resumeDraft.revision}` : null;
  const restoreBlocked = Boolean(resumeDraft || restoreDraftOnMount) &&
    (!draftHydrated || Boolean(resumeDraft && restoredAccountKey !== accountRestoreKey));
  const restoreBlockedRef = useRef(restoreBlocked);
  restoreBlockedRef.current = restoreBlocked;
  useReportActivity(userId, draftScopeId, "asset", contractNo, mixedLots, watermarkImages, draftHydrated && !restoreBlocked);

  const currencyPromptedRef = useRef(false);
  const jobIdRef = useRef<string | null>(
    draftClientIdRef.current
  );
  const supersededSubmissionIdRef = useRef<string | null>(null);
  const forceNewSubmissionRef = useRef(false);
  const submissionActivityIdRef = useRef<string | undefined>(undefined);
  const createdEventDispatchedRef = useRef(false);
  const autoSaveBlockedRef = useRef(false);
  const draftProgressClearTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRevisionRef = useRef(0);
  const committedRevisionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const lastFingerprintRef = useRef<string | null>(null);
  const accountSyncPendingRef = useRef(false);
  const draftSaveAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const locationRequestGenerationRef = useRef(0);
  const locationLookupAbortRef = useRef<AbortController | null>(null);
  const restoredLocationMigrationDirtyRef = useRef(false);
  const [cancellingOperation, setCancellingOperation] = useState(false);
  const draftStatusCallbackRef = useRef(onDraftStatusChange);
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
    draftStatusCallbackRef.current = onDraftStatusChange;
  }, [onDraftStatusChange]);

  const publishDraftStatus = (status: DraftStatus, label?: string) => {
    draftStatusCallbackRef.current?.(status, label);
  };

  const trackDraftSaveProgress = (progress: ReportDraftSaveProgress) => {
    if (draftProgressClearTimerRef.current) {
      clearTimeout(draftProgressClearTimerRef.current);
      draftProgressClearTimerRef.current = null;
    }
    setDraftSaveProgress(progress);
  };

  useEffect(
    () => () => {
      if (draftProgressClearTimerRef.current) {
        clearTimeout(draftProgressClearTimerRef.current);
      }
    },
    []
  );

  const clearFieldError = (key: string) => {
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const toggleSection = (section: SectionId, open: boolean) => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (open) next.add(section);
      else next.delete(section);
      return next;
    });
  };

  const ensureJobId = () => {
    if (!jobIdRef.current) {
      jobIdRef.current =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    return jobIdRef.current;
  };

  const currentFormData: AssetDraftFormData = {
    clientSubmissionId: jobIdRef.current || "",
    submissionActivityId: submissionActivityIdRef.current,
    forceNewSubmission: forceNewSubmissionRef.current,
    supersededSubmissionId: supersededSubmissionIdRef.current || undefined,
    ...(auctioneer ? { auctioneerWorkItemId: auctioneer.workItemId } : {}),
    clientName,
    effectiveDate,
    appraisalPurpose,
    ownerName,
    appraiser,
    appraisalCompany,
    industry,
    inspectionDate,
    location,
    latitude,
    longitude,
    contractNo,
    language,
    currency,
    includeValuationTable,
    selectedValuationMethods,
    includeDamageAnalysis,
    bankPhotosEnabled,
    watermarkImages,
    preparedFor,
    factorsAgeCondition,
    factorsQuality,
    factorsAnalysis,
  };

  const locationStateRef = useRef({ location, latitude, longitude });
  locationStateRef.current = { location, latitude, longitude };
  const currencyTouchedRef = useRef(currencyTouched);
  currencyTouchedRef.current = currencyTouched;

  const formStateRef = useRef<{ formData: AssetDraftFormData; lots: MixedLot[] }>({
    formData: currentFormData,
    lots: mixedLots,
  });
  formStateRef.current = { formData: currentFormData, lots: mixedLots };

  const draftFingerprint = useMemo(
    () =>
      JSON.stringify({
        ...currentFormData,
        lots: mixedLots.map((lot) => ({
          id: lot.id,
          mode: lot.mode,
          coverIndex: lot.coverIndex,
          files: lot.files.map(getMixedFileKey),
          extraFiles: lot.extraFiles.map(getMixedFileKey),
          videoFiles: (lot.videoFiles || []).map(getMixedFileKey),
          annotations: lot.annotations || {},
        })),
      }),
    [
      clientName,
      effectiveDate,
      appraisalPurpose,
      ownerName,
      appraiser,
      appraisalCompany,
      industry,
      inspectionDate,
      location,
      latitude,
      longitude,
      contractNo,
      language,
      currency,
      includeValuationTable,
      selectedValuationMethods,
      includeDamageAnalysis,
      bankPhotosEnabled,
      watermarkImages,
      preparedFor,
      factorsAgeCondition,
      factorsQuality,
      factorsAnalysis,
      mixedLots,
    ]
  );

  const makeSnapshot = (revision: number): DraftSnapshot => {
    const state = formStateRef.current;
    const lots = state.lots.map((lot) => ({
      ...lot,
      files: [...lot.files],
      extraFiles: [...lot.extraFiles],
      videoFiles: [...(lot.videoFiles || [])],
      annotations: lot.annotations ? { ...lot.annotations } : undefined,
    }));
    return {
      revision,
      formData: {
        ...state.formData,
        clientSubmissionId:
          state.formData.clientSubmissionId || ensureJobId(),
        selectedValuationMethods: [...state.formData.selectedValuationMethods],
      },
      lots,
      serializedLots: lots.map((lot) => ({
        id: lot.id,
        coverIndex: lot.coverIndex,
        mode: lot.mode,
        mainFiles: lot.files.map(describeFile),
        extraFiles: lot.extraFiles.map(describeFile),
        videoFiles: (lot.videoFiles || []).map(describeFile),
        annotations: lot.annotations ? { ...lot.annotations } : undefined,
      })),
    };
  };

  const saveServerTier = async (
    snapshot: DraftSnapshot,
    signal?: AbortSignal
  ) => {
    // Saved means Mongo has the lot structure and every media object is
    // confirmed in R2. Stable file IDs avoid re-uploading unchanged photos.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await ReportDraftService.upsertWithMedia(
          {
            clientDraftId: draftScopeId,
            kind: "asset",
            revision: snapshot.revision,
            deviceId: getReportDraftDeviceId(),
            contractNo: snapshot.formData.contractNo,
            title:
              snapshot.formData.clientName ||
              snapshot.formData.contractNo ||
              "Asset report draft",
            formData: snapshot.formData,
          },
          snapshot.lots,
          (_progress, message, details) => {
            trackDraftSaveProgress(details);
            if (snapshot.revision === saveRevisionRef.current) {
              publishDraftStatus("saving", message);
            }
          },
          signal
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError;
  };

  const saveRevision = async (revision: number, signal?: AbortSignal) => {
    if (restoreBlockedRef.current) return;
    if (autoSaveBlockedRef.current || !userId) return;
    const snapshot = makeSnapshot(revision);
    publishDraftStatus("saving", "Saving draft…");
    try {
      const savedDraft = await saveServerTier(snapshot, signal);
      const duplicateWarning = getDuplicateLotWarning(savedDraft);
      syncDuplicateDraftDialog(duplicateWarning);
      accountSyncPendingRef.current = false;
      committedRevisionRef.current = Math.max(
        committedRevisionRef.current,
        revision
      );

      // Remove obsolete browser media only after the portable R2 revision is
      // complete. Cleanup failure cannot invalidate the verified cloud draft.
      await deleteScopedDraft(userId, "asset", draftScopeId).catch(
        () => undefined
      );
      if (draftStorageKey) localStorage.removeItem(draftStorageKey);

      if (revision !== saveRevisionRef.current || autoSaveBlockedRef.current) {
        return;
      }

      setDraftGuidance(
        duplicateWarning ? { tone: "warning", message: duplicateWarning } : null
      );
      publishDraftStatus(
        "saved",
        duplicateWarning
          ? "Draft saved - duplicate lot number needs attention"
          : "Draft and photos saved to your account"
      );
    } catch (error) {
      if (signal?.aborted) {
        accountSyncPendingRef.current = false;
        setDraftSaveProgress(null);
        setDraftGuidance({
          tone: "warning",
          message:
            "Draft saving was cancelled. Your form and selected media are still open, but these changes are not safely stored yet.",
        });
        publishDraftStatus("dirty", "Save cancelled · unsaved changes");
        toast.info("Draft save cancelled. Your unsaved form is still open.");
        return;
      }
      accountSyncPendingRef.current = true;
      if (revision !== saveRevisionRef.current || autoSaveBlockedRef.current) {
        return;
      }
      const duplicateWarning = getDuplicateLotWarning(error);
      syncDuplicateDraftDialog(duplicateWarning);
      const message =
        duplicateWarning ||
        reportTransferErrorMessage(error, "save");
      setDraftSaveProgress(null);
      setDraftGuidance({ tone: duplicateWarning ? "warning" : "error", message });
      publishDraftStatus("error", "Draft not saved");
    }
  };

  const requestDraftSave = (revision: number, signal?: AbortSignal) => {
    if (autoSaveBlockedRef.current || !userId) return Promise.resolve();
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const promise = saveRevision(revision, signal).finally(() => {
      saveInFlightRef.current = null;
    });
    saveInFlightRef.current = promise;
    return promise;
  };

  const saveDraftNow = async () => {
    if (
      restoreBlockedRef.current ||
      activeFormOperationRef.current ||
      submitting ||
      !userId ||
      draftSaveAbortRef.current ||
      saveInFlightRef.current
    ) {
      return;
    }
    activeFormOperationRef.current = "draft-save";
    const revision = Math.max(saveRevisionRef.current + 1, 1);
    saveRevisionRef.current = revision;
    publishDraftStatus("dirty", "Unsaved changes");
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
      await saveManualDraftOnly(
        async () => {
          await requestDraftSave(revision, controller.signal);
          return (
            !controller.signal.aborted &&
            committedRevisionRef.current >= saveRevisionRef.current
          );
        },
        () => {
          publishDraftStatus("saved", "Draft and photos saved to your account");
          toast.success("Draft and photos saved.");
        }
      );
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
  };

  useEffect(() => {
    if (!draftHydrated || restoreBlocked || autoSaveBlockedRef.current || !userId) return;
    if (lastFingerprintRef.current === null) {
      lastFingerprintRef.current = draftFingerprint;
      return;
    }
    if (lastFingerprintRef.current === draftFingerprint) return;
    lastFingerprintRef.current = draftFingerprint;
    const revision = saveRevisionRef.current + 1;
    saveRevisionRef.current = revision;
    publishDraftStatus("dirty", "Unsaved changes");
  }, [draftFingerprint, draftHydrated, restoreBlocked, userId]);

  const restoreFormFields = (formData: Partial<AssetDraftFormData>) => {
    submissionActivityIdRef.current = formData.submissionActivityId;
    forceNewSubmissionRef.current = formData.forceNewSubmission === true;
    supersededSubmissionIdRef.current = formData.supersededSubmissionId || null;
    if (typeof formData.clientSubmissionId === "string" && formData.clientSubmissionId) {
      jobIdRef.current = formData.clientSubmissionId;
    }
    if (typeof formData.clientName === "string") setClientName(formData.clientName);
    if (typeof formData.effectiveDate === "string") setEffectiveDate(formData.effectiveDate);
    if (typeof formData.appraisalPurpose === "string") setAppraisalPurpose(formData.appraisalPurpose);
    if (typeof formData.ownerName === "string") setOwnerName(formData.ownerName);
    if (typeof formData.appraiser === "string") setAppraiser(formData.appraiser);
    if (typeof formData.appraisalCompany === "string") setAppraisalCompany(formData.appraisalCompany);
    if (typeof formData.industry === "string") setIndustry(formData.industry);
    if (typeof formData.inspectionDate === "string") setInspectionDate(formData.inspectionDate);
    const explicitCoordinates = isValidBrowserCoordinates(
      formData.latitude,
      formData.longitude
    )
      ? {
          latitude: Number(formData.latitude),
          longitude: Number(formData.longitude),
        }
      : null;
    const legacyCoordinates = parseBrowserCoordinateLocation(formData.location);
    const storedCoordinates = explicitCoordinates || legacyCoordinates;
    const hasStoredLocation = hasUsableReportLocation(formData.location);
    if (storedCoordinates || hasStoredLocation) {
      const requestGeneration = ++locationRequestGenerationRef.current;
      locationLookupAbortRef.current?.abort();
      locationLookupAbortRef.current = null;

      if (hasStoredLocation) {
        setLocation(String(formData.location).trim());
        setLatitude(storedCoordinates?.latitude ?? null);
        setLongitude(storedCoordinates?.longitude ?? null);
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
      } else if (storedCoordinates) {
        setLocation("");
        setLatitude(storedCoordinates.latitude);
        setLongitude(storedCoordinates.longitude);
        setLocationAttribution(null);
        setLocationAttributionUrl(null);
        setLocationStatus("Finding a readable name for the saved location…");
        void resolveCoordinatesToLocation({
          coordinates: storedCoordinates,
          requestGeneration,
          restored: true,
        });
      }
    } else if (
      typeof formData.location === "string" &&
      formData.location.trim()
    ) {
      locationRequestGenerationRef.current += 1;
      locationLookupAbortRef.current?.abort();
      locationLookupAbortRef.current = null;
      setLocation("");
      setLatitude(null);
      setLongitude(null);
      setLocationAttribution(null);
      setLocationAttributionUrl(null);
      setLocationStatus(
        "The saved location needs a readable name. Re-detect it or enter it manually."
      );
    }
    if (typeof formData.contractNo === "string") setContractNo(formData.contractNo);
    if (formData.language === "en" || formData.language === "fr" || formData.language === "es") {
      setLanguage(formData.language);
    }
    if (typeof formData.currency === "string") {
      setCurrency(formData.currency);
      if (formData.currency.trim()) {
        setCurrencyTouched(true);
        currencyTouchedRef.current = true;
      }
    }
    if (typeof formData.includeValuationTable === "boolean") {
      setIncludeValuationTable(formData.includeValuationTable);
    }
    if (Array.isArray(formData.selectedValuationMethods)) {
      setSelectedValuationMethods(formData.selectedValuationMethods);
    }
    if (typeof formData.includeDamageAnalysis === "boolean") {
      setIncludeDamageAnalysis(formData.includeDamageAnalysis);
    }
    if (typeof formData.bankPhotosEnabled === "boolean") {
      setBankPhotosEnabled(formData.bankPhotosEnabled);
    }
    setWatermarkImages(formData.watermarkImages === true);
    if (typeof formData.preparedFor === "string") setPreparedFor(formData.preparedFor);
    if (typeof formData.factorsAgeCondition === "string") setFactorsAgeCondition(formData.factorsAgeCondition);
    if (typeof formData.factorsQuality === "string") setFactorsQuality(formData.factorsQuality);
    if (typeof formData.factorsAnalysis === "string") setFactorsAnalysis(formData.factorsAnalysis);
  };

  const restoreLocalDraft = async (): Promise<boolean> => {
    if (!draftStorageKey) return false;
    await requestDurableDraftStorage();
    let envelope: AssetDraftEnvelope | null = null;
    let missingMediaCount = 0;
    const durable = await loadScopedDraft<AssetDraftEnvelope>(
      userId,
      "asset",
      draftScopeId
    );

    if (durable) {
      envelope = durable.envelope;
      missingMediaCount = durable.missingMediaCount;
    } else {
      const raw = localStorage.getItem(draftStorageKey);
      if (!raw) return false;
      let legacy: LegacyAssetDraftEnvelope;
      try {
        legacy = parseScopedDraftEnvelope<LegacyAssetDraftEnvelope>(raw, {
          userId,
          kind: "asset",
        });
      } catch {
        setDraftGuidance({
          tone: "error",
          message:
            "The local draft is corrupted and was not loaded. A server copy will be tried if available.",
        });
        publishDraftStatus("error", "Local draft is corrupted");
        return false;
      }

      const restoredLots: MixedLot[] = [];
      for (const lotMeta of legacy.lots || []) {
        const restoreBucket = async (type: LocalDraftMedia["type"]) => {
          const files: File[] = [];
          for (const media of (legacy.media || []).filter(
            (item) => item.lotId === lotMeta.id && item.type === type
          )) {
            try {
              files.push(await dataUrlToFile(media));
            } catch {
              missingMediaCount += 1;
            }
          }
          return files;
        };
        restoredLots.push({
          id: lotMeta.id,
          files: await restoreBucket("main"),
          extraFiles: await restoreBucket("extra"),
          videoFiles: await restoreBucket("video"),
          coverIndex: lotMeta.coverIndex || 0,
          mode: lotMeta.mode,
          annotations: lotMeta.annotations || {},
        });
      }

      envelope = {
        version: FORM_DRAFT_VERSION,
        kind: "asset",
        userId,
        revision: legacy.revision || 0,
        savedAt: legacy.savedAt || new Date().toISOString(),
        deviceId: legacy.deviceId || getDeviceId(),
        formData: legacy.formData,
        lots: restoredLots,
        mediaMetadata: listDraftMediaLocations(restoredLots),
      };

      // A complete v2 draft is removed only after v3 can be written and read
      // back with every media object intact.
      if (missingMediaCount === 0) {
        await saveScopedDraft(envelope, draftScopeId);
        const verified = await loadScopedDraft<AssetDraftEnvelope>(
          userId,
          "asset",
          draftScopeId
        );
        if (!verified || verified.missingMediaCount > 0) {
          throw new Error("The migrated asset draft could not be verified.");
        }
        envelope = verified.envelope;
        localStorage.removeItem(draftStorageKey);
      }
    }

    const restoredLots = Array.isArray(envelope.lots) ? envelope.lots : [];
    applyDraftMediaLocations(restoredLots, envelope.mediaMetadata);
    envelope.mediaMetadata = listDraftMediaLocations(restoredLots);
    saveRevisionRef.current = envelope.revision || 0;
    committedRevisionRef.current = envelope.revision || 0;
    restoredLocationMigrationDirtyRef.current = false;
    restoreFormFields(envelope.formData || {});
    setMixedLots(restoredLots);
    if (missingMediaCount) {
      setDraftGuidance({
        tone: "warning",
        message: `${missingMediaCount} media file${
          missingMediaCount === 1 ? "" : "s"
        } could not be restored. All available fields and media were retained.`,
      });
      publishDraftStatus("partial", "Draft restored with missing media");
    } else if (restoredLocationMigrationDirtyRef.current) {
      publishDraftStatus("dirty", "Location updated · save again");
    } else {
      publishDraftStatus("saved", "Draft restored");
    }
    return true;
  };

  const restoreAccountDraft = async (record: ReportDraftRecord, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    if (record.user !== userId || record.type !== "asset" || record._id !== resumeDraft?._id || record.clientDraftId !== resumeDraft?.clientDraftId) {
      throw new Error("Return to Drafts and open a draft belonging to the signed-in account.");
    }
    const formData = record.formData || {};
    const value = (...keys: string[]) => {
      for (const key of keys) {
        const candidate = formData[key];
        if (candidate !== undefined && candidate !== null) return candidate;
      }
      return undefined;
    };
    const textValue = (...keys: string[]) => {
      const candidate = value(...keys);
      return typeof candidate === "string" ? candidate : undefined;
    };
    const booleanValue = (...keys: string[]) => {
      const candidate = value(...keys);
      return typeof candidate === "boolean" ? candidate : undefined;
    };
    const numberValue = (...keys: string[]) => {
      const candidate = value(...keys);
      return typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : null;
    };
    const selectedMethods = value(
      "selectedValuationMethods",
      "valuation_methods"
    );
    const normalizedMethods = Array.isArray(selectedMethods)
      ? selectedMethods.filter(
          (method): method is ValuationMethod =>
            method === "FML" ||
            method === "TKV" ||
            method === "OLV" ||
            method === "FLV"
        )
      : undefined;
    const languageValue = value("language");
    const normalizedLanguage =
      languageValue === "fr" || languageValue === "es"
        ? languageValue
        : "en";

    saveRevisionRef.current = record.revision || 0;
    committedRevisionRef.current = record.revision || 0;
    restoredLocationMigrationDirtyRef.current = false;
    restoreFormFields({
      clientSubmissionId: record.clientDraftId,
      clientName: textValue("clientName", "client_name"),
      effectiveDate: textValue("effectiveDate", "effective_date"),
      appraisalPurpose: textValue(
        "appraisalPurpose",
        "appraisal_purpose"
      ),
      ownerName: textValue("ownerName", "owner_name"),
      preparedFor: textValue("preparedFor", "prepared_for"),
      appraiser: textValue("appraiser"),
      appraisalCompany: textValue(
        "appraisalCompany",
        "appraisal_company"
      ),
      industry: textValue("industry"),
      inspectionDate: textValue("inspectionDate", "inspection_date"),
      location: textValue("location"),
      latitude: numberValue("latitude"),
      longitude: numberValue("longitude"),
      contractNo:
        textValue("contractNo", "contract_no") || record.contractNo,
      language: normalizedLanguage,
      currency: textValue("currency"),
      includeValuationTable: booleanValue(
        "includeValuationTable",
        "include_valuation_table"
      ),
      selectedValuationMethods: normalizedMethods,
      includeDamageAnalysis: booleanValue(
        "includeDamageAnalysis",
        "include_damage_analysis"
      ),
      bankPhotosEnabled: booleanValue(
        "bankPhotosEnabled",
        "bank_photos_enabled"
      ),
      watermarkImages:
        value("watermarkImages", "watermark_images") === undefined
          ? false
          : booleanValue("watermarkImages", "watermark_images"),
      factorsAgeCondition: textValue(
        "factorsAgeCondition",
        "factors_age_condition"
      ),
      factorsQuality: textValue("factorsQuality", "factors_quality"),
      factorsAnalysis: textValue("factorsAnalysis", "factors_analysis"),
    });

    const restoredLots: MixedLot[] =
      record.storageMode === "smart_upload"
        ? []
        : await ReportDraftService.restoreLots<MixedLot>(record, { signal });
    signal.throwIfAborted();
    setMixedLots(restoredLots);
    jobIdRef.current = record.clientDraftId;
    if (record.storageMode === "smart_upload") {
      setDraftGuidance(null);
      setSmartUploadOpen(true);
      publishDraftStatus(
        restoredLocationMigrationDirtyRef.current ? "dirty" : "saved",
        restoredLocationMigrationDirtyRef.current
          ? "Location updated · save again"
          : "Smart Upload restored"
      );
    } else if (restoredLocationMigrationDirtyRef.current) {
      publishDraftStatus("dirty", "Location updated · save again");
    } else {
      setDraftGuidance(null);
      publishDraftStatus("saved", "Draft and photos restored");
    }
    return true;
  };

  useEffect(() => {
    if (resumeDraft) {
      const controller = new AbortController();
      setDraftHydrated(false);
      setRestoredAccountKey(null);
      setRestoringAccountDraft(Boolean(userId));
      setDraftGuidance(null);
      lastFingerprintRef.current = null;
      if (!userId) return () => controller.abort();
      void (async () => {
        if (resumeDraft.user !== userId) throw new Error("Return to Drafts and open a draft belonging to the signed-in account.");
        const record = restoreAttempt ? await ReportDraftService.get(resumeDraft._id, controller.signal) : resumeDraft;
        await restoreAccountDraft(record, controller.signal);
        controller.signal.throwIfAborted();
        setRestoredAccountKey(accountRestoreKey);
        setDraftHydrated(true);
        toast.info("Your asset draft was restored.");
      })().catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDraftGuidance({ tone: "error", message: `${safeReportOperationError(error, "The draft could not be loaded. Check your connection and account access.")} Your saved draft is unchanged. Retry loading before editing or submitting.` });
        publishDraftStatus("error", "Draft restore failed");
      }).finally(() => {
        if (!controller.signal.aborted) setRestoringAccountDraft(false);
      });
      return () => controller.abort();
    }
    if (
      !userId ||
      !draftStorageKey ||
      mountRestoreStartedRef.current ||
      (!resumeDraft && !restoreDraftOnMount)
    ) {
      setDraftHydrated(true);
      return;
    }
    mountRestoreStartedRef.current = true;
    let cancelled = false;
    setDraftHydrated(false);
    lastFingerprintRef.current = null;
    void (async () => {
      let restored = false;
      try {
        restored = await restoreLocalDraft();
        if (restored && !cancelled) toast.info("Your asset draft was restored.");
      } catch (restoreError) {
        if (!cancelled) {
          setDraftGuidance({
            tone: "error",
            message:
              safeReportOperationError(restoreError, "The draft could not be restored. Retry loading before editing or submitting."),
          });
          publishDraftStatus("error", "Draft restore failed");
        }
      } finally {
        if (!cancelled) {
          setDraftHydrated(true);
          lastFingerprintRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountRestoreKey, draftStorageKey, restoreAttempt, restoreDraftOnMount, resumeDraft, userId]);

  useEffect(() => {
    if (!appraiser && user?.username) setAppraiser(user.username);
    if (!appraisalCompany && user?.companyName) {
      setAppraisalCompany(user.companyName);
    }
  }, [user, appraiser, appraisalCompany]);

  const applyLocaleFallbackCurrency = () => {
    const languageTag = navigator.language || "en-CA";
    const region = (languageTag.split("-")[1] || "").toUpperCase();
    const currencies: Record<string, string> = {
      US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", NZ: "NZD",
      IN: "INR", LK: "LKR", JP: "JPY", CN: "CNY", SG: "SGD",
      AE: "AED", SA: "SAR", ZA: "ZAR", NG: "NGN", PH: "PHP",
      MY: "MYR", TH: "THB", ID: "IDR", KR: "KRW", HK: "HKD",
      AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", TR: "TRY",
      EG: "EGP", KE: "KES", GH: "GHS", VN: "VND", FR: "EUR",
      DE: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", IE: "EUR",
      PT: "EUR", BE: "EUR",
    };
    if (!currencyTouchedRef.current) {
      setCurrency((current) => current || currencies[region] || "CAD");
    }
  };

  async function resolveCoordinatesToLocation({
    coordinates,
    requestGeneration,
    accuracy,
    restored = false,
    detectCurrency = false,
  }: {
    coordinates: { latitude: number; longitude: number };
    requestGeneration: number;
    accuracy?: number | null;
    restored?: boolean;
    detectCurrency?: boolean;
  }) {
    if (!isValidBrowserCoordinates(coordinates.latitude, coordinates.longitude)) {
      if (requestGeneration === locationRequestGenerationRef.current) {
        setLocationStatus(
          "Browser coordinates were unavailable. Re-detect or enter the location manually."
        );
        if (detectCurrency) applyLocaleFallbackCurrency();
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

      setLocation(resolved.location);
      setLatitude(coordinates.latitude);
      setLongitude(coordinates.longitude);
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
      clearFieldError("location");
      if (!currencyTouchedRef.current && resolved.currency) {
        setCurrency(resolved.currency);
      } else if (detectCurrency && !resolved.currency) {
        applyLocaleFallbackCurrency();
      }
      if (restored) {
        restoredLocationMigrationDirtyRef.current = true;
        saveRevisionRef.current =
          Math.max(
            saveRevisionRef.current,
            committedRevisionRef.current
          ) + 1;
        publishDraftStatus("dirty", "Location updated · save again");
      } else if (draftSaveAbortRef.current) {
        saveRevisionRef.current += 1;
        publishDraftStatus("dirty", "Location updated · save again");
      }
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
      if (detectCurrency) applyLocaleFallbackCurrency();
    } finally {
      if (locationLookupAbortRef.current === controller) {
        locationLookupAbortRef.current = null;
      }
    }
  }

  const requestCurrentLocation = ({
    detectCurrency = false,
  }: { detectCurrency?: boolean } = {}) => {
    const requestGeneration = ++locationRequestGenerationRef.current;
    locationLookupAbortRef.current?.abort();
    locationLookupAbortRef.current = null;
    if (detectCurrency) setCurrencyLoading(true);
    if (!navigator.geolocation) {
      setLocationStatus("Browser location access is unavailable");
      if (detectCurrency) {
        applyLocaleFallbackCurrency();
        setCurrencyLoading(false);
      }
      return;
    }
    setLocationStatus("Detecting current location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void resolveCoordinatesToLocation({
          coordinates: {
            latitude: Number(position.coords?.latitude),
            longitude: Number(position.coords?.longitude),
          },
          requestGeneration,
          accuracy: position.coords?.accuracy,
          detectCurrency,
        }).finally(() => {
          if (detectCurrency) setCurrencyLoading(false);
        });
      },
      () => {
        if (requestGeneration === locationRequestGenerationRef.current) {
          setLocationStatus(
            "Browser location access was denied or is unavailable"
          );
          if (detectCurrency) applyLocaleFallbackCurrency();
        }
        if (detectCurrency) setCurrencyLoading(false);
      },
      FRESH_HIGH_ACCURACY_POSITION_OPTIONS
    );
  };

  useEffect(() => {
    if (auctioneer || resumeDraft) {
      setCurrencyLoading(false);
      return;
    }
    if (currencyPromptedRef.current || currencyTouched) return;
    currencyPromptedRef.current = true;
    requestCurrentLocation({ detectCurrency: true });
    // React development Strict Mode intentionally replays effects. Reset this
    // guard during cleanup so the replay can replace the now-invalidated
    // geolocation request instead of leaving the form stuck on "Detecting".
    return () => {
      currencyPromptedRef.current = false;
    };
  }, [auctioneer, currencyTouched, resumeDraft]);

  const resetForm = () => {
    submissionActivityIdRef.current = undefined;
    locationRequestGenerationRef.current += 1;
    locationLookupAbortRef.current?.abort();
    locationLookupAbortRef.current = null;
    setClientName(auctioneer?.contract.customerName || "");
    setEffectiveDate(importedEventDate);
    setAppraisalPurpose(
      auctioneer ? "Auction listing and condition report" : ""
    );
    setOwnerName(auctioneer?.contract.customerName || "");
    setPreparedFor(auctioneer?.contract.customerName || "");
    setAppraiser(user?.username || "");
    setAppraisalCompany(user?.companyName || "");
    setIndustry(auctioneerIndustry(auctioneer));
    setInspectionDate(isoDate(new Date()));
    setLocation(importedLocation);
    setLatitude(null);
    setLongitude(null);
    setLocationAttribution(null);
    setLocationAttributionUrl(null);
    setLocationStatus(
      auctioneer ? "Imported from Auctioneer" : "Detecting current location…"
    );
    setContractNo(auctioneer?.contract.contractNo || "");
    setLanguage("en");
    setCurrency(auctioneer ? "CAD" : "");
    setCurrencyTouched(Boolean(auctioneer));
    setCurrencyLoading(false);
    currencyPromptedRef.current = false;
    setIncludeDamageAnalysis(true);
    setBankPhotosEnabled(false);
    setFactorsAgeCondition("");
    setFactorsQuality("");
    setFactorsAnalysis("");
    setIncludeValuationTable(false);
    setSelectedValuationMethods(["FML"]);
    setMixedLots(buildAuctioneerSeedLots(auctioneer));
    setErrors({});
    setError(null);
    setUploadProgress(0);
    setUploadStats(null);
    setOpenSections(new Set(["report", "media"]));
    jobIdRef.current =
      auctioneer?.clientSubmissionId ||
      (auctioneer ? `auctioneer-${auctioneer.workItemId}` : null);
    forceNewSubmissionRef.current = false;
    supersededSubmissionIdRef.current = null;
  };

  const clearDraftStorage = async () => {
    let deleteError: unknown;
    const localResults = await Promise.allSettled([
      deleteScopedDraft(userId, "asset", draftScopeId),
      deleteSmartUploadDraft(userId, "asset", draftScopeId),
    ]);
    const localFailure = localResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (localFailure) deleteError = localFailure.reason;
    if (draftStorageKey) localStorage.removeItem(draftStorageKey);
    try {
      await ReportDraftService.deleteByClientId(draftScopeId, "asset");
      accountSyncPendingRef.current = false;
    } catch (serverDeleteError: any) {
      if (serverDeleteError?.response?.status !== 404) {
        deleteError ||= serverDeleteError;
      }
    }
    if (deleteError) throw deleteError;
  };

  const discardDraft = async () => {
    if (restoreBlockedRef.current) return;
    setDiscarding(true);
    autoSaveBlockedRef.current = true;
    if (saveInFlightRef.current) await saveInFlightRef.current;
    try {
      saveRevisionRef.current += 1;
      await clearDraftStorage();
      resetForm();
      setDraftGuidance(null);
      setDiscardOpen(false);
      publishDraftStatus("dirty", "No draft saved");
      toast.info("Draft discarded.");
      setDraftHydrated(false);
      lastFingerprintRef.current = null;
      window.setTimeout(() => {
        setDraftHydrated(true);
        lastFingerprintRef.current = null;
        autoSaveBlockedRef.current = false;
      }, 0);
    } catch (discardError) {
      autoSaveBlockedRef.current = false;
      setDraftGuidance({
        tone: "error",
        message:
          discardError instanceof Error
            ? discardError.message
            : "The draft could not be discarded.",
      });
      publishDraftStatus("error", "Draft was not discarded");
    } finally {
      setDiscarding(false);
    }
  };

  const saveInputs = async () => {
    if (restoreBlockedRef.current) return;
    setMoreAnchor(null);
    try {
      const baseName = clientName.trim() || "Unnamed";
      const dateLabel = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const formData: AssetFormData = {
        clientName,
        effectiveDate,
        appraisalPurpose,
        ownerName,
        appraiser,
        appraisalCompany,
        industry,
        inspectionDate,
        location,
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined,
        contractNo,
        language,
        currency,
        includeValuationTable,
        selectedValuationMethods,
        includeDamageAnalysis,
        bankPhotosEnabled,
        watermarkImages,
        groupingMode: "mixed",
        preparedFor,
        factorsAgeCondition,
        factorsQuality,
        factorsAnalysis,
      };
      await SavedInputService.create({
        name: `${baseName} - ${dateLabel}`,
        formType: "asset",
        formData,
      });
      toast.success("Reusable input saved.");
    } catch (saveError: any) {
      toast.error(saveError?.response?.data?.message || "Failed to save reusable input");
    }
  };

  const loadSavedInput = (savedInput: SavedInput) => {
    if (restoreBlockedRef.current) return;
    try {
      const data = savedInput.formData as AssetFormData;
      if (!data) return;
      restoreFormFields({
        clientName: data.clientName,
        effectiveDate: data.effectiveDate,
        appraisalPurpose: data.appraisalPurpose,
        ownerName: data.ownerName,
        appraiser: data.appraiser,
        appraisalCompany: data.appraisalCompany,
        industry: data.industry,
        inspectionDate: data.inspectionDate,
        location: data.location,
        latitude: data.latitude,
        longitude: data.longitude,
        contractNo: data.contractNo,
        language: data.language,
        currency: data.currency,
        includeValuationTable: data.includeValuationTable,
        selectedValuationMethods: data.selectedValuationMethods,
        includeDamageAnalysis: data.includeDamageAnalysis,
        bankPhotosEnabled: data.bankPhotosEnabled,
        watermarkImages: data.watermarkImages,
        preparedFor: data.preparedFor,
        factorsAgeCondition: data.factorsAgeCondition,
        factorsQuality: data.factorsQuality,
        factorsAnalysis: data.factorsAnalysis,
      });
      setOpenSections((current) => new Set(current).add("report"));
      toast.success(`Loaded: ${savedInput.name}`);
    } catch {
      toast.error("Failed to load saved input");
    }
  };

  useImperativeHandle(ref, () => ({ loadSavedInput }));

  const loadedInitialInputRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSavedInput?._id) return;
    if (loadedInitialInputRef.current === initialSavedInput._id) return;
    loadedInitialInputRef.current = initialSavedInput._id;
    loadSavedInput(initialSavedInput);
  }, [initialSavedInput]);

  useEffect(() => {
    if (auctioneer) return;
    const handler = (event: Event) => {
      const savedInput = (event as CustomEvent<SavedInput>).detail;
      if (savedInput) loadSavedInput(savedInput);
    };
    window.addEventListener("load-saved-input", handler);
    return () => window.removeEventListener("load-saved-input", handler);
  }, [auctioneer]);

  const validateForm = ({
    requireMedia = true,
    actionLabel = "creating the report",
  }: {
    requireMedia?: boolean;
    actionLabel?: string;
  } = {}) => {
    if (restoreBlockedRef.current) return false;
    const nextErrors: Record<string, string> = {};
    if (!clientName.trim()) nextErrors.clientName = "Client name is required.";
    if (!effectiveDate) nextErrors.effectiveDate = "Effective date is required.";
    if (!appraisalPurpose.trim()) nextErrors.appraisalPurpose = "Appraisal purpose is required.";
    if (!appraiser.trim()) nextErrors.appraiser = "Appraiser is required.";
    if (!/^[A-Z]{3}$/.test(currency)) nextErrors.currency = "Enter a three-letter ISO code, such as CAD.";
    if (!hasUsableReportLocation(location)) {
      nextErrors.location =
        "Wait for browser location detection or enter the inspection location.";
    }
    if (includeValuationTable && selectedValuationMethods.length === 0) {
      nextErrors.valuationMethods = "Select at least one valuation method.";
    }
    if (requireMedia) {
      const photoCount = mixedLots.reduce(
        (total, lot) => total + lot.files.length + lot.extraFiles.length,
        0
      );
      if (!mixedLots.length || photoCount === 0) {
        nextErrors.media = "Add at least one lot with a main photo.";
      } else if (
        mixedLots.some(
          (lot) =>
            !lot.mode ||
            lot.files.length === 0 ||
            lot.files.length + lot.extraFiles.length > MAX_ASSET_LOT_PHOTOS
        )
      ) {
        nextErrors.media = `Every lot needs a mode and a main photo, with no more than ${MAX_ASSET_LOT_PHOTOS} main and report-only photos combined.`;
      }
    }
    setErrors(nextErrors);
    if (!Object.keys(nextErrors).length) return true;

    const firstKey = [
      "clientName",
      "effectiveDate",
      "appraisalPurpose",
      "appraiser",
      "currency",
      "location",
      "valuationMethods",
      "media",
    ].find((key) => nextErrors[key]);
    const section: SectionId =
      firstKey === "valuationMethods"
        ? "comparison"
        : firstKey === "media"
          ? "media"
          : "report";
    setOpenSections((current) => new Set(current).add(section));
    setError(`Review the highlighted fields before ${actionLabel}.`);
    toast.error("Please fix the highlighted fields.");
    window.setTimeout(() => {
      const target =
        firstKey === "media"
          ? document.getElementById("asset-media-workspace")
          : document.getElementById(`asset-${firstKey}`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return false;
  };

  const dispatchReportCreated = () => {
    if (createdEventDispatchedRef.current) return;
    createdEventDispatchedRef.current = true;
    window.dispatchEvent(new Event("cv:report-created"));
  };

  const smartUploadDetails = useMemo<Record<string, unknown>>(
    () => ({
      grouping_mode: "mixed",
      smart_upload: true,
      client_name: clientName.trim(),
      effective_date: effectiveDate,
      appraisal_purpose: appraisalPurpose.trim(),
      ...(ownerName.trim() && { owner_name: ownerName.trim() }),
      appraiser: appraiser.trim(),
      ...(appraisalCompany.trim() && {
        appraisal_company: appraisalCompany.trim(),
      }),
      ...(industry.trim() && { industry: industry.trim() }),
      ...(inspectionDate && { inspection_date: inspectionDate }),
      location: location.trim(),
      ...(isValidBrowserCoordinates(latitude, longitude)
        ? { latitude: Number(latitude), longitude: Number(longitude) }
        : {}),
      ...(contractNo.trim() && { contract_no: contractNo.trim() }),
      language,
      currency,
      include_valuation_table: includeValuationTable,
      valuation_methods: includeValuationTable
        ? selectedValuationMethods
        : [],
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: bankPhotosEnabled,
      watermark_images: watermarkImages,
      activity_id: draftScopeId,
      force_new: forceNewSubmissionRef.current,
      ...(auctioneer && {
        auctioneer_work_item_id: auctioneer.workItemId,
      }),
      ...(preparedFor.trim() && { prepared_for: preparedFor.trim() }),
      ...(factorsAgeCondition.trim() && {
        factors_age_condition: factorsAgeCondition.trim(),
      }),
      ...(factorsQuality.trim() && {
        factors_quality: factorsQuality.trim(),
      }),
      ...(factorsAnalysis.trim() && {
        factors_analysis: factorsAnalysis.trim(),
      }),
    }),
    [
      appraisalCompany,
      appraisalPurpose,
      appraiser,
      auctioneer,
      bankPhotosEnabled,
      watermarkImages,
      clientName,
      contractNo,
      currency,
      effectiveDate,
      factorsAgeCondition,
      factorsAnalysis,
      factorsQuality,
      includeDamageAnalysis,
      includeValuationTable,
      industry,
      inspectionDate,
      language,
      latitude,
      location,
      longitude,
      ownerName,
      preparedFor,
      selectedValuationMethods,
    ]
  );

  const openSmartUploadWorkspace = (method: "black_divider" | "lot_number" = "black_divider") => {
    if (mixedLots.length > 0) {
      toast.info(
        "Smart Upload starts with an empty media form. Clear the manually created lots first."
      );
      return;
    }
    if (
      !validateForm({
        requireMedia: false,
        actionLabel: "starting Smart Upload",
      })
    ) {
      return;
    }
    setError(null);
    setSmartGroupingMethod(method);
    setSmartUploadOpen(true);
  };

  const handleSmartUploadSubmitted = async () => {
    const accepted =
      "Smart Upload accepted - preview processing continues in My Reports.";
    setSmartUploadOpen(false);
    setAcceptedMessage(accepted);
    toast.success(accepted);
    autoSaveBlockedRef.current = true;
    if (saveInFlightRef.current) await saveInFlightRef.current;
    saveRevisionRef.current += 1;
    const cleanupError = await clearDraftStorage()
      .then(() => null)
      .catch((draftError) => draftError);
    createdEventDispatchedRef.current = false;
    dispatchReportCreated();
    setDraftHydrated(false);
    resetForm();
    setAcceptedMessage(null);
    forceNewSubmissionRef.current = false;
    supersededSubmissionIdRef.current = null;
    publishDraftStatus("saved", "Smart Upload accepted");
    if (cleanupError) {
      toast.warning(
        "The report was accepted, but its previous manual draft could not be removed."
      );
    }
    onSuccess?.(accepted);
    window.setTimeout(() => {
      lastFingerprintRef.current = null;
      createdEventDispatchedRef.current = false;
      autoSaveBlockedRef.current = false;
      setDraftHydrated(true);
    }, 0);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const uploadTimeRemaining = () => {
    if (!uploadStats?.uploadedBytes) return "Calculating…";
    const elapsedSeconds = Math.max(0.1, (Date.now() - uploadStats.startTime) / 1000);
    const bytesPerSecond = uploadStats.uploadedBytes / elapsedSeconds;
    const remainingSeconds = Math.ceil(
      (uploadStats.totalSize - uploadStats.uploadedBytes) / bytesPerSecond
    );
    if (remainingSeconds < 60) return `About ${remainingSeconds}s remaining`;
    return `About ${Math.ceil(remainingSeconds / 60)}m remaining`;
  };

  async function onSubmit(event?: React.FormEvent, continueWithNewLot = false) {
    event?.preventDefault();
    if (
      activeFormOperationRef.current ||
      submitLockRef.current ||
      submitting ||
      !validateForm()
    ) return;
    activeFormOperationRef.current = "submit";
    submitLockRef.current = true;
    const controller = new AbortController();
    submitAbortRef.current = controller;
    const submitSession = captureAuthSession();
    setSubmitting(true);
    setCancellingOperation(false);
    setSubmissionFinalizing(false);

    let keepDraftSavingBlocked = false;
    try {
      autoSaveBlockedRef.current = true;
      if (saveInFlightRef.current) await saveInFlightRef.current;
      assertAuthSessionCurrent(submitSession);
      controller.signal.throwIfAborted();

      const filesToSend = mixedLots.flatMap((lot) => [
        ...lot.files,
        ...lot.extraFiles,
      ]);
      const videosToSend = mixedLots.flatMap((lot) => lot.videoFiles || []);
      const focusBoxes: NonNullable<AssetCreateDetails["focus_boxes"]> =
        buildMixedFocusBoxes(mixedLots);

      const jobId = ensureJobId();
      const payload = {
        grouping_mode: "mixed",
        client_name: clientName.trim(),
        effective_date: effectiveDate,
        appraisal_purpose: appraisalPurpose.trim(),
        ...(ownerName.trim() && { owner_name: ownerName.trim() }),
        appraiser: appraiser.trim(),
        ...(appraisalCompany.trim() && {
          appraisal_company: appraisalCompany.trim(),
        }),
        ...(industry.trim() && { industry: industry.trim() }),
        ...(inspectionDate && { inspection_date: inspectionDate }),
        location: location.trim(),
        ...(isValidBrowserCoordinates(latitude, longitude)
          ? { latitude: Number(latitude), longitude: Number(longitude) }
          : {}),
        ...(contractNo.trim() && { contract_no: contractNo.trim() }),
        language,
        currency,
        include_valuation_table: includeValuationTable,
        valuation_methods: includeValuationTable
          ? selectedValuationMethods
          : [],
        include_damage_analysis: includeDamageAnalysis,
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
        ...(preparedFor.trim() && { prepared_for: preparedFor.trim() }),
        ...(factorsAgeCondition.trim() && {
          factors_age_condition: factorsAgeCondition.trim(),
        }),
        ...(factorsQuality.trim() && {
          factors_quality: factorsQuality.trim(),
        }),
        ...(factorsAnalysis.trim() && {
          factors_analysis: factorsAnalysis.trim(),
        }),
        mixed_lots: mixedLots.map((lot) => ({
          count: lot.files.length,
          extra_count: lot.extraFiles.length,
          video_count: (lot.videoFiles || []).length,
          cover_index: Math.max(
            0,
            Math.min(lot.files.length - 1, lot.coverIndex || 0)
          ),
          mode: lot.mode!,
          ...(lot.source && {
            source_key: lot.source.key,
            /*
               The Schedule A line this lot was split out of, present only on a
               lot the appraiser added. Auctioneer named one line and receives
               several lots for it; without the parent they arrive as extras it
               cannot place, which is the mismatch needs_reconciliation catches.
            */
            ...(lot.source.parentKey && { source_parent_key: lot.source.parentKey }),
            source_lot_id: lot.source.lotId,
            source_submission_id: lot.source.submissionId,
          }),
        })),
        ...(focusBoxes.length ? { focus_boxes: focusBoxes } : {}),
      } as AssetCreateDetails & {
        client_submission_id: string;
        force_new: boolean;
        auctioneer_work_item_id?: string;
      };

      /*
         Hand the upload to the background line and close the form, unless this
         submission needs to stay here. Auctioneer work does: its continuation
         can only be requested against an accepted reportId, and the decision
         prompts (active report, changed manifest, separate draft) live in this
         component. A draft whose last background attempt hit one of those is
         marked foreground, so its next Submit runs inline where it can be
         answered.
      */
      const mustStayInForm =
        Boolean(auctioneer) ||
        isUploadReviewScope(draftScopeId) ||
        backgroundUploads.isForegroundRequired("asset", draftScopeId);
      if (!mustStayInForm) {
        const orderedFiles = [...filesToSend, ...videosToSend];
        setPreparingBackgroundUpload(true);
        setUploadProgress(0);
        setUploadStats({ totalFiles: orderedFiles.length, totalSize: orderedFiles.reduce((sum, file) => sum + file.size, 0), uploadedBytes: 0, startTime: Date.now() });
        const handedOffScopeId = draftScopeId;
        const snapshot = makeSnapshot(saveRevisionRef.current);
        await backgroundUploads.enqueue({
          ownerId: userId,
          kind: "asset",
          scopeId: handedOffScopeId,
          endpoint: "/asset",
          title: contractNo.trim() || clientName.trim() || "Asset report",
          totalFiles: orderedFiles.length,
          clientSubmissionId: jobId,
          details: payload,
          files: describeOrderedFiles(orderedFiles),
          media: orderedFiles,
          draftSnapshot: {
            version: FORM_DRAFT_VERSION, kind: "asset", userId,
            revision: snapshot.revision, savedAt: new Date().toISOString(),
            deviceId: getDeviceId(), formData: snapshot.formData, lots: snapshot.lots,
            mediaMetadata: listDraftMediaLocations(snapshot.lots),
          } satisfies AssetDraftEnvelope,
          signal: controller.signal,
          needsFormDecision: assetSubmissionNeedsForm,
          upload: async (onProgress, signal) => {
            const response = await AssetService.create(
              payload,
              filesToSend,
              videosToSend,
              { onUploadProgress: onProgress, signal }
            );
            assertReportUploadAccepted(response);
            // The manager distinguishes a first receipt from a retry of the
            // exact immutable snapshot after an uncertain acceptance.
            return response;
          },
        });
        assertAuthSessionCurrent(submitSession);
        controller.signal.throwIfAborted();
        // The immutable upload now owns its lifetime; closing this form must
        // not abort it, or run cleanup against a later editable draft.
        if (submitAbortRef.current === controller) submitAbortRef.current = null;
        /*
           The next report needs its own draft scope: the handed-off upload
           still owns the saved media behind the old one, and autosaving a new
           report over it would leave that upload unable to resume.
        */
        draftClientIdRef.current = createReportDraftClientId("asset");
        dispatchReportCreated();
        setDraftHydrated(false);
        resetForm();
        forceNewSubmissionRef.current = false;
        supersededSubmissionIdRef.current = null;
        publishDraftStatus("saved", "Upload continues in the background");
        keepDraftSavingBlocked = true;
        window.setTimeout(() => {
          if (!isAuthSessionCurrent(submitSession)) return;
          lastFingerprintRef.current = null;
          createdEventDispatchedRef.current = false;
          autoSaveBlockedRef.current = false;
          setDraftHydrated(true);
        }, 0);
        const handedOff =
          "Report saved on this browser. Upload continues while this tab stays open; use the upload bar to pause or resume.";
        toast.success(handedOff);
        onSuccess?.(handedOff);
        return;
      }
      // This attempt is answering the conflict that sent it back here.
      backgroundUploads.clearForegroundRequirement("asset", draftScopeId);

      setSubmitting(true);
      setError(null);
      setAcceptedMessage(null);
      setUploadProgress(0);
      const totalSize = [...filesToSend, ...videosToSend].reduce(
        (sum, file) => sum + file.size,
        0
      );
      setUploadStats({
        totalFiles: filesToSend.length + videosToSend.length,
        totalSize,
        uploadedBytes: 0,
        startTime: Date.now(),
      });

      const response = await AssetService.create(payload, filesToSend, videosToSend, {
        onUploadProgress: (fraction) => {
          const progress = Math.max(0, Math.min(1, fraction));
          setUploadProgress(progress * 100);
          setUploadStats((current) =>
            current
              ? { ...current, uploadedBytes: Math.round(progress * current.totalSize) }
              : current
          );
        },
        signal: controller.signal,
      });
      assertReportUploadAccepted(response);
      if (isPreviousReportReceipt(response)) {
        setError("An earlier submission was already accepted. Your current edits have not been submitted again and remain in this form. Open My Reports in another tab to check the existing report before continuing.");
        publishDraftStatus("dirty", "Existing report found · current form retained");
        return;
      }

      if (submitAbortRef.current === controller) submitAbortRef.current = null;
      setSubmissionFinalizing(true);
      setUploadProgress(100);
      const accepted =
        "Submission accepted — processing continues in My Reports.";
      setAcceptedMessage(accepted);
      toast.success(accepted);
      saveRevisionRef.current += 1;
      const continuing = Boolean(continueWithNewLot && auctioneer && onAcceptedAndContinue);
      if (continuing) {
        // Acceptance, not old-draft cleanup or background analysis, authorizes
        // the next-work-item request. The parent hides this accepted form now.
        dispatchReportCreated();
        onAcceptedAndContinue?.(acceptedAuctioneerReportId(response), {
          clientName, effectiveDate, appraisalPurpose, ownerName, appraiser,
          appraisalCompany, industry, inspectionDate, location, latitude, longitude,
          contractNo, language, currency, includeValuationTable,
          selectedValuationMethods: [...selectedValuationMethods], includeDamageAnalysis,
          bankPhotosEnabled, watermarkImages, preparedFor, factorsAgeCondition,
          factorsQuality, factorsAnalysis,
        });
      }
      const cleanupError = await clearDraftStorage()
        .then(() => null)
        .catch((draftError) => draftError);
      dispatchReportCreated();
      setDraftHydrated(false);
      resetForm();
      setAcceptedMessage(null);
      forceNewSubmissionRef.current = false;
      supersededSubmissionIdRef.current = null;
      // Late cleanup must not overwrite the successor form's draft status.
      if (!continuing) publishDraftStatus("saved", "Submission accepted");
      if (cleanupError) {
        toast.warning(
          "Report submitted, but its local draft could not be removed. You can discard the old local copy later."
        );
      }
      keepDraftSavingBlocked = true;
      window.setTimeout(() => {
        lastFingerprintRef.current = null;
        createdEventDispatchedRef.current = false;
        autoSaveBlockedRef.current = false;
        setDraftHydrated(true);
      }, 0);
      if (!continuing) {
        onSuccess?.(accepted);
      }
    } catch (submitError: any) {
      autoSaveBlockedRef.current = false;
      if (!isAuthSessionCurrent(submitSession)) return;
      if (controller.signal.aborted) {
        const message =
          "Upload stopped. Your report details and selected media are still here and have not been cleared.";
        setError(message);
        publishDraftStatus("dirty", "Upload stopped · unsaved changes");
        toast.info(message);
      } else if (
        submitError?.response?.status === 409 &&
        submitError?.response?.data?.code === "ACTIVE_REPORT_EXISTS"
      ) {
        setActiveReportConflict(true);
      } else if (
        submitError?.response?.status === 409 &&
        submitError?.response?.data?.code === "SUBMISSION_MANIFEST_CHANGED"
      ) {
        if (auctioneer || reportTransferErrorData(submitError).data.canSupersede !== true || reportTransferErrorData(submitError).data.accepted !== false) {
          setError(
            "This upload was started with different media. Its acceptance has not been ruled out. Check My Reports before retrying; your current form and media have not been cleared."
          );
        } else {
          setSubmissionManifestConflict(true);
          setError(
            "The selected media changed after the previous upload attempt. Start a new upload to submit the current form safely."
          );
        }
        publishDraftStatus("dirty", "New upload identity required");
      } else {
        if (!auctioneer && canSaveSeparateReportDraft(submitError)) {
          const sessionId = reportTransferErrorData(submitError).data.sessionId;
          if (typeof sessionId === "string" && sessionId.trim()) setUnavailableSessionId(sessionId);
        }
        const message = reportTransferErrorMessage(submitError, "submit");
        setError(message);
        toast.error(message);
        publishDraftStatus("dirty", "Submission failed · unsaved changes");
      }
    } finally {
      setPreparingBackgroundUpload(false);
      setSubmitting(false);
      submitLockRef.current = false;
      if (activeFormOperationRef.current === "submit") {
        activeFormOperationRef.current = null;
      }
      if (submitAbortRef.current === controller) submitAbortRef.current = null;
      setCancellingOperation(false);
      setSubmissionFinalizing(false);
      if (!keepDraftSavingBlocked) autoSaveBlockedRef.current = false;
    }
  }

  const reportErrorCount = [
    "clientName",
    "effectiveDate",
    "appraisalPurpose",
    "appraiser",
    "currency",
    "location",
  ].filter((key) => errors[key]).length;
  const requiredComplete = [
    clientName.trim(),
    effectiveDate,
    appraisalPurpose.trim(),
    appraiser.trim(),
    /^[A-Z]{3}$/.test(currency) ? currency : "",
    hasUsableReportLocation(location) ? location : "",
  ].filter(Boolean).length;
  const mediaTotals = mixedLots.reduce(
    (totals, lot) => ({
      photos: totals.photos + lot.files.length + lot.extraFiles.length,
      videos: totals.videos + (lot.videoFiles || []).length,
    }),
    { photos: 0, videos: 0 }
  );
  const draftSaving = draftSaveActive;
  const transferActive = draftSaving || submitting || separateDraftSaving;
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
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]"
      onSubmit={onSubmit}
      aria-busy={submitting || draftSaving}
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
          percent={uploadProgress}
          message={preparingBackgroundUpload ? "Saving the report and original media on this browser before closing the form. Keep this page open." : `Uploading ${uploadStats.totalFiles} file${
            uploadStats.totalFiles === 1 ? "" : "s"
          } · ${uploadTimeRemaining()}`}
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
        inert={transferActive ? true : undefined}
        aria-hidden={transferActive ? true : undefined}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto grid w-full max-w-5xl gap-4">
          {error ? (
            <FormAlert tone="error" title="Report needs attention" onDismiss={() => setError(null)}>
              {error}
            </FormAlert>
          ) : null}
          {error ? <a href="/reports" target="_blank" rel="noopener noreferrer" className="text-sm font-semibold underline">Open My Reports (new tab)</a> : null}
          {unavailableSessionId && !auctioneer ? <SeparateReportDraftRecovery userId={userId} kind="asset" sourceSessionId={unavailableSessionId} getSnapshot={() => {
            const snapshot = makeSnapshot(saveRevisionRef.current);
            return { formData: snapshot.formData, lots: snapshot.lots, contractNo: snapshot.formData.contractNo || "" };
          }} onBusyChange={(busy) => { activeFormOperationRef.current = busy ? "draft-save" : null; setSeparateDraftSaving(busy); }} /> : null}

          {draftGuidance ? (
            <FormAlert
              tone={draftGuidance.tone}
              title={draftGuidance.tone === "error" ? "Draft needs attention" : "Draft saved with limitations"}
              onDismiss={restoreBlocked ? undefined : () => setDraftGuidance(null)}
            >
              {draftGuidance.message}
              {resumeDraft && restoreBlocked && !restoringAccountDraft ? (
                <button type="button" className={secondaryButtonClass} onClick={() => setRestoreAttempt((value) => value + 1)}>Retry loading draft</button>
              ) : null}
            </FormAlert>
          ) : null}
          {restoreBlocked && !draftGuidance ? <FormAlert tone="info" title="Loading saved draft">{userId ? "Restoring saved fields and original media. Editing and submission will be available when all files are restored." : "Waiting for your account before loading saved media."}</FormAlert> : null}

          {draftSaveProgress ? (
            <DraftSaveProgressPanel progress={draftSaveProgress} />
          ) : null}

          {acceptedMessage ? (
            <FormAlert tone="success" title="Submission accepted">
              {acceptedMessage}
            </FormAlert>
          ) : null}

          {submitting && uploadStats ? (
            <FormAlert tone="info" title={`Uploading ${uploadStats.totalFiles} file${uploadStats.totalFiles === 1 ? "" : "s"}`}>
              <div className="mt-2 grid gap-2">
                <div
                  className="h-2 overflow-hidden rounded-full bg-[var(--app-control-border)]"
                  role="progressbar"
                  aria-label="File upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(uploadProgress)}
                >
                  <div
                    className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p>
                  {Math.round(uploadProgress)}% · {formatFileSize(uploadStats.uploadedBytes)} of {formatFileSize(uploadStats.totalSize)} · {uploadTimeRemaining()}
                </p>
                <p>Only upload progress is shown here. Processing continues in My Reports after acceptance.</p>
              </div>
            </FormAlert>
          ) : null}

          {Object.keys(errors).length ? (
            <FormAlert tone="error" title="Review required information">
              {Object.values(errors)[0]}
            </FormAlert>
          ) : null}

          <fieldset disabled={submitting || restoreBlocked} className="contents" inert={restoreBlocked ? true : undefined}>
            <FormSection
              id="asset-report-details"
              sectionNumber={1}
              title="Report Details"
              description="Core information used on the report cover and throughout the appraisal."
              summary={`${requiredComplete} of 6 required fields complete`}
              errorSummary={reportErrorCount ? `${reportErrorCount} field${reportErrorCount === 1 ? "" : "s"} need attention` : undefined}
              status={reportErrorCount ? "error" : requiredComplete === 6 ? "complete" : "incomplete"}
              open={openSections.has("report")}
              onOpenChange={(open) => toggleSection("report", open)}
            >
              <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
                <FormField id="asset-clientName" label="Client name" required error={errors.clientName}>
                  <input
                    className={formControlClass}
                    value={clientName}
                    onChange={(event) => {
                      setClientName(event.target.value);
                      clearFieldError("clientName");
                    }}
                    placeholder="Acme Corporation"
                    autoComplete="organization"
                  />
                </FormField>
                <FormField id="asset-effectiveDate" label="Effective date" required error={errors.effectiveDate}>
                  <input
                    type="date"
                    className={formControlClass}
                    value={effectiveDate}
                    readOnly={Boolean(auctioneer)}
                    aria-readonly={Boolean(auctioneer)}
                    onChange={(event) => {
                      setEffectiveDate(event.target.value);
                      clearFieldError("effectiveDate");
                    }}
                  />
                </FormField>
                <FormField id="asset-appraisalPurpose" label="Appraisal purpose" required error={errors.appraisalPurpose}>
                  <input
                    className={formControlClass}
                    value={appraisalPurpose}
                    onChange={(event) => {
                      setAppraisalPurpose(event.target.value);
                      clearFieldError("appraisalPurpose");
                    }}
                    placeholder="Insurance, financing, estate…"
                  />
                </FormField>
                <FormField id="asset-ownerName" label="Owner name">
                  <input
                    className={formControlClass}
                    value={ownerName}
                    onChange={(event) => setOwnerName(event.target.value)}
                    placeholder="Registered owner"
                    autoComplete="name"
                  />
                </FormField>
                <FormField id="asset-preparedFor" label="Prepared for">
                  <input
                    className={formControlClass}
                    value={preparedFor}
                    onChange={(event) => setPreparedFor(event.target.value)}
                    placeholder="Contact or organization"
                  />
                </FormField>
                <FormField id="asset-appraiser" label="Appraiser" required error={errors.appraiser}>
                  <input
                    className={formControlClass}
                    value={appraiser}
                    onChange={(event) => {
                      setAppraiser(event.target.value);
                      clearFieldError("appraiser");
                    }}
                    placeholder="Appraiser name"
                    autoComplete="name"
                  />
                </FormField>
                <FormField id="asset-appraisalCompany" label="Appraisal company">
                  <input
                    className={formControlClass}
                    value={appraisalCompany}
                    onChange={(event) => setAppraisalCompany(event.target.value)}
                    placeholder="Company name"
                    autoComplete="organization"
                  />
                </FormField>
                <FormField id="asset-industry" label="Industry">
                  <input
                    className={formControlClass}
                    value={industry}
                    onChange={(event) => setIndustry(event.target.value)}
                    placeholder="Manufacturing"
                  />
                </FormField>
                <FormField id="asset-inspectionDate" label="Inspection date">
                  <input
                    type="date"
                    className={formControlClass}
                    value={inspectionDate}
                    onChange={(event) => setInspectionDate(event.target.value)}
                  />
                </FormField>
                <FormField id="asset-contractNo" label="Contract number">
                  <input
                    className={formControlClass}
                    value={contractNo}
                    readOnly={Boolean(auctioneer)}
                    aria-readonly={Boolean(auctioneer)}
                    onChange={(event) => setContractNo(event.target.value)}
                    placeholder="CN-2026-001"
                  />
                </FormField>
                <FormField id="asset-language" label="Report language">
                  <select
                    className={formSelectClass}
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as "en" | "fr" | "es")}
                  >
                    <option value="en">English</option>
                    <option value="fr">Français</option>
                    <option value="es">Español</option>
                  </select>
                </FormField>
                <FormField
                  id="asset-currency"
                  label="Currency"
                  required
                  hint="Three-letter ISO code"
                  error={errors.currency}
                  labelAction={currencyLoading ? "Detecting…" : undefined}
                >
                  <input
                    className={formControlClass}
                    value={currency}
                    onChange={(event) => {
                      setCurrencyTouched(true);
                      setCurrency(event.target.value.toUpperCase().slice(0, 3));
                      clearFieldError("currency");
                    }}
                    placeholder="CAD"
                    inputMode="text"
                    maxLength={3}
                  />
                </FormField>
                <FormField
                  id="asset-location"
                  label="Inspection location"
                  required
                  hint={locationHint}
                  error={errors.location}
                  className="sm:col-span-2"
                  labelAction={
                    <button
                      type="button"
                      className="font-semibold text-[var(--app-accent)] hover:underline"
                      onClick={() => requestCurrentLocation()}
                    >
                      Re-detect
                    </button>
                  }
                >
                  <input
                    className={formControlClass}
                    value={location}
                    placeholder="Detecting browser location…"
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
                    }}
                  />
                </FormField>
                <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-3.5 py-3">
                  <FormSwitch
                    id="asset-bankPhotos"
                    checked={bankPhotosEnabled}
                    onChange={(event) => setBankPhotosEnabled(event.target.checked)}
                    label="Bank package"
                    description="Include all photos in the client report."
                  />
                </div>
                <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-3.5 py-3">
                  <FormSwitch
                    id="asset-watermarkImages"
                    checked={watermarkImages}
                    onChange={(event) => setWatermarkImages(event.target.checked)}
                    label="Apply watermark"
                    description="Off by default. Enable only to add a watermark to new, unwatermarked photos."
                  />
                </div>
              </div>
            </FormSection>

            <FormSection
              id="asset-factors"
              sectionNumber={2}
              title="Factors Affecting Value"
              description="Optional context that helps explain condition, quality, and the overall valuation."
              summary={factorsAgeCondition || factorsQuality || factorsAnalysis ? "Additional context added" : "Optional"}
              status={factorsAgeCondition || factorsQuality || factorsAnalysis ? "complete" : "default"}
              open={openSections.has("factors")}
              onOpenChange={(open) => toggleSection("factors", open)}
            >
              <div className="grid gap-5 lg:grid-cols-3">
                <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-4 py-3 lg:col-span-3">
                  <FormSwitch
                    id="asset-damage-analysis"
                    checked={includeDamageAnalysis}
                    onChange={(event) => setIncludeDamageAnalysis(event.target.checked)}
                    label="Damage analysis"
                    description="Analyze damage for lot numbers up to and including 1000. Higher lot numbers are excluded automatically."
                  />
                </div>
                <FormField id="asset-factors-age" label="Age and condition">
                  <textarea
                    className={formTextareaClass}
                    rows={4}
                    value={factorsAgeCondition}
                    onChange={(event) => setFactorsAgeCondition(event.target.value)}
                    placeholder="Describe age, wear, maintenance, and condition…"
                  />
                </FormField>
                <FormField id="asset-factors-quality" label="Quality">
                  <textarea
                    className={formTextareaClass}
                    rows={4}
                    value={factorsQuality}
                    onChange={(event) => setFactorsQuality(event.target.value)}
                    placeholder="Describe materials, workmanship, or build quality…"
                  />
                </FormField>
                <FormField id="asset-factors-analysis" label="Overall analysis">
                  <textarea
                    className={formTextareaClass}
                    rows={4}
                    value={factorsAnalysis}
                    onChange={(event) => setFactorsAnalysis(event.target.value)}
                    placeholder="Add relevant market or valuation context…"
                  />
                </FormField>
              </div>
            </FormSection>

            <FormSection
              id="asset-comparison"
              sectionNumber={3}
              title="Quick Comparison Table"
              description="Optionally add a comparison of supported valuation methods to the report."
              summary={includeValuationTable ? `${selectedValuationMethods.length} method${selectedValuationMethods.length === 1 ? "" : "s"} selected` : "Not included"}
              errorSummary={errors.valuationMethods}
              status={errors.valuationMethods ? "error" : includeValuationTable ? "complete" : "default"}
              open={openSections.has("comparison")}
              onOpenChange={(open) => toggleSection("comparison", open)}
            >
              <div className="grid gap-5">
                <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] px-4 py-3">
                  <FormSwitch
                    id="asset-include-comparison"
                    checked={includeValuationTable}
                    onChange={(event) => {
                      setIncludeValuationTable(event.target.checked);
                      clearFieldError("valuationMethods");
                    }}
                    label="Include comparison table"
                    description="Show selected valuation methods with report-ready explanations."
                  />
                </div>
                {includeValuationTable ? (
                  <div
                    id="asset-valuationMethods"
                    tabIndex={-1}
                    aria-invalid={Boolean(errors.valuationMethods)}
                    aria-describedby={errors.valuationMethods ? "asset-valuationMethods-error" : undefined}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {valuationOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex min-h-20 cursor-pointer items-start gap-3 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] p-3.5 transition hover:bg-[var(--app-panel-alt)]"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-5 w-5 rounded border-[var(--app-control-border)] text-[var(--app-accent)] focus:ring-[var(--app-accent-ring)]"
                          checked={selectedValuationMethods.includes(option.value)}
                          onChange={(event) => {
                            setSelectedValuationMethods((current) =>
                              event.target.checked
                                ? Array.from(new Set([...current, option.value]))
                                : current.filter((method) => method !== option.value)
                            );
                            clearFieldError("valuationMethods");
                          }}
                        />
                        <span>
                          <span className="block text-sm font-semibold text-[var(--app-text)]">{option.label}</span>
                          <span className="mt-1 block text-xs leading-5 text-[var(--app-text-muted)]">{option.description}</span>
                        </span>
                      </label>
                    ))}
                    {errors.valuationMethods ? (
                      <p id="asset-valuationMethods-error" className="text-xs font-medium text-[var(--app-danger)] sm:col-span-2" role="alert">
                        {errors.valuationMethods}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </FormSection>

            <FormSection
              id="asset-media"
              sectionNumber={4}
              title="Lots & Media"
              description={`Create lots, select a grouping mode, and add up to ${MAX_ASSET_LOT_PHOTOS} main and report-only photos per lot.`}
              summary={`${mixedLots.length} lot${mixedLots.length === 1 ? "" : "s"} · ${mediaTotals.photos} photo${mediaTotals.photos === 1 ? "" : "s"}${mediaTotals.videos ? ` · ${mediaTotals.videos} video${mediaTotals.videos === 1 ? "" : "s"}` : ""}`}
              errorSummary={errors.media}
              status={errors.media ? "error" : mediaTotals.photos > 0 ? "complete" : "incomplete"}
              open={openSections.has("media")}
              onOpenChange={(open) => toggleSection("media", open)}
            >
              <div
                id="asset-media-workspace"
                tabIndex={-1}
                data-invalid={errors.media ? "true" : undefined}
                aria-invalid={Boolean(errors.media)}
                className="outline-none"
              >
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
                      Upload images in one sequence. Black images become lot
                      dividers and are removed from the report.
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
                  onChange={(lots) => {
                    setMixedLots(lots);
                    clearFieldError("media");
                  }}
                  allowVideo
                  maxImagesPerLot={MAX_ASSET_LOT_PHOTOS}
                  maxExtraImagesPerLot={MAX_ASSET_LOT_PHOTOS}
                  maxTotalImages={MAX_ASSET_LOT_PHOTOS}
                  analysisImageLimit={50}
                  sourceMappedLots={auctioneer?.kind === "scheduleA"}
                  downloadPrefix={(contractNo || "asset").replace(/[^a-zA-Z0-9_-]/g, "-")}
                />
              </div>
            </FormSection>
          </fieldset>
        </div>
      </div>

      <FormActionBar className={auctioneer && onAcceptedAndContinue ? undefined : "flex-nowrap"}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void saveDraftNow()}
            disabled={submitting || draftSaving || !userId || restoreBlocked}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            <span className="hidden min-[360px]:inline">
              {draftSaving ? "Saving..." : "Save draft"}
            </span>
            <span className="min-[360px]:hidden">Save</span>
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="More asset form actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(moreAnchor)}
            onClick={(event) => setMoreAnchor(event.currentTarget)}
            disabled={submitting || draftSaving || restoreBlocked}
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden sm:inline">
            <button type="button" className={quietButtonClass} onClick={onCancel} disabled={submitting || draftSaving}>
              Cancel
            </button>
          </span>
          {!(auctioneer && onAcceptedAndContinue) ? (
            <button type="submit" className={primaryButtonClass} disabled={submitting || draftSaving || restoreBlocked}>
              {submitting ? "Uploading…" : "Create report"}
            </button>
          ) : null}
        </div>
        {auctioneer && onAcceptedAndContinue ? (
          <AuctioneerContinueAction
            disabled={submitting || draftSaving || restoreBlocked}
            onClick={() => void onSubmit(undefined, true)}
          />
        ) : null}
        </FormActionBar>
      </div>

      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={() => setMoreAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <MenuItem onClick={() => void saveInputs()}>Save as reusable input</MenuItem>
        <MenuItem
          className="sm:!hidden"
          onClick={() => {
            setMoreAnchor(null);
            onCancel?.();
          }}
        >
          Cancel
        </MenuItem>
        <MenuItem
          sx={{ color: "var(--app-danger)" }}
          onClick={() => {
            setMoreAnchor(null);
            setDiscardOpen(true);
          }}
        >
          Discard draft and clear form
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={discardOpen}
        title="Discard this asset draft?"
        description="All report details, lots, annotations, photos, and videos in this draft will be removed. This cannot be undone."
        confirmLabel="Discard draft"
        tone="danger"
        busy={discarding}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => void discardDraft()}
      />

      <ActiveReportConflictDialog
        open={activeReportConflict}
        reportLabel="asset report"
        allowCreateSeparate={!auctioneer}
        onCancel={() => setActiveReportConflict(false)}
        onResume={() => {
          setActiveReportConflict(false);
          toast.info("The existing report is still processing. Check My Reports for its status.");
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
              : `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          forceNewSubmissionRef.current = true;
          window.setTimeout(() => void onSubmit(), 0);
        }}
      />

      <ConfirmDialog
        open={submissionManifestConflict && !auctioneer}
        title="Start a new upload?"
        description="The photos changed after the previous upload was stopped, so that upload identity cannot be reused safely. Start a new upload with the current form and media, or keep editing without submitting."
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
              : `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
        kind="asset"
        userId={userId}
        scopeId={draftScopeId}
        clientSubmissionId={draftScopeId}
        resumeSessionId={resumeDraft?.smartUploadSession}
        details={smartUploadDetails}
        onClose={() => setSmartUploadOpen(false)}
        onSubmitted={() => handleSmartUploadSubmitted()}
      />
    </form>
  );
});

export default AssetForm;
