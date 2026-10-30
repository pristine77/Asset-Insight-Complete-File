import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { cameraDeadline } from '../camera/cameraDeadline';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TextInput from './ListingTextInput';
import CurrencySelect from './CurrencySelect';
import useReportCurrency from './useReportCurrency';
import { Feather } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import OfflineCapturePanel from './OfflineCapturePanel';
import useDeviceDraftSave from './useDeviceDraftSave';
import DraftStorageStatus from './DraftStorageStatus';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { prepareOfflineSubmission } from '../../services/offlineSubmissionService';
import durableReportTransfer from '../../services/durableReportTransfer';
import durableContinuationService from '../../services/durableContinuationService';
import { assertReportUploadAccepted, isExistingReportUploadReceipt } from '../../services/reportUploadReceipt';
import { showUploadManifestRecovery, uploadConflictSource } from './uploadManifestRecovery';
import { createUploadOperation, pauseUploadOperation, type UploadOperation } from '../../services/uploadCancellation';
import backgroundUploadManager, {
  ALREADY_UPLOADING_MESSAGE,
  ALREADY_UPLOADING_TITLE,
  BACKGROUND_UPLOAD_BUSY_MESSAGE,
  WAITING_FOR_SIGNAL_MESSAGE,
  WAITING_FOR_SIGNAL_TITLE,
} from '../../services/backgroundUploadManager';
import { CAMERA_NOT_OPENED_TITLE, cameraOpenFailureButtons, describeCameraOpenFailure } from '../../utils/cameraOpenFailure';
import { UPLOAD_WAITING_FOR_CONNECTION } from '../../services/uploadResumePolicy';
import { useUploadAutoResume } from './useUploadAutoResume';
import { canResumeDraftSnapshot, uploadResumeDraftKey } from '../../services/uploadResumeDraft';
import UploadWaitingForSignal from './UploadWaitingForSignal';
import { needsExplicitUploadResume, setDraftCaptureMode } from '../../services/offlineDraftPolicy';
import CameraScreen from '../camera/NativeAuctionCameraScreen';
import { MixedLot, createNewLot } from '../camera/types';
import LotManager from './LotManager';
import lotListingService, { LotListingDetails, LotListingLot } from '../../services/lotListingService';
import reportDraftService, {
  getDuplicateLotWarning,
} from '../../services/reportDraftService';
import AutoSaveService, { AutoSaveData, AutoSaveFormData } from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import { getSubmissionError } from '../../services/connectivityService';
import type { DirectUploadProgress } from '../../services/directR2UploadService';
import { getPhotoUploadUri, normalizePhotoFile } from '../../utils/photoFileUtils';
import { DEFAULT_IMAGE_WATERMARK, restoreImageWatermarkPreference } from '../../utils/watermarkPreference';
import { getHiddenCurrentLocation, normalizeHiddenLocation } from '../../utils/mobileLocation';
import type {
  AuctionManagementDestination,
  AuctionManagementServiceItem,
  AuctionManagementTaskPayload,
} from '../../services/auctionManagementService';
import AuctioneerFormBoundary, { type AuctioneerFormControl } from './AuctioneerFormBoundary';
import AuctioneerFormHeader from './AuctioneerFormHeader';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import { acceptAuctioneerLots, auctioneerSeedLots, auctioneerLotSource, hasValidAuctioneerLotStructure, scheduleAItemLotField } from './auctioneerFormPolicy';
import ScheduleAItemPicker, { useScheduleAItemChoice } from './ScheduleAItemPicker';
import ProposalListPanel, { useProposalList } from './ProposalListPanel';
import { proposalLotPresentation, proposalLotsWithoutMedia, proposalLotsWithoutMediaPrompt } from './proposalListPolicy';

interface LotListingFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  draftIdToLoad?: string | null;
  onDraftLoaded?: () => void;
  auctionManagementTask?: AuctionManagementTaskPayload | null;
  auctioneer?: AuctioneerWorkItemSetup;
  onAuctioneerSetupChange?: (setup: AuctioneerWorkItemSetup) => void;
  auctioneerControl?: AuctioneerFormControl;
  /**
   * Hand an ordinary Submit to the background upload line and close the form
   * (services/backgroundUploadManager.ts). Off by default: only the Dashboard
   * turns it on, so every other caller keeps the foreground upload.
   */
  backgroundUploads?: boolean;
}

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type ValuationMethod = 'FML' | 'TKV' | 'OLV' | 'FLV';
const LOT_LISTING_VALUATION_METHODS: ValuationMethod[] = ['FML'];
/** The header controls are drawn smaller (2026-10-11); this keeps each touch area at 44 points or more. */
const HEADER_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 };

const LotListingFormSheet = ({
  visible,
  onClose,
  onSuccess,
  draftIdToLoad,
  onDraftLoaded,
  auctionManagementTask: suppliedAuctionManagementTask,
  auctioneerControl,
  backgroundUploads = false,
}: LotListingFormSheetProps) => {
  const auctioneer = auctioneerControl?.setup;
  const continuation = auctioneerControl?.continuationDetails;
  // owner 2026-10-28: one Schedule A item for every lot of this form, when the
  // setup requires it (never carried to the next form by Create Lot & Continue).
  const scheduleAItem = useScheduleAItemChoice(auctioneer);
  const restoreScheduleAItem = scheduleAItem.restore;
  const [recoveredAuctionTask, setRecoveredAuctionTask] = useState<AuctionManagementTaskPayload>();
  const auctionManagementTask = suppliedAuctionManagementTask || recoveredAuctionTask;

  // Form fields
  const [contractNo, setContractNo] = useState(auctioneer?.contract.contractNo || '');
  const [salesDate, setSalesDate] = useState(continuation?.salesDate ?? (auctioneer?.contract.eventDate?.slice(0, 10) || isoDate(new Date())));
  const [location, setLocation] = useState(() => normalizeHiddenLocation(continuation?.location ?? auctioneer?.contract.location).location);
  const [latitude, setLatitude] = useState<number | undefined>(continuation?.latitude);
  const [longitude, setLongitude] = useState<number | undefined>(continuation?.longitude);
  const { currency, setCurrency, resetCurrency } = useReportCurrency({ initialCurrency: continuation?.currency, location, latitude, longitude, visible, paused: Boolean(draftIdToLoad) });
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(continuation?.bankPhotosEnabled ?? false);
  const [watermarkImages, setWatermarkImages] = useState(continuation?.watermarkImages ?? DEFAULT_IMAGE_WATERMARK);
  const [auctionCloseContract, setAuctionCloseContract] = useState(false);
  const [auctionServiceSelections, setAuctionServiceSelections] = useState<Record<number, string[]>>({});

  // Lots with images (using MixedLot type for LotManager compatibility)
  const [lots, setLotsRaw] = useState<MixedLot[]>(() => auctioneer ? auctioneerSeedLots(auctioneer) : []);
  const setLots = useCallback<React.Dispatch<React.SetStateAction<MixedLot[]>>>((update) => {
    setLotsRaw((previous) => {
      const next = typeof update === 'function' ? update(previous) : update;
      return acceptAuctioneerLots(auctioneer, previous, next);
    });
  }, [auctioneer]);
  const [activeLotIdx, setActiveLotIdx] = useState(0);
  // owner 2026-10-28: a Proposal worked from its list; inert for every other setup.
  const proposalList = useProposalList({ setup: auctioneer, lots, setLots, setActiveLotIdx, active: visible });
  const proposalLots = useMemo(
    () => proposalLotPresentation(auctioneer, lots, proposalList.items),
    [auctioneer, lots, proposalList.items]
  );

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [pausingUpload, setPausingUpload] = useState(false);
  const pauseRequestedRef = useRef(false);
  const uploadAcceptedRef = useRef(false);
  const [savingDraftPreview, setSavingDraftPreview] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<DirectUploadProgress | null>(null);

  // Details section expanded state (default expanded)
  const [detailsExpanded, setDetailsExpanded] = useState(true);

  // Auto-save state
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [autoSaveInfo, setAutoSaveInfo] = useState<{
    savedAt?: string;
    totalImages?: number;
    totalLots?: number;
  } | null>(null);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const draftIdentityRef = useRef(randomUUID());
  const [captureMode, setCaptureMode] = useState<'online' | 'offline'>('online');
  const [manualSubmissionRequired, setManualSubmissionRequired] = useState(false);
  const [reviewingSavedDraft, setReviewingSavedDraft] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState<string>();
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
  const reviewEventRef = useRef(randomUUID());
  const saveOnly = captureMode === 'offline' && !reviewingSavedDraft;
  const compactAuctioneerActions = Boolean(auctioneer && captureMode !== 'offline');
  const [localSavedAt, setLocalSavedAt] = useState<string>();
  const [localSaveError, setLocalSaveError] = useState<string>();
  const [uploadPaused, setUploadPaused] = useState(false);
  const changeCaptureMode = (mode: 'online' | 'offline') => {
    setDraftCaptureMode(currentDraftId || draftIdentityRef.current, mode);
    if (mode === 'offline') setManualSubmissionRequired(true);
    setCaptureMode(mode);
  };
  const submissionIdRef = useRef<string | null>(auctioneer?.clientSubmissionId || null);
  const supersedesSubmissionIdRef = useRef<string | undefined>(undefined);
  const recoveryScopeRef = useRef(0);
  useEffect(() => {
    recoveryScopeRef.current += 1;
    return () => { recoveryScopeRef.current += 1; };
  }, [visible, draftIdToLoad, auctioneer?.workItemId]);
  const submissionLockRef = useRef(false);
  // The operation of the upload this form is running, so Pause stops only it.
  const activeOperationRef = useRef<UploadOperation | null>(null);
  const handlePauseUpload = () => {
    // Finalizing is when the server accepts the listing; pausing then only loses
    // the answer. See beginUploadFinalization in uploadCancellation.ts.
    if (!submissionLockRef.current || pauseRequestedRef.current || uploadAcceptedRef.current || uploadStatus?.stage === 'complete'
      || uploadStatus?.stage === 'finalizing') return;
    pauseRequestedRef.current = true;
    setPausingUpload(true);
    // This form's upload only: a background upload of another report keeps
    // going (2026-10-02). A global pause (Offline mode, sign-out) still stops
    // this operation as well.
    pauseUploadOperation(activeOperationRef.current);
  };
  // An upload the app stopped by itself (no connection at Submit, lost signal,
  // stalled transfer) continues once the connection is steady, while this
  // listing stays open (useUploadAutoResume; owner decision 2026-10-11,
  // restoring 2026-10-02). handleSubmitRef gives that later resume the handler
  // from the latest render.
  const autoResume = useUploadAutoResume(visible, async () => (await OfflineQueueService.getConnectivityStatus()).status === 'online');
  const handleSubmitRef = useRef<(destination?: AuctionManagementDestination, options?: { nextLot?: boolean; automaticResume?: boolean }) => Promise<void>>(async () => undefined);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadedDraftIdRef = useRef<string | null>(null);
  const awaitingDraft = Boolean(draftIdToLoad && loadedDraftIdRef.current !== draftIdToLoad);
  const draftSavePromiseRef = useRef<Promise<unknown> | null>(null);
  const isAuctionManagementMode = Boolean(auctionManagementTask);
  const auctionServices = useMemo(() => {
    return (auctionManagementTask?.serviceCatalog || []).flatMap((catalog) =>
      (catalog.services || []).map((service) => ({
        ...service,
        catalogName: catalog.name || catalog.contractCode || 'Services',
      }))
    );
  }, [auctionManagementTask?.serviceCatalog]);
  const auctionServiceById = useMemo(() => {
    return new Map(auctionServices.map((service) => [service.rowGuid, service]));
  }, [auctionServices]);
  const activeSeedLot = auctionManagementTask?.lots?.[activeLotIdx];
  const auctionCustomerName =
    auctionManagementTask?.customer?.name ||
    auctionManagementTask?.customer?.company ||
    'Customer not set';
  const auctionLocationLabel =
    auctionManagementTask?.event?.location ||
    auctionManagementTask?.contract?.saleLocation ||
    auctionManagementTask?.customer?.address ||
    location ||
    'Location not set';

  const clearError = (key: string) => {
    setErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  useEffect(() => {
    if (!visible || !auctionManagementTask || draftIdToLoad || loadedDraftIdRef.current) return;
    const eventDate = auctionManagementTask.event?.eventDate || new Date().toISOString();
    const taskLocation = normalizeHiddenLocation(
      auctionManagementTask.event?.location ||
        auctionManagementTask.contract?.saleLocation ||
        auctionManagementTask.customer?.address ||
        undefined
    );
    const seedLots =
      auctionManagementTask.lots.length > 0
        ? auctionManagementTask.lots
        : [{
            id: `${auctionManagementTask.task.rowGuid}:lot:1`,
            label: 'Lot 1',
            source: 'manual',
            lotNumber: '1',
            description: 'Lot 1',
            selectedServiceIds: [],
          }];

    setContractNo(String(auctionManagementTask.contract?.contractNumber || ''));
    setSalesDate(eventDate.slice(0, 10));
    setLocation(taskLocation.location);
    setLatitude(taskLocation.latitude);
    setLongitude(taskLocation.longitude);
    setBankPhotosEnabled(false);
    setWatermarkImages(DEFAULT_IMAGE_WATERMARK);
    setLots(seedLots.map((seedLot, index) => ({
      ...createNewLot(),
      id: `auctionsoft-${seedLot.id || index}`,
      mode: 'single_lot',
    })));
    setActiveLotIdx(0);
    setAuctionCloseContract(false);
    setAuctionServiceSelections(
      Object.fromEntries(
        seedLots.map((seedLot, index) => [index, Array.isArray(seedLot.selectedServiceIds) ? seedLot.selectedServiceIds : []])
      )
    );
    setDetailsExpanded(true);
    setErrors({});
  }, [auctionManagementTask, visible, setLots]);

  // Keep legacy single autosave recoverable through the Offline Reports page.
  useEffect(() => {
    if (visible && !draftIdToLoad && !auctionManagementTask) {
      void AutoSaveService.migrateLegacyAutoSaveIfNeeded();
    }
  }, [auctionManagementTask, visible, draftIdToLoad]);

  const checkForAutoSave = async () => {
    try {
      const summary = await AutoSaveService.getAutoSaveSummary();
      if (summary.exists && summary.formType === 'lotListing' && summary.totalImages && summary.totalImages > 0) {
        setAutoSaveInfo({
          savedAt: summary.savedAt,
          totalImages: summary.totalImages,
          totalLots: summary.totalLots,
        });
        setShowRestorePrompt(true);
      }
    } catch (error) {
      console.error('Error checking auto-save:', error);
    }
  };

  const handleRestoreAutoSave = async () => {
    try {
      const data = await AutoSaveService.getAutoSave();
      if (data && data.formType === 'lotListing') {
        // Restore form data
        if (data.formData.contractNo) setContractNo(data.formData.contractNo);
        if (data.formData.effectiveDate) setSalesDate(data.formData.effectiveDate);
        if (data.formData.currency) setCurrency(data.formData.currency);
        if (typeof data.formData.bankPhotosEnabled === 'boolean') {
          setBankPhotosEnabled(data.formData.bankPhotosEnabled);
        }
        setWatermarkImages(restoreImageWatermarkPreference(data.formData.watermarkImages));
        if (
          data.formData.location ||
          data.formData.latitude !== undefined ||
          data.formData.longitude !== undefined
        ) {
          const restoredLocation = normalizeHiddenLocation(
            data.formData.location,
            data.formData.latitude,
            data.formData.longitude
          );
          setLocation(restoredLocation.location);
          setLatitude(restoredLocation.latitude);
          setLongitude(restoredLocation.longitude);
        }
        // Restore lots with images
        const restoredLots: MixedLot[] = data.lots.map((savedLot) => ({
          id: savedLot.id,
          mode: savedLot.mode,
          files: savedLot.mainImages.map((file, i) =>
            normalizePhotoFile(
              typeof file === 'string'
                ? {
                    uri: file,
                    originalUri: file,
                    name: `restored-main-${i}.jpg`,
                    type: 'image/jpeg' as const,
                  }
                : {
                    ...file,
                    name: file.name || `restored-main-${i}.jpg`,
                    type: file.type || 'image/jpeg',
                  }
            )
          ),
          extraFiles: savedLot.extraImages.map((file, i) =>
            normalizePhotoFile(
              typeof file === 'string'
                ? {
                    uri: file,
                    originalUri: file,
                    name: `restored-extra-${i}.jpg`,
                    type: 'image/jpeg' as const,
                  }
                : {
                    ...file,
                    name: file.name || `restored-extra-${i}.jpg`,
                    type: file.type || 'image/jpeg',
                  }
            )
          ),
          videoFile:
            savedLot.videoFiles.length > 0
              ? typeof savedLot.videoFiles[0] === 'string'
                ? {
                    uri: savedLot.videoFiles[0],
                    name: 'restored-video.mp4',
                    type: 'video/mp4' as const,
                  }
                : {
                    ...savedLot.videoFiles[0],
                    uri: savedLot.videoFiles[0].uri,
                    name: savedLot.videoFiles[0].name || 'restored-video.mp4',
                    type: savedLot.videoFiles[0].type || 'video/mp4',
                  }
              : undefined,
          coverIndex: savedLot.coverIndex,
        }));

        if (restoredLots.length > 0) {
          setLots(restoredLots);
          setActiveLotIdx(data.activeLotIdx >= 0 ? data.activeLotIdx : 0);
        }

        Alert.alert(
          'Restored',
          `Restored ${data.lots.reduce((sum, l) => sum + l.mainImages.length + l.extraImages.length, 0)} images from ${data.lots.length} lot(s).`
        );
      }
    } catch (error) {
      console.error('Error restoring auto-save:', error);
      Alert.alert('Error', 'Failed to restore saved data.');
    }
    setShowRestorePrompt(false);
  };

  const handleDiscardAutoSave = async () => {
    try {
      await AutoSaveService.deleteAutoSave();
    } catch (error) {
      console.error('Error deleting auto-save:', error);
    }
    setShowRestorePrompt(false);
  };

  const applyStoredDraftData = useCallback(
    (data: Pick<AutoSaveData, 'formData' | 'lots' | 'activeLotIdx'>) => {
      if (data.formData.auctionsoftSnapshot) setRecoveredAuctionTask(data.formData.auctionsoftSnapshot as AuctionManagementTaskPayload);
      if (data.formData.auctionServiceSelections) setAuctionServiceSelections(data.formData.auctionServiceSelections as Record<number, string[]>);
      if (typeof data.formData.auctionCloseContract === 'boolean') setAuctionCloseContract(data.formData.auctionCloseContract);
      setCaptureMode(((data as any).captureMode || data.formData.captureMode) === 'offline' ? 'offline' : 'online');
      setManualSubmissionRequired(Boolean((data as any).manualSubmissionRequired || data.formData.manualSubmissionRequired || (data as any).captureMode === 'offline' || data.formData.captureMode === 'offline'));
      setUploadPaused(needsExplicitUploadResume((data as any).submissionState));
      if ((data as any).id) draftIdentityRef.current = (data as any).id;
      setLocalSavedAt((data as any).updatedAt);
      if (data.formData.contractNo) setContractNo(data.formData.contractNo);
      if (data.formData.clientSubmissionId) {
        submissionIdRef.current = data.formData.clientSubmissionId;
      }
      supersedesSubmissionIdRef.current = data.formData.supersedesClientSubmissionId;
      // Kept only if the current (online: just refreshed) setup still offers it.
      restoreScheduleAItem(data.formData.scheduleAParentLotId);
      if (data.formData.effectiveDate) setSalesDate(data.formData.effectiveDate);
        if (data.formData.currency) setCurrency(data.formData.currency);
      if (data.formData.salesDate) setSalesDate(data.formData.salesDate);
      if (typeof data.formData.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.formData.bankPhotosEnabled);
      }
      setWatermarkImages(restoreImageWatermarkPreference(data.formData.watermarkImages));
      if (
        data.formData.location ||
        data.formData.latitude !== undefined ||
        data.formData.longitude !== undefined
      ) {
        const restoredLocation = normalizeHiddenLocation(
          data.formData.location,
          data.formData.latitude,
          data.formData.longitude
        );
        setLocation(restoredLocation.location);
        setLatitude(restoredLocation.latitude);
        setLongitude(restoredLocation.longitude);
      }
      const restoredLots: MixedLot[] = data.lots.map((savedLot) => ({
        id: savedLot.id,
        lotNumber: savedLot.lotNumber,
        title: savedLot.title,
        mode: savedLot.mode,
        files: savedLot.mainImages.map((file, i) =>
          normalizePhotoFile(
            typeof file === 'string'
              ? {
                  uri: file,
                  originalUri: file,
                  name: `restored-main-${i}.jpg`,
                  type: 'image/jpeg' as const,
                }
              : {
                  ...file,
                  name: file.name || `restored-main-${i}.jpg`,
                  type: file.type || 'image/jpeg',
                }
          )
        ),
        extraFiles: savedLot.extraImages.map((file, i) =>
          normalizePhotoFile(
            typeof file === 'string'
              ? {
                  uri: file,
                  originalUri: file,
                  name: `restored-extra-${i}.jpg`,
                  type: 'image/jpeg' as const,
                }
              : {
                  ...file,
                  name: file.name || `restored-extra-${i}.jpg`,
                  type: file.type || 'image/jpeg',
                }
          )
        ),
        videoFile:
          savedLot.videoFiles.length > 0
            ? typeof savedLot.videoFiles[0] === 'string'
              ? {
                  uri: savedLot.videoFiles[0],
                  name: 'restored-video.mp4',
                  type: 'video/mp4' as const,
                }
              : {
                  ...savedLot.videoFiles[0],
                  uri: savedLot.videoFiles[0].uri,
                  name: savedLot.videoFiles[0].name || 'restored-video.mp4',
                  type: savedLot.videoFiles[0].type || 'video/mp4',
                }
            : undefined,
        coverIndex: savedLot.coverIndex,
      }));

      setLots(restoredLots);
      setActiveLotIdx(Math.max(0, Math.min(data.activeLotIdx || 0, restoredLots.length - 1)));
    },
    [setLots, setCurrency, restoreScheduleAItem]
  );

  useEffect(() => {
    if (!visible || !draftIdToLoad || loadedDraftIdRef.current === draftIdToLoad) return;

    let cancelled = false;
    const loadDraft = async () => {
      const owner = OfflineCaptureStore.getOwnerId();
      setDraftLoadError(undefined);
      try {
        // A draft queued or uploading in the background is not opened here:
        // edits would change photos and identity under an upload on its way.
        if (backgroundUploadManager.isBusy(draftIdToLoad)) throw new Error(BACKGROUND_UPLOAD_BUSY_MESSAGE);
        // A paused or needs-attention background upload belongs to this form now.
        backgroundUploadManager.forget(draftIdToLoad);
        const draft = await AutoSaveService.getDraft(draftIdToLoad);
        if (cancelled) return;
        if (!owner || owner !== OfflineCaptureStore.getOwnerId()) throw new Error('The account changed. Reopen this draft from its owner account.');
        if (!draft || draft.type !== 'lotListing') throw new Error('This saved draft is unavailable. No new report has been created.');
        const offlineReview = Boolean(draft.captureMode === 'offline' || draft.manualSubmissionRequired || draft.formData.captureMode === 'offline' || draft.formData.manualSubmissionRequired);
        if (offlineReview) {
          await OfflineCaptureStore.recordDraftOpened(draft.id, reviewEventRef.current);
          if (cancelled) return;
          if (owner !== OfflineCaptureStore.getOwnerId()) throw new Error('The account changed. Reopen this draft from its owner account.');
        }
        applyStoredDraftData(draft);
        setCurrentDraftId(draft.id);
        loadedDraftIdRef.current = draft.id;
        setReviewingSavedDraft(offlineReview);
        onDraftLoaded?.();
      } catch (error) {
        if (!cancelled) setDraftLoadError(error instanceof Error ? error.message : 'Failed to open offline draft. Try again.');
      }
    };

    void loadDraft();
    return () => {
      cancelled = true;
    };
  }, [applyStoredDraftData, draftIdToLoad, onDraftLoaded, visible, draftLoadAttempt]);

  const buildAutoSaveFormData = useCallback(
    (): AutoSaveFormData => ({
      captureMode,
      manualSubmissionRequired,
      // A "Check again" list replaces the snapshot's, so an item chosen from it
      // is still offered when this draft is reopened offline.
      // A Proposal list refreshed here (Refresh, Not found) does the same.
      auctioneerSnapshot: auctioneer
        ? {
            ...auctioneer,
            ...(scheduleAItem.required ? { scheduleAChoices: scheduleAItem.choices } : {}),
            ...(proposalList.listed ? { proposalList: { items: proposalList.items } } : {}),
          }
        : undefined,
      auctionsoftSnapshot: auctionManagementTask ? { ...auctionManagementTask } : undefined,
      auctionServiceSelections,
      auctionCloseContract,
      auctioneerWorkItemId: auctioneer?.workItemId,
      // Written (even when empty) only where a Schedule A item is required, so
      // a withdrawn choice is cleared and other drafts stay exactly as before.
      ...(scheduleAItem.required ? { scheduleAParentLotId: scheduleAItem.parentLotId } : {}),
      clientSubmissionId:
        submissionIdRef.current ||
        (submissionIdRef.current = `ll-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
      supersedesClientSubmissionId: supersedesSubmissionIdRef.current,
      contractNo,
      effectiveDate: salesDate,
      salesDate,
      currency,
      location,
      latitude,
      longitude,
      bankPhotosEnabled,
      watermarkImages,
      selectedValuationMethods: LOT_LISTING_VALUATION_METHODS,
    }),
    [auctioneer, scheduleAItem.required, scheduleAItem.choices, scheduleAItem.parentLotId, proposalList.listed, proposalList.items, auctionManagementTask, auctionServiceSelections, auctionCloseContract, captureMode, manualSubmissionRequired, bankPhotosEnabled, contractNo, latitude, location, longitude, salesDate, currency, watermarkImages]
  );

  const hasDraftableWork = useCallback((candidateLots: MixedLot[] = lots) => {
    const hasImages = candidateLots.some((l) => l.files.length > 0 || l.extraFiles.length > 0 || l.videoFile);
    const hasLots = candidateLots.length > 0;
    const hasDetails = Boolean(contractNo.trim());
    return hasImages || hasLots || hasDetails;
  }, [contractNo, lots]);

  const requireContractNumberForDraft = useCallback(() => {
    if (contractNo.trim() || captureMode === 'offline') return true;
    Alert.alert(
      'Contract Number Required',
      'Enter a contract number before continuing, or choose Offline to save incomplete details on this device.'
    );
    return false;
  }, [contractNo, captureMode]);

  const saveCurrentDraftNow = useCallback(async (
    lotsSnapshot: MixedLot[] = lots,
    activeLotIdxSnapshot: number = activeLotIdx,
    draftIdOverride?: string,
    explicitActivitySave = false
  ) => {
    if (!hasValidAuctioneerLotStructure(auctioneer, lotsSnapshot)) throw new Error('Schedule A lots cannot be added, removed, reordered or regrouped.');
    if (captureMode !== 'offline' && (!hasDraftableWork(lotsSnapshot) || !contractNo.trim())) return null;

    const savePromise = AutoSaveService.saveDraft({
      explicitActivitySave,
      id: draftIdOverride || currentDraftId || draftIdentityRef.current,
      captureMode,
      type: 'lotListing',
      title: contractNo.trim() || 'Lot Listing',
      formData: buildAutoSaveFormData(),
      lots: lotsSnapshot.map((lot, index) => ({ ...lot,
        lotNumber: lot.lotNumber || (auctioneer?.kind === 'scheduleA' ? auctioneer.lots[index]?.lotNumber : undefined),
        title: lot.title || (auctioneer?.kind === 'scheduleA' ? auctioneer.lots[index]?.title : undefined),
      })),
      activeLotIdx: activeLotIdxSnapshot,
    });

    draftSavePromiseRef.current = savePromise;
    try {
      const draft = await savePromise;
      draftIdentityRef.current = draft.id;
      setLocalSavedAt(draft.updatedAt); setLocalSaveError(undefined);
      if (currentDraftId !== draft.id) setCurrentDraftId(draft.id);
      return draft;
    } catch (error) {
      setLocalSaveError(error instanceof Error ? error.message : 'Could not save. Keep this form open and retry.');
      throw error;
    } finally {
      if (draftSavePromiseRef.current === savePromise) {
        draftSavePromiseRef.current = null;
      }
    }
  }, [activeLotIdx, auctioneer, buildAutoSaveFormData, contractNo, currentDraftId, hasDraftableWork, lots, captureMode]);

  const saveExplicitLocalDraft = useCallback(() => saveCurrentDraftNow(lots, activeLotIdx, undefined, true), [saveCurrentDraftNow, lots, activeLotIdx]);
  const { saving: savingLocal, saveOnDevice, saveLock } = useDeviceDraftSave(saveExplicitLocalDraft, draftSavePromiseRef, autoSaveTimeoutRef);

  const handleSaveDraftPreview = useCallback(async () => {
    if (awaitingDraft || submitting) return;
    if (captureMode === 'offline' || manualSubmissionRequired) {
      try { await saveOnDevice(); } catch (error) { setLocalSaveError(error instanceof Error ? error.message : 'Save failed. Please try again.'); }
      return;
    }
    if (auctioneer || savingDraftPreview || submitting || isAuctionManagementMode) return;
    if (!requireContractNumberForDraft()) return;

    const imageCount = lots.reduce(
      (sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0),
      0
    );
    if (imageCount === 0) {
      Alert.alert('Images Required', 'Add at least one image before creating a draft preview.');
      return;
    }

    const operation = createUploadOperation();
    const attemptOwner = OfflineCaptureStore.getOwnerId();
    setSavingDraftPreview(true);
    try {
      // Explicit draft preview creation uploads and verifies media; normal autosave stays local-only.
      const localDraft = await saveCurrentDraftNow(lots, activeLotIdx, undefined, true);
      operation.assertActive();
      if (!localDraft) throw new Error('The draft could not be saved.');
      const cloudDraft = await reportDraftService.upsertFromLocalDraft(localDraft);
      operation.assertActive();
      const cloudDraftId = cloudDraft.id || cloudDraft._id;
      if (!cloudDraftId) throw new Error('The cloud draft could not be identified.');
      const duplicateWarning = getDuplicateLotWarning(cloudDraft);
      if (duplicateWarning) {
        Alert.alert('Duplicate Lot Detected', duplicateWarning);
        return;
      }
      await reportDraftService.processPreview(cloudDraftId);
      operation.assertActive();
      Alert.alert(
        'Draft Preview Started',
        'Your draft is safe in cloud storage and is being processed. Track it in Previews > Draft Previews. You can continue editing the original draft later.'
      );
    } catch (error: any) {
      if (OfflineCaptureStore.getOwnerId() !== attemptOwner) return;
      const duplicateWarning = getDuplicateLotWarning(error);
      Alert.alert(
        duplicateWarning ? 'Duplicate Lot Detected' : 'Draft Preview Not Started',
        duplicateWarning || getSubmissionError(error, 'Save Draft').message
      );
    } finally {
      setSavingDraftPreview(false);
    }
  }, [
    auctioneer,
    activeLotIdx,
    captureMode,
    manualSubmissionRequired,
    isAuctionManagementMode,
    lots,
    requireContractNumberForDraft,
    saveCurrentDraftNow,
    saveOnDevice,
    awaitingDraft,
    savingDraftPreview,
    submitting,
  ]);

  useEffect(() => {
    if (!visible || auctioneer) return;

    let cancelled = false;
    void getHiddenCurrentLocation().then((snapshot) => {
      if (cancelled) return;
      setLocation((current) => current.trim() || snapshot.location);
      if (snapshot.latitude !== undefined && snapshot.longitude !== undefined) {
        setLatitude((current) => current ?? snapshot.latitude);
        setLongitude((current) => current ?? snapshot.longitude);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [visible, auctioneer]);

  // Auto-save form data and images
  const triggerAutoSave = useCallback(async (
    lotsSnapshot?: MixedLot[],
    activeLotIdxSnapshot?: number
  ) => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    if (lotsSnapshot) {
      try {
        await saveCurrentDraftNow(lotsSnapshot, activeLotIdxSnapshot ?? activeLotIdx);
        console.log(
          '[LotListing] Camera draft saved',
          lotsSnapshot.reduce((s, l) => s + l.files.length + l.extraFiles.length, 0),
          'images'
        );
      } catch (error) {
        console.error('Camera draft save error:', error);
        throw error;
      }
      return;
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveCurrentDraftNow();
        console.log('[LotListing] Auto-saved', lots.reduce((s, l) => s + l.files.length, 0), 'images');
      } catch (error) {
        console.error('Auto-save error:', error);
      }
    }, 2000);
  }, [activeLotIdx, lots, saveCurrentDraftNow]);

  // Trigger auto-save when form fields or lots change after a contract number exists.
  useEffect(() => {
    if (visible && !submitting && !savingLocal && !awaitingDraft && (captureMode === 'offline' || (contractNo.trim() && hasDraftableWork()))) {
      triggerAutoSave();
    }
    return () => { if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current); };
  }, [contractNo, hasDraftableWork, triggerAutoSave, visible, captureMode, submitting, savingLocal, awaitingDraft]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  const toggleAuctionService = useCallback((lotIndex: number, serviceId: string) => {
    setAuctionServiceSelections((prev) => {
      const current = new Set(prev[lotIndex] || []);
      if (current.has(serviceId)) {
        current.delete(serviceId);
      } else {
        current.add(serviceId);
      }
      return { ...prev, [lotIndex]: Array.from(current) };
    });
  }, []);

  const serializeAuctionService = useCallback((service?: AuctionManagementServiceItem & { catalogName?: string }) => {
    if (!service) return null;
    return {
      revenueContractId: service.revenueContractId,
      revenueContractServiceId: service.rowGuid,
      serviceName: service.serviceName,
      price: Number(String(service.defaultPrice ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      gstPercent: Number(String(service.gstPercent ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      pstPercent: Number(String(service.pstPercent ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      quantity: 1,
    };
  }, []);

  const buildAuctionsoftMetadata = useCallback((destination: AuctionManagementDestination) => {
    if (!auctionManagementTask) return undefined;
    return {
      taskId: auctionManagementTask.task.rowGuid,
      contractId: auctionManagementTask.contract.rowGuid,
      contractNumber: auctionManagementTask.contract.contractNumber,
      destination,
      closeContract: auctionCloseContract,
      seedLots: auctionManagementTask.lots,
      selectedServicesByLot: lots.map((lot, index) => {
        const seedLot = auctionManagementTask.lots[index];
        return {
          lotIndex: index,
          lotId: lot.id,
          seedLotId: seedLot?.id,
          sourceLotId: seedLot?.sourceLotId,
          scheduleALotId: seedLot?.scheduleALotId,
          selectedServices: (auctionServiceSelections[index] || [])
            .map((serviceId) => serializeAuctionService(auctionServiceById.get(serviceId)))
            .filter(Boolean),
        };
      }),
    };
  }, [
    auctionCloseContract,
    auctionManagementTask,
    auctionServiceById,
    auctionServiceSelections,
    lots,
    serializeAuctionService,
  ]);

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!contractNo.trim()) e.contractNo = 'Required';
    const totalImages = lots.reduce((sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0), 0);
    if (totalImages === 0) e.images = 'Add at least one image';

    // Check that all lots have a mode set
    const lotsWithoutMode = lots.filter(lot => !lot.mode);
    if (lotsWithoutMode.length > 0) e.mode = 'All lots must have a mode selected';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // Create a new lot and return its index
  const handleCreateLot = useCallback(() => {
    if (auctioneer?.kind === 'scheduleA') return -1;
    if (!requireContractNumberForDraft()) return -1;
    const newLot = createNewLot();
    setLots((prev) => [...prev, newLot]);
    const newIdx = lots.length;
    if (isAuctionManagementMode) {
      setAuctionServiceSelections((prev) => ({ ...prev, [newIdx]: [] }));
    }
    setActiveLotIdx(newIdx);
    return newIdx;
  }, [auctioneer?.kind, isAuctionManagementMode, lots.length, requireContractNumberForDraft, setLots]);

  // Open camera for a specific lot. Try again (below) runs the handler from the
  // latest render, so it saves the form as it is when tapped.
  const handleOpenCameraRef = useRef<(lotIdx: number) => Promise<void>>(async () => undefined);
  const openingCameraRef = useRef(false);
  const handleOpenCamera = useCallback(async (lotIdx: number) => {
    if (openingCameraRef.current || cameraOpen) return;
    if (!requireContractNumberForDraft()) return;
    const owner = OfflineCaptureStore.getOwnerId();
    const scope = recoveryScopeRef.current;
    openingCameraRef.current = true;
    try {
      if (!await cameraDeadline(saveCurrentDraftNow(), 20_000)) return;
    } catch (error) {
      // Say why instead of ignoring the tap, and offer Try again
      // (cameraOpenFailure.ts). The retry does nothing once the account or
      // this form changed, like the other delayed alert buttons here.
      if (OfflineCaptureStore.getOwnerId() !== owner || recoveryScopeRef.current !== scope) return;
      Alert.alert(CAMERA_NOT_OPENED_TITLE, describeCameraOpenFailure(error), cameraOpenFailureButtons(() => {
        if (OfflineCaptureStore.getOwnerId() !== owner || recoveryScopeRef.current !== scope) return;
        void handleOpenCameraRef.current(lotIdx);
      }));
      return;
    } finally { openingCameraRef.current = false; }
    if (OfflineCaptureStore.getOwnerId() !== owner || recoveryScopeRef.current !== scope) return;
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
  }, [cameraOpen, requireContractNumberForDraft, saveCurrentDraftNow]);
  handleOpenCameraRef.current = handleOpenCamera;

  const handleCameraClose = useCallback(() => {
    setCameraOpen(false);
    clearError('images');
  }, []);

  const handleSubmit = async (
    destination: AuctionManagementDestination = 'LottingBoard',
    options: { forceNew?: boolean; nextLot?: boolean; replaceSubmissionId?: string; replacementSourceId?: string; newSubmissionFromId?: string; automaticResume?: boolean } = {}
  ) => {
    if (submissionLockRef.current || saveLock.current || awaitingDraft || submitting || uploadAcceptedRef.current || auctioneerControl?.accepted) return;
    if (options.nextLot && captureMode === 'offline') return;
    if (saveOnly) { await handleSaveOfflineAndClose(); return; }
    if (auctioneer && (options.forceNew || !hasValidAuctioneerLotStructure(auctioneer, lots))) return;
    if (options.replaceSubmissionId && (auctioneer || submissionIdRef.current !== options.replaceSubmissionId)) return;
    if (options.newSubmissionFromId && (auctioneer || submissionIdRef.current !== options.newSubmissionFromId)) return;
    if (!validateForm()) {
      // Offline captures may be saved without a contract number; say where to add it.
      if (!contractNo.trim()) setDetailsExpanded(true);
      Alert.alert('Validation Error', contractNo.trim() ? 'Please fix the required fields' : 'Enter the contract number in Listing Details, then tap Submit.');
      return;
    }
    // owner 2026-10-28: no lot on a Schedule A contract is sent without its
    // Schedule A item (the picker sits above Listing Details).
    const scheduleABlock = scheduleAItem.blockSubmit();
    if (scheduleABlock) {
      Alert.alert('Schedule A item required', scheduleABlock);
      return;
    }
    // owner 2026-10-28: a Proposal list form starts with a lot per listed item,
    // and every lot sent needs a photo. Empty ones are left out on purpose: a
    // listed item removed here simply stays to capture in Auctioneer.
    const lotsWithoutMedia = proposalLotsWithoutMedia(auctioneer, lots);
    if (lotsWithoutMedia.length) {
      const emptyIds = new Set(lotsWithoutMedia.map((lot) => lot.id));
      const remaining = lots.length - emptyIds.size;
      Alert.alert('Lots without photos', proposalLotsWithoutMediaPrompt(auctioneer, lots, proposalList.items), [
        { text: 'Keep capturing', style: 'cancel' },
        { text: 'Remove them', style: 'destructive', onPress: () => {
          setLots((previous) => previous.filter((lot) => !emptyIds.has(lot.id)));
          setActiveLotIdx((index) => Math.max(0, Math.min(index, remaining - 1)));
        } },
      ]);
      return;
    }

    const submissionFileCount = lots.reduce(
      (sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0) + (lot.videoFile ? 1 : 0),
      0
    );
    // Legacy in-app hand-off (services/backgroundUploadManager.ts):
    // an ordinary Submit or Resume from the Dashboard is saved, checked and
    // handed to the upload line, and the form closes. Incoming work and
    // Auction Management tasks keep waiting here for acceptance, and so do the
    // explicit separate/replace choices. A draft whose
    // last background attempt needs a decision runs here once, where the
    // prompts can appear; this attempt uses up that mark. Supported Android
    // device-file submissions use the durable scheduler below. Continue reserves
    // its independent next form after that durable handoff.
    // No connection (2026-10-11): an ordinary Submit that the line may take
    // waits there for signal on every build -- on durable builds too, where the
    // line then hands it to Android -- so the form can close. Everything else
    // waits in this open form (autoResume) and shows "Waiting for signal".
    const plannedDraftId = currentDraftId || draftIdentityRef.current;
    // Never save over, or send a second time, a draft the line is sending.
    if (backgroundUploadManager.isBusy(plannedDraftId)) {
      Alert.alert(ALREADY_UPLOADING_TITLE, ALREADY_UPLOADING_MESSAGE);
      return;
    }
    const durable = durableReportTransfer.available() && lots.every(lot =>
      [...lot.files, ...(lot.extraFiles || [])].every(file => /^(file|content):\/\//.test(getPhotoUploadUri(file))) &&
      (!lot.videoFile || /^(file|content):\/\//.test(lot.videoFile.uri)));
    let lineEligible = backgroundUploads && !auctioneer && !isAuctionManagementMode && !options.nextLot && !options.forceNew
      && !options.replaceSubmissionId && !options.newSubmissionFromId && !options.automaticResume;
    if (backgroundUploads && backgroundUploadManager.prefersForeground(plannedDraftId)) {
      lineEligible = false;
      backgroundUploadManager.consumeForegroundMark(plannedDraftId);
    }
    const background = !durable && lineEligible;
    // A person's Submit or Resume starts a fresh count of automatic tries.
    autoResume.beginAttempt(options.automaticResume === true);
    // Bind the user's explicit action across local preparation and transport.
    const operation = createUploadOperation();
    activeOperationRef.current = operation;
    const attemptOwner = OfflineCaptureStore.getOwnerId();
    const attemptRecoveryScope = recoveryScopeRef.current;
    submissionLockRef.current = true;
    pauseRequestedRef.current = false;
    uploadAcceptedRef.current = false;
    setPausingUpload(false);
    setSubmitting(true);
    setUploadProgress(1);
    setUploadStatus({
      percent: 1,
      stage: 'preparing',
      message: `Preparing ${submissionFileCount} ${submissionFileCount === 1 ? 'file' : 'files'}...`,
      completedFiles: 0,
      totalFiles: submissionFileCount,
      uploadedBytes: 0,
      totalBytes: 0,
    });

    let details: LotListingDetails | null = null;
    let serviceLots: LotListingLot[] | null = null;
    let attemptDraftId = currentDraftId || draftIdentityRef.current;
    let attemptDraftContent: string | undefined;
    let uploadAccepted = false;
    let draftSaved = false;
    const previousSubmissionId = submissionIdRef.current;
    const previousSupersedesId = supersedesSubmissionIdRef.current;

    try {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      const separateDraftId = options.forceNew || options.newSubmissionFromId ? randomUUID() : undefined;
      if (separateDraftId) {
        submissionIdRef.current = randomUUID();
        supersedesSubmissionIdRef.current = undefined;
        setDraftCaptureMode(separateDraftId, captureMode);
      }
      if (options.replaceSubmissionId) {
        supersedesSubmissionIdRef.current = options.replacementSourceId || options.replaceSubmissionId;
        submissionIdRef.current = randomUUID();
      }
      const localDraft = await saveCurrentDraftNow(lots, activeLotIdx, separateDraftId);
      if (!localDraft) throw new Error('Save this draft before submitting.');
      // Record the save before checking for a pause. A Pause tapped while the
      // draft was being saved is a pause: it used to be reported as "Draft not
      // saved -- check device storage" although the save had succeeded
      // (2026-10-02).
      draftSaved = true;
      attemptDraftId = localDraft.id;
      attemptDraftContent = uploadResumeDraftKey(localDraft);
      operation.assertActive();
      // Set when the phone reports no connection at all: an ordinary Submit then
      // goes to the upload line to wait for signal.
      let noConnection = false;
      try {
        await prepareOfflineSubmission(localDraft);
      } catch (error: any) {
        // The upload line waits for a connection by itself and re-runs every
        // other check on each attempt. Any other refusal stops here, as before.
        if (!lineEligible || error?.code !== UPLOAD_WAITING_FOR_CONNECTION) throw error;
        noConnection = true;
      }
      operation.assertActive();
      await OfflineCaptureStore.setSubmissionState(localDraft.id, 'ready');
      operation.assertActive();
      setUploadPaused(false);
      const jobId =
        submissionIdRef.current ||
        `ll-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      submissionIdRef.current = jobId;

      // Simple lot mapping for upload. The one chosen Schedule A item goes on
      // every lot of this form (owner 2026-10-28); nothing when not required.
      // A Proposal list's listed lot names its item by its own id (owner
      // 2026-10-28); every other lot sends what it always did.
      const mixedLots = lots.map((lot, index) => ({
        ...auctioneerLotSource(auctioneer, index, lot),
        ...scheduleAItemLotField(scheduleAItem.parentLotId),
        count: lot.files.length,
        extra_count: lot.extraFiles?.length || 0,
        video_count: lot.videoFile ? 1 : 0,
        cover_index: lot.coverIndex || 0,
        mode: lot.mode || 'single_lot',
      }));

      // Collect per-image focus box data (flat image index)
      const focusBoxes: Array<{ imageIndex: number; x: number; y: number; w: number; h: number }> = [];
      let flatImgIdx = 0;
      for (const lot of lots) {
        for (const f of lot.files) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
        for (const f of (lot.extraFiles || [])) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
      }

      details = {
        capture_id: localDraft.captureId,
        auctioneer_work_item_id: auctioneer?.workItemId,
        contract_no: contractNo.trim(),
        sales_date: salesDate,
        location: location.trim(),
        currency,
        latitude,
        longitude,
        include_damage_analysis: true,
        bank_photos_enabled: bankPhotosEnabled,
        watermark_images: watermarkImages,
        valuation_methods: LOT_LISTING_VALUATION_METHODS,
        mixed_lots: mixedLots,
        focus_boxes: focusBoxes.length > 0 ? focusBoxes : undefined,
        progress_id: jobId,
        client_submission_id: jobId,
        supersedes_client_submission_id: supersedesSubmissionIdRef.current,
        force_new: options.forceNew === true,
        auctionsoft: buildAuctionsoftMetadata(destination),
      };

      // Convert MixedLot to service format
      serviceLots = lots.map((lot, idx) => ({
        id: lot.id,
        files: lot.files.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type,
          size: f.size,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        extraFiles: (lot.extraFiles || []).map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type,
          size: f.size,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        videoFile: lot.videoFile ? {
          uri: lot.videoFile.uri,
          name: lot.videoFile.name,
          type: lot.videoFile.type || 'video/mp4',
          size: lot.videoFile.size,
        } : undefined,
        lot_number: idx + 1,
        mode: lot.mode,
        coverIndex: lot.coverIndex,
      }));

      // The same details and photos this form would send, frozen now.
      const queuedDetails = details;
      const queuedLots = serviceLots;
      const queueTitle = contractNo.trim() || 'Lot listing';
      /**
       * Hands this report to the upload line and closes the form. With
       * withDurableHandoff (Android durable builds), each attempt of the line
       * reserves the upload on the server and hands it to Android, which
       * continues it; the line then lets go (backgroundUploadManager.ts).
       */
      const handToLine = async (withDurableHandoff: boolean) => {
        if (!attemptOwner) throw new Error('Sign in to the account that owns this draft.');
        const handedOff = backgroundUploadManager.enqueue({
          draftId: localDraft.id,
          type: 'lotListing',
          ownerId: attemptOwner,
          title: queueTitle,
          totalFiles: submissionFileCount,
          draft: localDraft,
          upload: (onProgress, uploadOperation) =>
            lotListingService.createLotListing(queuedDetails, queuedLots, onProgress, {
              operation: uploadOperation,
              ...(withDurableHandoff ? { handoff: durableReportTransfer.handoff(localDraft, queueTitle) } : {}),
            }),
        });
        setSubmitting(false);
        if (!handedOff) {
          Alert.alert(ALREADY_UPLOADING_TITLE, ALREADY_UPLOADING_MESSAGE);
          return;
        }
        await resetForm();
        onClose();
        // With a connection there is no alert: the upload bar shows progress
        // and the outcome. Without one, say that it waits and sends by itself.
        if (noConnection) Alert.alert(WAITING_FOR_SIGNAL_TITLE, WAITING_FOR_SIGNAL_MESSAGE);
      };

      if (background) {
        await handToLine(false);
        return;
      }

      const offline = noConnection || (await OfflineQueueService.getConnectivityStatus()).status === 'offline';
      operation.assertActive();
      if (options.nextLot && offline) {
        setSubmitting(false);
        Alert.alert('Connection required', durable ? 'Keep this lot open and retry when online. The saved upload and its next lot need a short server reservation.' : 'Keep this lot open and retry when online. A new lot starts only after the server accepts this report.');
        return;
      }
      if (offline && lineEligible) {
        // Durable build, ordinary Submit: wait in the line, then hand to Android.
        noConnection = true;
        await handToLine(true);
        return;
      }
      if (offline) {
        // While this listing stays open it waits for the connection and starts
        // by itself (autoResume); this message shows only when it stops waiting.
        throw Object.assign(new Error('Saved on this device. Connect and tap Resume upload.'), { code: UPLOAD_WAITING_FOR_CONNECTION });
      }

      const modernDraft = auctioneer ? await saveCurrentDraftNow() : null;
      if (modernDraft) attemptDraftContent = uploadResumeDraftKey(modernDraft);
      operation.assertActive();
      const acceptedResponse = await lotListingService.createLotListing(details, serviceLots, (progress, detail) => {
        if (!operation.isActive() || recoveryScopeRef.current !== attemptRecoveryScope || OfflineCaptureStore.getOwnerId() !== attemptOwner) return;
        setUploadProgress(progress);
        if (detail) setUploadStatus(detail);
        autoResume.noteProgress(detail?.completedFiles);
      }, { operation, ...(durable ? { handoff: options.nextLot && auctioneer
        ? durableContinuationService.handoff(localDraft, contractNo.trim() || 'Lot listing', auctioneer)
        : durableReportTransfer.handoff(localDraft, contractNo.trim() || 'Lot listing') } : {}) });
      operation.assertActive();
      if (acceptedResponse.backgroundStaged) {
        if (options.nextLot && auctioneerControl) { await auctioneerControl.continueQueued(localDraft.id); return; }
        setSubmitting(false); await resetForm(); onClose(); return;
      }
      assertReportUploadAccepted(acceptedResponse);
      uploadAccepted = true;
      uploadAcceptedRef.current = true;
      if (isExistingReportUploadReceipt(acceptedResponse)) {
        setSubmitting(false);
        setUploadPaused(true);
        Alert.alert('Earlier upload accepted', 'The server returned the earlier report, not confirmation of your current edits. This draft and its originals are kept. Open Reports or Previews to review the earlier report before making further changes.');
        return;
      }
      if (options.nextLot && auctioneerControl) {
        if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
        const acceptanceSaved = OfflineCaptureStore.setSubmissionState(localDraft.id, 'accepted', (acceptedResponse as any).reportId);
        void acceptanceSaved.catch(() => undefined); // Keep the original inventory if its local receipt cannot be saved.
        await auctioneerControl.acceptAndContinue(acceptedResponse, modernDraft?.id, buildAutoSaveFormData(), acceptanceSaved);
        return;
      }
      await OfflineCaptureStore.setSubmissionState(localDraft.id, 'accepted', (acceptedResponse as any).reportId);

      // Upload complete - close immediately, don't wait for server processing
      setSubmitting(false);
      await resetForm();
      await AutoSaveService.cleanupOrphanedMedia([], 0).catch(() => undefined);
      onClose();
      Alert.alert(
        'Upload Complete!',
        'Your images have been uploaded. You will receive an email when the files are ready.'
      );
      if (onSuccess) onSuccess();
    } catch (e: any) {
      console.error('Submit error:', e);
      if (OfflineCaptureStore.getOwnerId() !== attemptOwner) {
        setSubmitting(false);
        return;
      }
      if (durable && options.nextLot && auctioneerControl && draftSaved) {
        try {
          const intent = await durableContinuationService.forParent(attemptDraftId);
          if (intent && intent.stage !== 'prepared') { await auctioneerControl.continueQueued(attemptDraftId); return; }
        } catch {
          setSubmitting(false);
          Alert.alert('Continue needs checking', 'The saved upload status could not be read. Keep its originals and retry this Continue request from Drafts; do not submit another copy.');
          return;
        }
      }
      if (uploadAccepted) {
        setSubmitting(false);
        Alert.alert('Upload accepted', 'The server accepted this report. Open Previews to check its progress; local confirmation could not be refreshed.');
        return;
      }
      if (!draftSaved) {
        submissionIdRef.current = previousSubmissionId;
        supersedesSubmissionIdRef.current = previousSupersedesId;
        setSubmitting(false);
        Alert.alert('Draft not saved', 'Your latest changes could not be saved on this device. Keep this form and its originals open. Check device storage, then use Save on device before trying again. No upload was started.');
        return;
      }
      const conflictedSubmissionId = submissionIdRef.current;
      const canAct = () => operation.isActive() && recoveryScopeRef.current === attemptRecoveryScope && OfflineCaptureStore.getOwnerId() === attemptOwner && submissionIdRef.current === conflictedSubmissionId;

      if (!auctioneer && !supersedesSubmissionIdRef.current && e?.response?.status === 409 && e?.response?.data?.code === 'ACTIVE_REPORT_EXISTS') {
        setSubmitting(false);
        Alert.alert(
          'Report Already Processing',
          'A report for this contract is already queued or processing. Keep this draft and review it in Reports or Previews, or explicitly create a separate report with these photos.',
          [
            { text: 'Keep Draft', style: 'cancel' },
            {
              text: 'Create Separate',
              onPress: () => { if (canAct()) void handleSubmit(destination, { forceNew: true }); },
            },
          ]
        );
        return;
      }

      setUploadPaused(true);
      await OfflineCaptureStore.setSubmissionState(attemptDraftId, 'paused', undefined, e?.message).catch(() => undefined);
      setSubmitting(false);
      if (showUploadManifestRecovery(e, !auctioneer && conflictedSubmissionId ? {
        replace: () => {
          if (canAct()) void handleSubmit(destination, { replaceSubmissionId: conflictedSubmissionId, replacementSourceId: uploadConflictSource(e, conflictedSubmissionId) });
        },
        startSeparate: () => {
          if (canAct()) void handleSubmit(destination, { newSubmissionFromId: conflictedSubmissionId });
        },
      } : undefined)) return;
      // The app stopped this upload by itself: wait for a steady connection and
      // continue while this listing stays open. A Pause the person tapped stays.
      if (!pauseRequestedRef.current && autoResume.scheduleAfterFailure(e, {
        resume: (automatic) => { void handleSubmitRef.current(destination, { nextLot: options.nextLot, automaticResume: automatic }); },
        stillCurrent: async () => {
          const draft = await OfflineCaptureStore.getDraft(attemptDraftId);
          return Boolean(canResumeDraftSnapshot(draft, attemptDraftContent)
            && OfflineCaptureStore.getOwnerId() === attemptOwner && recoveryScopeRef.current === attemptRecoveryScope);
        },
      })) return;
      const feedback = OfflineQueueService.getSubmissionError(e);
      Alert.alert(feedback.title, feedback.message);
    } finally {
      submissionLockRef.current = false;
      if (activeOperationRef.current === operation) activeOperationRef.current = null;
      setPausingUpload(false);
    }
  };
  handleSubmitRef.current = handleSubmit;

  const resetForm = async () => {
    uploadAcceptedRef.current = false;
    setRecoveredAuctionTask(undefined);
    draftIdentityRef.current = randomUUID();
    setReviewingSavedDraft(false); setDraftLoadError(undefined); reviewEventRef.current = randomUUID();
    setCaptureMode('online'); setManualSubmissionRequired(false); setLocalSavedAt(undefined); setLocalSaveError(undefined); setUploadPaused(false);
    setContractNo('');
    setSalesDate(isoDate(new Date()));
    resetCurrency();
    setLocation(normalizeHiddenLocation().location);
    setLatitude(undefined);
    setLongitude(undefined);
    setBankPhotosEnabled(false);
    setWatermarkImages(DEFAULT_IMAGE_WATERMARK);
    setLots([]);
    setActiveLotIdx(0);
    setAuctionCloseContract(false);
    setAuctionServiceSelections({});
    scheduleAItem.choose(undefined);
    setUploadProgress(0);
    setUploadStatus(null);
    setErrors({});
    setCurrentDraftId(null);
    loadedDraftIdRef.current = null;
    submissionIdRef.current = null;
    supersedesSubmissionIdRef.current = undefined;
  };

  const handleClose = async () => {
    if (submitting || saveLock.current) return;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    if (hasDraftableWork() && !requireContractNumberForDraft()) return;
    try {
      if (draftSavePromiseRef.current) {
        await draftSavePromiseRef.current;
      }
      await saveCurrentDraftNow();
    } catch (error) {
      console.error('Error saving draft before close:', error);
      Alert.alert('Not saved', 'Keep this form open and retry saving. Your latest changes have not been saved.');
      return;
    }
    await resetForm();
    onClose();
  };

  const handleSaveOfflineAndClose = async () => {
    try {
      await saveOnDevice(() => {
        void resetForm();
        onClose();
        Alert.alert('Saved on this device', 'Open Drafts → Offline captures → Open and submit to review your saved work. On supported Android builds, check Photo cloud backup for backup progress. Your report has not been submitted.');
      });
    } catch (error) {
      setLocalSaveError(error instanceof Error ? error.message : 'Save failed. Please try again.');
      Alert.alert('Not saved', 'Keep this form open and retry saving. Your latest changes have not been saved.');
    }
  };

  const totalImages = lots.reduce((sum, lot) => sum + lot.files.length + (lot.extraFiles?.length || 0), 0);
  const canSubmit =
    contractNo.trim() &&
    totalImages > 0 &&
    lots.every(lot => lot.mode);
  // A reopened offline capture often has no contract number yet. Submit stays
  // tappable once there are photos so validation can say what is missing; a
  // greyed-out button left people unable to submit (2026-10-26).
  const canTapSubmit = totalImages > 0;
  const canSaveDraftPreview = Boolean(contractNo.trim()) && totalImages > 0;
  const uploadTitle = uploadStatus?.stage === 'preparing'
    ? 'Preparing images'
    : uploadStatus?.stage === 'creating_session'
      ? 'Starting secure upload'
      : uploadStatus?.stage === 'finalizing'
        ? 'Finalizing report'
        : uploadStatus?.stage === 'complete'
          ? 'Upload complete'
          : 'Uploading images';

  if (visible && (awaitingDraft || savingLocal)) return <DraftStorageStatus saving={savingLocal} error={draftLoadError}
    onRetry={() => setDraftLoadAttempt(value => value + 1)} onClose={() => { void resetForm(); onClose(); }} />;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={[styles.header, auctioneer && !compactAuctioneerActions && styles.importedHeader]}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={HEADER_HIT_SLOP} accessibilityRole="button" accessibilityLabel="Close lot listing">
            <Feather name="x" size={22} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isAuctionManagementMode ? 'Auction Management' : 'Lot Listing'}</Text>
          {compactAuctioneerActions ? <View style={styles.compactHeaderSpacer} /> : <View style={[styles.headerActions, auctioneer && styles.importedHeaderActions]}>
            {isAuctionManagementMode ? (
              <View style={styles.headerSpacer} />
            ) : (
              <>
                {!auctioneer ? <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Save lot listing draft"
                  style={[
                    styles.headerDraftBtn,
                    (!canSaveDraftPreview || submitting || savingDraftPreview) && styles.submitBtnDisabled,
                  ]}
                  onPress={() => void handleSaveDraftPreview()}
                  hitSlop={HEADER_HIT_SLOP}
                  disabled={Boolean(auctioneer) || !canSaveDraftPreview || submitting || savingDraftPreview}>
                  {savingDraftPreview ? (
                    <ActivityIndicator size="small" color="#6D28D9" />
                  ) : (
                    <Feather name="cloud" size={14} color="#6D28D9" />
                  )}
                  <Text style={styles.headerDraftBtnText}>Draft</Text>
                </TouchableOpacity> : null}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={saveOnly ? 'Save offline lot listing' : uploadPaused ? 'Resume upload' : auctioneer ? 'Create Lot & Close' : 'Submit lot listing'}
                  style={[styles.submitBtn, auctioneer && styles.importedSubmitBtn, ((!saveOnly && !canTapSubmit) || savingDraftPreview) && styles.submitBtnDisabled]}
                  onPress={() => void handleSubmit()}
                  hitSlop={HEADER_HIT_SLOP}
                  disabled={(!saveOnly && !canTapSubmit) || submitting || savingDraftPreview}>
                  {submitting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    // "Resume upload" on two lines keeps this button as narrow as
                    // "Submit": one line squeezed the title to one letter per line
                    // (2026-10-11 phone test). Incoming's full-width button keeps one line.
                    <Text style={styles.submitBtnText}>{saveOnly ? 'Save' : uploadPaused ? (auctioneer ? 'Resume upload' : 'Resume\nupload') : auctioneer ? 'Create Lot & Close' : 'Submit'}</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>}
        </View>
        {compactAuctioneerActions && auctioneer ? <AuctioneerFormHeader setup={auctioneer}
          disabled={!canSubmit || submitting || savingDraftPreview}
          closeDisabled={!canSubmit || submitting || savingDraftPreview}
          submitting={submitting} paused={uploadPaused}
          onPress={() => void handleSubmit('LottingBoard', { nextLot: true })}
          onSubmit={() => void handleSubmit()} /> : null}

        {/* Progress Overlay */}
        <Modal testID="lot-upload-progress" visible={visible && (submitting || savingDraftPreview)} transparent animationType="fade"
          onRequestClose={submitting ? handlePauseUpload : () => undefined}>
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard} accessibilityViewIsModal>
              <ActivityIndicator size="large" color="#8B5CF6" />
              <Text style={styles.progressText}>
                {savingDraftPreview ? 'Saving Draft to Cloud' : pausingUpload ? 'Pausing upload…' : uploadTitle}
              </Text>
              <Text style={styles.progressMessage} accessibilityLiveRegion="polite">
                {savingDraftPreview
                  ? `Uploading and verifying ${totalImages} ${totalImages === 1 ? 'image' : 'images'}, then starting preview processing.`
                  : pausingUpload ? 'Stopping this transfer. Your saved draft will stay available; tap Resume upload when ready.' : uploadStatus?.message || `Preparing ${totalImages} images...`}
              </Text>
              {!savingDraftPreview ? (
                <>
                  {uploadStatus?.stage !== 'complete' && uploadStatus?.stage !== 'finalizing' && !uploadAcceptedRef.current ? (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={pausingUpload ? 'Pausing upload' : 'Pause upload'}
                      accessibilityState={{ disabled: pausingUpload }} disabled={pausingUpload} onPress={handlePauseUpload} style={{ minHeight: 44, padding: 12 }}>
                      <Text style={{ color: '#1D4ED8' }}>{pausingUpload ? 'Pausing upload…' : 'Pause upload'}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <View style={styles.progressBar}>
                    <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
                  </View>
                  <View style={styles.progressMetaRow}>
                    <Text style={styles.progressPercent}>{uploadProgress}%</Text>
                    {!!uploadStatus?.totalFiles && (
                      <Text style={styles.progressFileCount}>
                        {uploadStatus.completedFiles} / {uploadStatus.totalFiles} files
                      </Text>
                    )}
                  </View>
                  {!!uploadStatus?.activeFileName && (
                    <Text style={styles.progressFileName} numberOfLines={1}>
                      {uploadStatus.activeFileName}
                    </Text>
                  )}
                </>
              ) : null}
            </View>
          </View>
        </Modal>
        <UploadWaitingForSignal testID="lot-upload-waiting" visible={visible && autoResume.waiting}
          completedFiles={uploadStatus?.completedFiles} totalFiles={uploadStatus?.totalFiles}
          onResumeNow={autoResume.resumeNow} onPause={autoResume.stop} />

        {/* Restore Draft Modal */}
        <Modal
          visible={showRestorePrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowRestorePrompt(false)}>
          <View style={styles.restoreModalOverlay}>
            <View style={styles.restoreModalContent}>
              <View style={styles.restoreModalIcon}>
                <Feather name="refresh-cw" size={32} color="#8B5CF6" />
              </View>
              <Text style={styles.restoreModalTitle}>Restore Draft?</Text>
              <Text style={styles.restoreModalText}>
                You have a saved draft with {autoSaveInfo?.totalImages || 0} images from{' '}
                {autoSaveInfo?.totalLots || 0} lot(s).
              </Text>
              {autoSaveInfo?.savedAt && (
                <Text style={styles.restoreModalTime}>
                  Saved {new Date(autoSaveInfo.savedAt).toLocaleString()}
                </Text>
              )}
              <View style={styles.restoreModalButtons}>
                <TouchableOpacity
                  style={styles.restoreModalDiscardBtn}
                  onPress={handleDiscardAutoSave}>
                  <Text style={styles.restoreModalDiscardText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.restoreModalRestoreBtn}
                  onPress={handleRestoreAutoSave}>
                  <Text style={styles.restoreModalRestoreText}>Restore</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Single scrollable content with details at top */}
        <KeyboardAvoidingView
          testID="lot-listing-keyboard-layout"
          style={styles.keyboardContent}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView 
          style={styles.scrollContent}
          contentContainerStyle={styles.scrollContentContainer}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          <View style={styles.capturePanelInset}>
            <OfflineCapturePanel mode={captureMode} onChange={changeCaptureMode} lots={lots} savedAt={localSavedAt}
              manualSubmissionRequired={manualSubmissionRequired} reviewingSavedDraft={reviewingSavedDraft}
              error={localSaveError} disabled={submitting || savingDraftPreview} paused={uploadPaused}
              onSave={() => { void handleSaveDraftPreview(); }} />
          </View>
          
          {isAuctionManagementMode && auctionManagementTask ? (
            <View style={styles.auctionTaskBanner}>
              <View style={styles.auctionTaskHeader}>
                <View style={styles.auctionTaskIcon}>
                  <Feather name="briefcase" size={18} color="#1D4ED8" />
                </View>
                <View style={styles.auctionTaskTitleWrap}>
                  <Text style={styles.auctionTaskEyebrow}>Auctionsoft Contract</Text>
                  <Text style={styles.auctionTaskTitle} numberOfLines={1}>
                    Contract {auctionManagementTask.contract?.contractNumber || contractNo}
                  </Text>
                </View>
              </View>
              <View style={styles.auctionTaskMetaGrid}>
                <View style={styles.auctionTaskMeta}>
                  <Text style={styles.auctionTaskMetaLabel}>Customer</Text>
                  <Text style={styles.auctionTaskMetaValue} numberOfLines={1}>{auctionCustomerName}</Text>
                </View>
                <View style={styles.auctionTaskMeta}>
                  <Text style={styles.auctionTaskMetaLabel}>Location</Text>
                  <Text style={styles.auctionTaskMetaValue} numberOfLines={1}>{auctionLocationLabel}</Text>
                </View>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.seedLotTabs}>
                {lots.map((lot, index) => {
                  const active = index === activeLotIdx;
                  const seedLot = auctionManagementTask.lots[index];
                  return (
                    <TouchableOpacity
                      key={lot.id || index}
                      style={[styles.seedLotTab, active && styles.seedLotTabActive]}
                      onPress={() => setActiveLotIdx(index)}
                      activeOpacity={0.84}>
                      <Text style={[styles.seedLotTabText, active && styles.seedLotTabTextActive]}>
                        Lot {index + 1}
                      </Text>
                      {seedLot?.source ? (
                        <Text style={[styles.seedLotTabSubtext, active && styles.seedLotTabSubtextActive]} numberOfLines={1}>
                          {seedLot.source === 'scheduleA' || seedLot.source === 'schedule_a' ? 'Schedule A' : seedLot.source}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          <ScheduleAItemPicker item={scheduleAItem} disabled={submitting || savingDraftPreview}
            style={styles.servicesSection} titleStyle={[styles.sectionTitle, styles.scheduleAItemTitle]} />
          <ProposalListPanel list={proposalList} disabled={submitting || savingDraftPreview}
            style={styles.servicesSection} titleStyle={[styles.sectionTitle, styles.scheduleAItemTitle]} />

          {/* Details Section - Collapsible */}
          <View style={styles.detailsSection}>
            <TouchableOpacity 
              accessibilityRole="button"
              accessibilityLabel="Listing details"
              accessibilityState={{ expanded: detailsExpanded }}
              style={styles.sectionHeader} 
              onPress={() => setDetailsExpanded(!detailsExpanded)}
              activeOpacity={0.7}>
              <Text style={styles.sectionTitle}>Listing Details</Text>
              <Feather 
                name={detailsExpanded ? 'chevron-up' : 'chevron-down'} 
                size={20} 
                color="#6B7280" 
              />
            </TouchableOpacity>
            
            {detailsExpanded && (
              <View style={styles.detailsContent}>
                <View style={styles.fieldContainerSmall}>
                  <Text style={styles.fieldLabelSmall}>Currency</Text>
                  <CurrencySelect value={currency} onChange={setCurrency} disabled={submitting || savingDraftPreview} />
                  <Text style={styles.fieldLabelSmall}>Detected from inspection location; change it if needed.</Text>
                </View>
                <View style={styles.fieldContainerSmall}>
                  <Text style={styles.fieldLabelSmall}>Contract # *</Text>
                  <TextInput
                    accessibilityLabel="Contract number, required"
                    accessibilityHint={isAuctionManagementMode ? 'Provided by the selected contract' : 'Letters, numbers, and split contract suffixes are supported'}
                    style={[
                      styles.inputSmall,
                      errors.contractNo && styles.inputError,
                      isAuctionManagementMode && styles.inputLocked,
                    ]}
                    value={contractNo}
                    onChangeText={(t) => {
                      setContractNo(t);
                      clearError('contractNo');
                    }}
                    placeholder="Contract no."
                    placeholderTextColor="#9CA3AF"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!isAuctionManagementMode && !auctioneer}
                  />
                </View>
                <TouchableOpacity
                  style={styles.bankToggleRow}
                  accessibilityRole="switch"
                  accessibilityLabel="Include all lot photos in the condition report"
                  accessibilityState={{ checked: bankPhotosEnabled }}
                  activeOpacity={0.8}
                  onPress={() => setBankPhotosEnabled((prev) => !prev)}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.fieldLabelSmall}>Bank</Text>
                    <Text style={styles.bankToggleHelp}>Include all lot photos in the CR.</Text>
                  </View>
                  <View style={[styles.bankCheckbox, bankPhotosEnabled && styles.bankCheckboxActive]}>
                    <View style={styles.switchKnob} />
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.bankToggleRow}
                  activeOpacity={0.8}
                  accessibilityRole="switch"
                  accessibilityLabel="Apply watermark to new photos"
                  accessibilityState={{ checked: watermarkImages }}
                  onPress={() => setWatermarkImages((prev) => !prev)}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.fieldLabelSmall}>Apply watermark</Text>
                    <Text style={styles.bankToggleHelp}>
                      For imported, unwatermarked photos only. Asset Insight camera photos already have a logo. Off by default.
                    </Text>
                  </View>
                  <View style={[styles.bankCheckbox, watermarkImages && styles.bankCheckboxActive]}>
                    <View style={styles.switchKnob} />
                  </View>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {isAuctionManagementMode && auctionManagementTask ? (
            <View style={styles.servicesSection}>
              <View style={styles.sectionHeaderStatic}>
                <Text style={styles.sectionTitle}>Service Revenue Contracts</Text>
                <Text style={styles.serviceCounter}>
                  Lot {activeLotIdx + 1} of {Math.max(lots.length, 1)}
                </Text>
              </View>
              <Text style={styles.seedLotText} numberOfLines={2}>
                {activeSeedLot?.description || `Lot ${activeLotIdx + 1}`}
              </Text>
              {auctionServices.length === 0 ? (
                <Text style={styles.emptyServicesText}>No revenue contracts configured.</Text>
              ) : (
                <View style={styles.serviceWrap}>
                  {auctionServices.map((service) => {
                    const selected = (auctionServiceSelections[activeLotIdx] || []).includes(service.rowGuid);
                    return (
                      <TouchableOpacity
                        key={service.rowGuid}
                        style={[styles.serviceChip, selected && styles.serviceChipActive]}
                        onPress={() => toggleAuctionService(activeLotIdx, service.rowGuid)}
                        activeOpacity={0.86}>
                        <View style={styles.serviceChipCopy}>
                          <Text style={[styles.serviceChipText, selected && styles.serviceChipTextActive]} numberOfLines={1}>
                            {service.serviceName}
                          </Text>
                          <Text style={[styles.serviceChipPrice, selected && styles.serviceChipPriceActive]}>
                            ${Number(String(service.defaultPrice ?? '0').replace(/[^0-9.-]/g, '')) || 0}
                          </Text>
                        </View>
                        <View style={[styles.serviceChipCheck, selected && styles.serviceChipCheckActive]}>
                          {selected ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          {/* Photos Section - Embedded LotManager */}
          <View style={styles.photosSection}>
            <LotManager
              lockedStructure={auctioneer?.kind === 'scheduleA'}
              sourceLabels={auctioneer?.kind === 'scheduleA' ? auctioneer.lots.map((lot, index) => lot.lotNumber ? `Lot ${lot.lotNumber}` : `Lot ${index + 1}`) : proposalLots?.labels}
              sourceTags={auctioneer?.kind === 'scheduleA' ? auctioneer.lots.map((lot) => lot.severalLots ? 'Several lots' : undefined) : proposalLots?.tags}
              sourceDetails={proposalLots?.details}
              listedItemLots={proposalLots?.listed}
              lots={lots}
              setLots={setLots}
              activeLotIdx={activeLotIdx}
              setActiveLotIdx={setActiveLotIdx}
              onOpenCamera={handleOpenCamera}
              onCreateLot={handleCreateLot}
              hideSummary={true}
              embedded
            />
          </View>
        </ScrollView>

        {isAuctionManagementMode && (
          <View style={styles.auctionActionBar}>
            <View style={styles.auctionSummaryRow}>
              <Text style={styles.auctionSummaryText}>{lots.length} lot{lots.length === 1 ? '' : 's'}</Text>
              <Text style={styles.auctionSummaryText}>{totalImages} image{totalImages === 1 ? '' : 's'}</Text>
            </View>
            {!saveOnly && <TouchableOpacity
              style={styles.closeContractRow}
              onPress={() => setAuctionCloseContract((prev) => !prev)}
              activeOpacity={0.85}>
              <View style={[styles.closeCheckbox, auctionCloseContract && styles.closeCheckboxActive]}>
                {auctionCloseContract && <Feather name="check" size={14} color="#fff" />}
              </View>
              <Text style={styles.closeContractText}>Contract Completed & Closed</Text>
            </TouchableOpacity>}
            {saveOnly ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save offline lot listing"
              style={[styles.destinationButton, styles.lottingButton]} onPress={() => void handleSubmit()}>
              <Text style={styles.destinationButtonText}>Save</Text>
            </TouchableOpacity> : <View style={styles.destinationButtons}>
              <TouchableOpacity
                style={[styles.destinationButton, styles.lottingButton, !canSubmit && styles.destinationButtonDisabled]}
                onPress={() => handleSubmit('LottingBoard')}
                disabled={!canSubmit || submitting}
                activeOpacity={0.88}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="send" size={18} color="#fff" />}
                <Text style={styles.destinationButtonText}>Send to Lotting Board</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.destinationButton, styles.opTodoButton, !canSubmit && styles.destinationButtonDisabled]}
                onPress={() => handleSubmit('OpToDoBoard')}
                disabled={!canSubmit || submitting}
                activeOpacity={0.88}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="tool" size={18} color="#fff" />}
                <Text style={styles.destinationButtonText}>Send to Op To-Do</Text>
              </TouchableOpacity>
            </View>}
          </View>
        )}

        {/* Fixed Bottom Summary Bar */}
        {!isAuctionManagementMode && lots.length > 0 && (
          <View style={styles.fixedSummary}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{lots.length}</Text>
              <Text style={styles.summaryLabel}>Lots</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{totalImages}</Text>
              <Text style={styles.summaryLabel}>Images</Text>
            </View>
          </View>
        )}
        </KeyboardAvoidingView>

        {/* Camera Modal */}
        <CameraScreen
            captureContext={visible && OfflineCaptureStore.getOwnerId() ? { ownerId: OfflineCaptureStore.getOwnerId()!, draftId: currentDraftId || draftIdentityRef.current, sessionId: currentDraftId || draftIdentityRef.current } : undefined}
            manualSubmissionRequired={captureMode === 'offline' || manualSubmissionRequired}
            visible={cameraOpen}
            lockedStructure={auctioneer?.kind === 'scheduleA'}
            sourceLabels={auctioneer?.kind === 'scheduleA' ? auctioneer.lots.map((lot, index) => lot.lotNumber ? `Lot ${lot.lotNumber}` : `Lot ${index + 1}`) : proposalLots?.labels}
            onClose={handleCameraClose}
            lots={lots}
            setLots={setLots}
            activeLotIdx={activeLotIdx}
            setActiveLotIdx={setActiveLotIdx}
            onAutoSave={triggerAutoSave}
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  // Header controls a little smaller (owner, 2026-10-11 phone test). Each keeps
  // a 44-point touch area through hitSlop (HEADER_HIT_SLOP).
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  importedHeader: { flexWrap: 'wrap' },
  importedHeaderActions: { flexBasis: '100%', paddingTop: 8 },
  importedSubmitBtn: { flex: 1 },
  compactHeaderSpacer: { width: 40 },
  headerSpacer: {
    width: 80,
  },
  headerDraftBtn: {
    minWidth: 62,
    minHeight: 38,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6FE',
    backgroundColor: '#F5F3FF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  headerDraftBtnText: {
    color: '#6D28D9',
    fontSize: 12,
    fontWeight: '800',
  },
  submitBtn: {
    minHeight: 38,
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    backgroundColor: '#D1D5DB',
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
  },
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    width: '80%',
  },
  progressText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginTop: 16,
    marginBottom: 4,
  },
  progressMessage: {
    width: '100%',
    color: '#6B7280',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 16,
  },
  progressBar: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8B5CF6',
    borderRadius: 4,
  },
  progressPercent: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4B5563',
  },
  progressMetaRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  progressFileCount: {
    fontSize: 13,
    color: '#6B7280',
  },
  progressFileName: {
    width: '100%',
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 8,
  },
  scrollContent: {
    flex: 1,
  },
  keyboardContent: { flex: 1, minHeight: 0 },
  scrollContentContainer: {
    width: '100%',
    maxWidth: 920,
    alignSelf: 'center',
    paddingBottom: 40,
  },
  auctionTaskBanner: {
    backgroundColor: '#FFFFFF',
    margin: 12,
    marginBottom: 0,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  auctionTaskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  auctionTaskIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    marginRight: 10,
  },
  auctionTaskTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  auctionTaskEyebrow: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  auctionTaskTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '900',
    marginTop: 2,
  },
  auctionTaskMetaGrid: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  auctionTaskMeta: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  auctionTaskMetaLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  auctionTaskMetaValue: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  seedLotTabs: {
    gap: 8,
    paddingTop: 12,
  },
  seedLotTab: {
    minWidth: 74,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  seedLotTabActive: {
    borderColor: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  seedLotTabText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '900',
  },
  seedLotTabTextActive: {
    color: '#1D4ED8',
  },
  seedLotTabSubtext: {
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 2,
  },
  seedLotTabSubtextActive: {
    color: '#2563EB',
  },
  detailsSection: {
    backgroundColor: '#fff',
    margin: 12,
    marginBottom: 0,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
  },
  detailsContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 0,
  },
  compactRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  compactField: {
    flex: 1,
  },
  fieldContainerSmall: {
    marginBottom: 10,
  },
  fieldLabelSmall: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 4,
  },
  bankToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  bankToggleHelp: {
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 15,
  },
  // Bank and watermark are switches; the track and knob show it.
  bankCheckbox: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    justifyContent: 'center',
    alignItems: 'flex-start',
    backgroundColor: '#CDD4DE',
  },
  bankCheckboxActive: {
    alignItems: 'flex-end',
    backgroundColor: '#8B5CF6',
  },
  switchKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  capturePanelInset: {
    marginHorizontal: 12,
    marginTop: 4,
  },
  inputSmall: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#1F2937',
  },
  inputLocked: {
    backgroundColor: '#F1F5F9',
    color: '#475569',
  },
  servicesSection: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  scheduleAItemTitle: { marginBottom: 6 },
  sectionHeaderStatic: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  serviceCounter: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '700',
  },
  seedLotText: {
    marginTop: 6,
    color: '#475569',
    fontSize: 12,
    lineHeight: 17,
  },
  emptyServicesText: {
    marginTop: 10,
    color: '#94A3B8',
    fontSize: 12,
    fontStyle: 'italic',
  },
  serviceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  serviceChip: {
    maxWidth: '100%',
    minWidth: '47%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serviceChipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#DBEAFE',
  },
  serviceChipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
  },
  serviceChipTextActive: {
    color: '#1D4ED8',
  },
  serviceChipCopy: {
    flex: 1,
  },
  serviceChipPrice: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  serviceChipPriceActive: {
    color: '#1D4ED8',
  },
  serviceChipCheck: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceChipCheckActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  datePickerSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  datePickerTextSmall: {
    fontSize: 13,
    color: '#1F2937',
    flex: 1,
  },
  photosSection: {
    flex: 1,
    minHeight: 300,
  },
  auctionActionBar: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  auctionSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  auctionSummaryText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '800',
  },
  closeContractRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  closeCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeCheckboxActive: {
    borderColor: '#16A34A',
    backgroundColor: '#16A34A',
  },
  closeContractText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
  },
  destinationButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  destinationButton: {
    flex: 1,
    minHeight: 72,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  lottingButton: {
    backgroundColor: '#16A34A',
  },
  opTodoButton: {
    backgroundColor: '#F97316',
  },
  destinationButtonDisabled: {
    opacity: 0.45,
  },
  destinationButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  // Fixed bottom summary
  fixedSummary: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 4,
  },
  summaryItem: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#2563EB',
  },
  summaryLabel: {
    fontSize: 10,
    color: '#6B7280',
    marginTop: 1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  summaryDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#E5E7EB',
  },
  fieldContainer: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#EF4444',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 12,
    marginTop: 4,
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  datePickerText: {
    fontSize: 15,
    color: '#1F2937',
    flex: 1,
  },
  datePickerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  datePickerModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20,
  },
  datePickerModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  datePickerModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
  },
  datePickerCancelText: {
    fontSize: 16,
    color: '#6B7280',
  },
  datePickerDoneText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8B5CF6',
  },
  iosDatePicker: {
    height: 200,
  },
  // Restore Modal Styles
  restoreModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  restoreModalContent: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  restoreModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#F3E8FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  restoreModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 8,
    textAlign: 'center',
  },
  restoreModalText: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  restoreModalTime: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 20,
  },
  restoreModalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  restoreModalDiscardBtn: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  restoreModalDiscardText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6B7280',
  },
  restoreModalRestoreBtn: {
    flex: 1,
    backgroundColor: '#8B5CF6',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  restoreModalRestoreText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
});

export default function LotListingFormWithAuctioneer(props: LotListingFormSheetProps) {
  const draftSessionRef = useRef<string | null>(props.draftIdToLoad || null);
  if (!props.visible) draftSessionRef.current = null;
  else if (props.draftIdToLoad) draftSessionRef.current = props.draftIdToLoad;
  const sessionDraftId = draftSessionRef.current;
  if (!props.auctioneer && !sessionDraftId) return <LotListingFormSheet {...props} />;
  return <AuctioneerFormBoundary visible={props.visible} type="lotListing" setup={props.auctioneer}
    draftIdToLoad={sessionDraftId} onClose={props.onClose} onSetupChange={props.onAuctioneerSetupChange}>
    {(control) => <LotListingFormSheet {...props} auctioneerControl={control}
      auctionManagementTask={control ? undefined : props.auctionManagementTask}
      draftIdToLoad={control?.draftIdToLoad || (control && !control.restoreDraft ? undefined : sessionDraftId)} />}
  </AuctioneerFormBoundary>;
}
