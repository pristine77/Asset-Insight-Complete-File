import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cameraDeadline } from '../camera/cameraDeadline';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  useWindowDimensions,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TextInput from './ListingTextInput';
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
import * as Localization from 'expo-localization';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useAuth } from '../../context/AuthContext';
import CameraCapture, { CaptureMode, MixedLot } from './CameraCapture';
import LotManager from './LotManager';
import assetService, { AssetCreateDetails, MixedLot as ServiceMixedLot, ProgressData } from '../../services/assetService';
import AutoSaveService, { AutoSaveData, AutoSaveFormData } from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import { getSubmissionError } from '../../services/connectivityService';
import type { DirectUploadProgress } from '../../services/directR2UploadService';
import { getPhotoUploadUri, normalizePhotoFile } from '../../utils/photoFileUtils';
import { DEFAULT_IMAGE_WATERMARK, restoreImageWatermarkPreference } from '../../utils/watermarkPreference';
import savedInputService from '../../services/savedInputService';
import reportDraftService, {
  getDuplicateLotWarning,
} from '../../services/reportDraftService';
import {
  getHiddenCurrentLocation,
  normalizeHiddenLocation,
  type HiddenLocationSnapshot,
} from '../../utils/mobileLocation';
import AuctioneerFormBoundary, { type AuctioneerFormControl } from './AuctioneerFormBoundary';
import AuctioneerFormHeader from './AuctioneerFormHeader';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import { auctioneerSeedLots, auctioneerLotSource, hasValidAuctioneerLotStructure } from './auctioneerFormPolicy';

const MAX_ASSET_LOT_PHOTOS = 200;

// Currency codes by region/locale
const CURRENCY_MAP: Record<string, string> = {
  'en-CA': 'CAD',
  'en-US': 'USD',
  'en-GB': 'GBP',
  'en-AU': 'AUD',
  'fr-CA': 'CAD',
  'fr-FR': 'EUR',
  'es-ES': 'EUR',
  'es-MX': 'MXN',
  'de-DE': 'EUR',
  'it-IT': 'EUR',
  'pt-BR': 'BRL',
  'ja-JP': 'JPY',
  'zh-CN': 'CNY',
  'ko-KR': 'KRW',
  'in-IN': 'INR',
  'hi-IN': 'INR',
};

// Lot mode types
export type LotMode = 'single_lot' | 'per_item' | 'per_photo';

// MixedLot type is imported from CameraCapture

// Saved input data type
export interface SavedInputData {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: Record<string, any>;
}

interface AssetFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  savedInputData?: SavedInputData | null;
  draftIdToLoad?: string | null;
  onDraftLoaded?: () => void;
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

// Calendar-only fields must use the device calendar date, not UTC. Using
// toISOString() can move a selected date backward in western time zones.
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const AssetFormSheet = ({
  visible,
  onClose,
  onSuccess,
  savedInputData,
  draftIdToLoad,
  onDraftLoaded,
  auctioneerControl,
  backgroundUploads = false,
}: AssetFormSheetProps) => {
  const auctioneer = auctioneerControl?.setup;
  const continuation = auctioneerControl?.continuationDetails;
  const { user } = useAuth();
  const { width, fontScale } = useWindowDimensions();
  const compactFields = width < 480 || fontScale > 1.3;

  // Form fields
  const [clientName, setClientName] = useState(continuation?.clientName ?? (auctioneer?.contract.customerName || ''));
  const [effectiveDate, setEffectiveDate] = useState(continuation?.effectiveDate ?? (auctioneer?.contract.eventDate?.slice(0, 10) || isoDate(new Date())));
  const [appraisalPurpose, setAppraisalPurpose] = useState(continuation?.appraisalPurpose ?? (auctioneer ? 'Auction listing and condition report' : ''));
  const [ownerName, setOwnerName] = useState(continuation?.ownerName ?? (auctioneer?.contract.customerName || ''));
  const [appraiser, setAppraiser] = useState(continuation?.appraiser ?? ((user as any)?.username || ''));
  const [appraisalCompany, setAppraisalCompany] = useState(continuation?.appraisalCompany ?? ((user as any)?.companyName || ''));
  const [industry, setIndustry] = useState(continuation?.industry ?? (auctioneer?.contract.categories || ''));
  const [inspectionDate, setInspectionDate] = useState(continuation?.inspectionDate ?? isoDate(new Date()));
  const [contractNo, setContractNo] = useState(auctioneer?.contract.contractNo || '');
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>(continuation?.language ?? 'en');
  const [currency, setCurrency] = useState(continuation?.currency ?? (auctioneer ? 'CAD' : ''));
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const [preparedFor, setPreparedFor] = useState(continuation?.preparedFor ?? (auctioneer?.contract.customerName || ''));
  const [factorsAgeCondition, setFactorsAgeCondition] = useState(continuation?.factorsAgeCondition ?? '');
  const [factorsQuality, setFactorsQuality] = useState(continuation?.factorsQuality ?? '');
  const [factorsAnalysis, setFactorsAnalysis] = useState(continuation?.factorsAnalysis ?? '');
  const [includeDamageAnalysis, setIncludeDamageAnalysis] = useState(continuation?.includeDamageAnalysis ?? true);
  const [bankPhotosEnabled, setBankPhotosEnabled] = useState(continuation?.bankPhotosEnabled ?? false);
  const [watermarkImages, setWatermarkImages] = useState(continuation?.watermarkImages ?? DEFAULT_IMAGE_WATERMARK);
  const [hiddenLocation, setHiddenLocation] = useState<HiddenLocationSnapshot | null>(() => continuation
    ? normalizeHiddenLocation(continuation.location, continuation.latitude, continuation.longitude)
    : auctioneer ? normalizeHiddenLocation(auctioneer.contract.location) : null);

  // Valuation methods
  const [includeValuationTable, setIncludeValuationTable] = useState(continuation?.includeValuationTable ?? false);
  const [selectedValuationMethods, setSelectedValuationMethods] = useState<
    Array<'FML' | 'TKV' | 'OLV' | 'FLV'>
  >(continuation?.selectedValuationMethods ?? ['FML']);

  // Lots state
  const [lots, setLotsRaw] = useState<MixedLot[]>(() => auctioneer ? auctioneerSeedLots(auctioneer) : []);
  const setLots = useCallback<React.Dispatch<React.SetStateAction<MixedLot[]>>>((update) => {
    setLotsRaw((previous) => {
      const next = typeof update === 'function' ? update(previous) : update;
      return hasValidAuctioneerLotStructure(auctioneer, next) ? next : previous;
    });
  }, [auctioneer]);
  const [activeStep, setActiveStep] = useState<'details' | 'images'>('details');

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeLotIdx, setActiveLotIdx] = useState(-1);
  const [enhanceImages, setEnhanceImages] = useState(continuation?.enhanceImages ?? false); // Server-side enhancement toggle

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [pausingUpload, setPausingUpload] = useState(false);
  const pauseRequestedRef = useRef(false);
  const uploadAcceptedRef = useRef(false);
  const [savingDraftPreview, setSavingDraftPreview] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<DirectUploadProgress | null>(null);
  const [progressPhase, setProgressPhase] = useState<
    'idle' | 'uploading' | 'processing' | 'done' | 'error'
  >('idle');
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

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
    // Finalizing is when the server accepts the report; pausing then only loses
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
  // report stays open (useUploadAutoResume; owner decision 2026-10-11,
  // restoring 2026-10-02). handleSubmitRef gives that later resume the handler
  // from the latest render.
  const autoResume = useUploadAutoResume(visible, async () => (await OfflineQueueService.getConnectivityStatus()).status === 'online');
  const handleSubmitRef = useRef<(options?: { nextLot?: boolean; automaticResume?: boolean }) => Promise<void>>(async () => undefined);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadedDraftIdRef = useRef<string | null>(null);
  const awaitingDraft = Boolean(draftIdToLoad && loadedDraftIdRef.current !== draftIdToLoad);
  const draftSavePromiseRef = useRef<Promise<unknown> | null>(null);
  const inspectionDateEditedRef = useRef(false);
  const savedInputHydrationRef = useRef<string | null>(null);

  // Date picker state
  const [showEffectiveDatePicker, setShowEffectiveDatePicker] = useState(false);
  const [showInspectionDatePicker, setShowInspectionDatePicker] = useState(false);

  // Parse date string to Date object
  const parseDate = (dateStr: string): Date => {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const parsed = year && month && day
      ? new Date(year, month - 1, day, 12, 0, 0)
      : new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  };

  // Format date for display
  const formatDateDisplay = (dateStr: string): string => {
    try {
      const date = parseDate(dateStr);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // Handle date change from picker
  const handleEffectiveDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowEffectiveDatePicker(false);
    }
    if (event.type === 'set' && selectedDate) {
      setEffectiveDate(isoDate(selectedDate));
      clearError('effectiveDate');
    }
  };

  const handleInspectionDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowInspectionDatePicker(false);
    }
    if (event.type === 'set' && selectedDate) {
      inspectionDateEditedRef.current = true;
      setInspectionDate(isoDate(selectedDate));
    }
  };

  // Keep legacy single autosave recoverable through the Offline Reports page.
  useEffect(() => {
    if (visible && !savedInputData && !draftIdToLoad) {
      void AutoSaveService.migrateLegacyAutoSaveIfNeeded();
    }
  }, [visible, savedInputData, draftIdToLoad]);

  const checkForAutoSave = async () => {
    try {
      const summary = await AutoSaveService.getAutoSaveSummary();
      if (summary.exists && summary.totalImages && summary.totalImages > 0) {
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
      if (data) {
        // Restore form data
        if (data.formData.clientName) setClientName(data.formData.clientName);
        if (data.formData.effectiveDate) setEffectiveDate(data.formData.effectiveDate);
        if (data.formData.appraisalPurpose) setAppraisalPurpose(data.formData.appraisalPurpose);
        if (data.formData.ownerName) setOwnerName(data.formData.ownerName);
        if (data.formData.appraiser) setAppraiser(data.formData.appraiser);
        if (data.formData.appraisalCompany) setAppraisalCompany(data.formData.appraisalCompany);
        if (data.formData.industry) setIndustry(data.formData.industry);
        if (data.formData.inspectionDate) setInspectionDate(data.formData.inspectionDate);
        if (data.formData.contractNo) setContractNo(data.formData.contractNo);
        if (
          data.formData.location ||
          data.formData.latitude !== undefined ||
          data.formData.longitude !== undefined
        ) {
          setHiddenLocation(
            normalizeHiddenLocation(
              data.formData.location,
              data.formData.latitude,
              data.formData.longitude
            )
          );
        }
        if (data.formData.language) setLanguage(data.formData.language);
        if (data.formData.currency) setCurrency(data.formData.currency);
        if (data.formData.preparedFor) setPreparedFor(data.formData.preparedFor);
        if (data.formData.factorsAgeCondition)
          setFactorsAgeCondition(data.formData.factorsAgeCondition);
        if (data.formData.factorsQuality) setFactorsQuality(data.formData.factorsQuality);
        if (data.formData.factorsAnalysis) setFactorsAnalysis(data.formData.factorsAnalysis);
        if (typeof data.formData.includeDamageAnalysis === 'boolean') {
          setIncludeDamageAnalysis(data.formData.includeDamageAnalysis);
        }
        if (typeof data.formData.bankPhotosEnabled === 'boolean') {
          setBankPhotosEnabled(data.formData.bankPhotosEnabled);
        }
        setWatermarkImages(restoreImageWatermarkPreference(data.formData.watermarkImages));
        if (typeof data.formData.includeValuationTable === 'boolean')
          setIncludeValuationTable(data.formData.includeValuationTable);
        if (
          Array.isArray(data.formData.selectedValuationMethods) &&
          data.formData.selectedValuationMethods.length > 0
        ) {
          setSelectedValuationMethods(data.formData.selectedValuationMethods);
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
      setCaptureMode(((data as any).captureMode || data.formData.captureMode) === 'offline' ? 'offline' : 'online');
      setManualSubmissionRequired(Boolean((data as any).manualSubmissionRequired || data.formData.manualSubmissionRequired || (data as any).captureMode === 'offline' || data.formData.captureMode === 'offline'));
      setUploadPaused(needsExplicitUploadResume((data as any).submissionState));
      if ((data as any).id) draftIdentityRef.current = (data as any).id;
      setLocalSavedAt((data as any).updatedAt);
      if (data.formData.clientName) setClientName(data.formData.clientName);
      if (data.formData.clientSubmissionId) {
        submissionIdRef.current = data.formData.clientSubmissionId;
      }
      supersedesSubmissionIdRef.current = data.formData.supersedesClientSubmissionId;
      if (data.formData.effectiveDate) setEffectiveDate(data.formData.effectiveDate);
      if (data.formData.appraisalPurpose) setAppraisalPurpose(data.formData.appraisalPurpose);
      if (data.formData.ownerName) setOwnerName(data.formData.ownerName);
      if (data.formData.appraiser) setAppraiser(data.formData.appraiser);
      if (data.formData.appraisalCompany) setAppraisalCompany(data.formData.appraisalCompany);
      if (data.formData.industry) setIndustry(data.formData.industry);
      if (data.formData.inspectionDate) setInspectionDate(data.formData.inspectionDate);
      if (data.formData.contractNo) setContractNo(data.formData.contractNo);
      if (
        data.formData.location ||
        data.formData.latitude !== undefined ||
        data.formData.longitude !== undefined
      ) {
        setHiddenLocation(
          normalizeHiddenLocation(
            data.formData.location,
            data.formData.latitude,
            data.formData.longitude
          )
        );
      }
      if (data.formData.language) setLanguage(data.formData.language);
      if (data.formData.currency) setCurrency(data.formData.currency);
      if (data.formData.preparedFor) setPreparedFor(data.formData.preparedFor);
      if (data.formData.factorsAgeCondition)
        setFactorsAgeCondition(data.formData.factorsAgeCondition);
      if (data.formData.factorsQuality) setFactorsQuality(data.formData.factorsQuality);
      if (data.formData.factorsAnalysis) setFactorsAnalysis(data.formData.factorsAnalysis);
      if (typeof data.formData.includeDamageAnalysis === 'boolean') {
        setIncludeDamageAnalysis(data.formData.includeDamageAnalysis);
      }
      setEnhanceImages(data.formData.enhanceImages === true);
      if (typeof data.formData.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.formData.bankPhotosEnabled);
      }
      setWatermarkImages(restoreImageWatermarkPreference(data.formData.watermarkImages));
      if (typeof data.formData.includeValuationTable === 'boolean')
        setIncludeValuationTable(data.formData.includeValuationTable);
      if (
        Array.isArray(data.formData.selectedValuationMethods) &&
        data.formData.selectedValuationMethods.length > 0
      ) {
        setSelectedValuationMethods(data.formData.selectedValuationMethods);
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
      setActiveStep(restoredLots.length ? 'images' : 'details');
    },
    [setLots]
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
        if (!draft || draft.type !== 'asset') throw new Error('This saved draft is unavailable. No new report has been created.');
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
      auctioneerSnapshot: auctioneer ? { ...auctioneer } : undefined,
      auctioneerWorkItemId: auctioneer?.workItemId,
      clientSubmissionId:
        submissionIdRef.current ||
        (submissionIdRef.current = `cv-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
      supersedesClientSubmissionId: supersedesSubmissionIdRef.current,
      clientName,
      effectiveDate,
      appraisalPurpose,
      ownerName,
      appraiser,
      appraisalCompany,
      industry,
      inspectionDate,
      contractNo,
      location: hiddenLocation?.location,
      latitude: hiddenLocation?.latitude,
      longitude: hiddenLocation?.longitude,
      language,
      currency,
      preparedFor,
      factorsAgeCondition,
      factorsQuality,
      factorsAnalysis,
      includeDamageAnalysis,
      enhanceImages,
      bankPhotosEnabled,
      watermarkImages,
      includeValuationTable,
      selectedValuationMethods,
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
      contractNo,
      language,
      currency,
      preparedFor,
      factorsAgeCondition,
      factorsQuality,
      factorsAnalysis,
      includeDamageAnalysis,
      enhanceImages,
      bankPhotosEnabled,
      watermarkImages,
      includeValuationTable,
      selectedValuationMethods,
      hiddenLocation,
      auctioneer,
      captureMode,
      manualSubmissionRequired,
    ]
  );

  useEffect(() => {
    if (!visible || auctioneer) return;

    let cancelled = false;
    void getHiddenCurrentLocation().then((snapshot) => {
      if (cancelled) return;
      setHiddenLocation((current) =>
        current?.latitude !== undefined && current?.longitude !== undefined
          ? current
          : { ...snapshot, location: current?.location?.trim() || snapshot.location }
      );
    });

    return () => {
      cancelled = true;
    };
  }, [visible, auctioneer]);

  const hasDraftableWork = useCallback((candidateLots: MixedLot[] = lots) => {
    const hasImages = candidateLots.some((l) => l.files.length > 0 || l.extraFiles.length > 0 || l.videoFile);
    const hasLots = candidateLots.length > 0;
    const hasDetails = Boolean(
      contractNo.trim() || clientName.trim() ||
        appraisalPurpose.trim() ||
        ownerName.trim() ||
        industry.trim() ||
        preparedFor.trim() ||
        factorsAgeCondition.trim() ||
        factorsQuality.trim() ||
        factorsAnalysis.trim()
    );
    return hasImages || hasLots || hasDetails;
  }, [
    appraisalPurpose,
    contractNo,
    clientName,
    factorsAgeCondition,
    factorsAnalysis,
    factorsQuality,
    industry,
    lots,
    ownerName,
    preparedFor,
  ]);

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
      type: 'asset',
      title: clientName.trim() || contractNo.trim() || 'Asset Report',
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
      setLocalSavedAt(draft.updatedAt);
      setLocalSaveError(undefined);
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
  }, [
    activeLotIdx,
    auctioneer,
    buildAutoSaveFormData,
    clientName,
    contractNo,
    currentDraftId,
    captureMode,
    hasDraftableWork,
    lots,
  ]);

  const saveExplicitLocalDraft = useCallback(() => saveCurrentDraftNow(lots, activeLotIdx, undefined, true), [saveCurrentDraftNow, lots, activeLotIdx]);
  const { saving: savingLocal, saveOnDevice, saveLock } = useDeviceDraftSave(saveExplicitLocalDraft, draftSavePromiseRef, autoSaveTimeoutRef);

  const handleSaveDraftPreview = useCallback(async () => {
    if (awaitingDraft || submitting) return;
    if (captureMode === 'offline' || manualSubmissionRequired) {
      try { await saveOnDevice(); } catch (error) { setLocalSaveError(error instanceof Error ? error.message : 'Save failed. Please try again.'); }
      return;
    }
    if (auctioneer || savingDraftPreview || submitting) return;
    if (!requireContractNumberForDraft()) return;

    const mediaCount = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length + (lot.videoFile ? 1 : 0),
      0
    );
    if (mediaCount === 0) {
      Alert.alert('Images Required', 'Add at least one image before creating a draft preview.');
      return;
    }

    const operation = createUploadOperation();
    const attemptOwner = OfflineCaptureStore.getOwnerId();
    setSavingDraftPreview(true);
    try {
      // Explicit preview creation verifies cloud media; normal autosave remains persistence-only.
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
    lots,
    requireContractNumberForDraft,
    saveCurrentDraftNow,
    saveOnDevice,
    awaitingDraft,
    savingDraftPreview,
    submitting,
  ]);

  // Auto-save form data and images
  const triggerAutoSave = useCallback(async (
    lotsSnapshot?: MixedLot[],
    activeLotIdxSnapshot?: number
  ) => {
    // Clear any existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    if (lotsSnapshot) {
      try {
        await saveCurrentDraftNow(lotsSnapshot, activeLotIdxSnapshot ?? activeLotIdx);
        console.log(
          '[Asset] Camera draft saved',
          lotsSnapshot.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0),
          'images'
        );
      } catch (error) {
        console.error('Camera draft save error:', error);
        throw error;
      }
      return;
    }

    // Debounce auto-save (wait 2 seconds after last change)
    autoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveCurrentDraftNow();
      } catch (error) {
        console.error('Auto-save error:', error);
      }
    }, 2000);
  }, [activeLotIdx, saveCurrentDraftNow]);

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

  // State for saving inputs
  const [savingInputs, setSavingInputs] = useState(false);

  // Save inputs to server (like web version)
  const saveInputs = async () => {
    if (captureMode === 'offline') {
      Alert.alert('Offline capture', 'Your inputs are saved with this local draft. Shared templates require Online mode.');
      return;
    }
    try {
      setSavingInputs(true);

      // Auto-generate name based on client name and date
      const baseName = clientName.trim() || 'Unnamed';
      const dateStr = new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const autoName = `${baseName} - ${dateStr}`;

      const formData = {
        clientName,
        effectiveDate,
        appraisalPurpose,
        ownerName,
        appraiser,
        appraisalCompany,
        industry,
        inspectionDate,
        contractNo,
        location: hiddenLocation?.location,
        latitude: hiddenLocation?.latitude,
        longitude: hiddenLocation?.longitude,
        language,
        currency,
        includeValuationTable,
        selectedValuationMethods,
        preparedFor,
        factorsAgeCondition,
        factorsQuality,
        factorsAnalysis,
        includeDamageAnalysis,
        bankPhotosEnabled,
        watermarkImages,
      };

      await savedInputService.create({
        name: autoName,
        formType: 'asset',
        formData,
      });

      Alert.alert('Success', 'Inputs saved successfully!');
    } catch (error: any) {
      console.error('Error saving inputs:', error);
      Alert.alert('Error', error?.response?.data?.message || 'Failed to save inputs');
    } finally {
      setSavingInputs(false);
    }
  };

  // Auto-detect currency on mount
  useEffect(() => {
    if (!currency && visible && !draftIdToLoad && !loadedDraftIdRef.current) {
      detectCurrency();
    }
  }, [visible]);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible && !draftIdToLoad && !loadedDraftIdRef.current && !savedInputData && !continuation) {
      setAppraiser((user as any)?.username || '');
      setAppraisalCompany((user as any)?.companyName || '');
    }
  }, [user, visible, draftIdToLoad, savedInputData, continuation]);

  // Load saved input data when provided
  useEffect(() => {
    if (savedInputData?.formData && visible) {
      const hydrationKey = `${savedInputData.name || 'saved'}:${JSON.stringify(savedInputData.formData).length}`;
      if (savedInputHydrationRef.current === hydrationKey) return;
      savedInputHydrationRef.current = hydrationKey;
      const data = savedInputData.formData;
      // Populate form fields from saved data
      if (data.clientName) setClientName(data.clientName);
      if (data.effectiveDate) setEffectiveDate(data.effectiveDate);
      if (data.appraisalPurpose) setAppraisalPurpose(data.appraisalPurpose);
      if (data.ownerName) setOwnerName(data.ownerName);
      if (data.appraiser) setAppraiser(data.appraiser);
      if (data.appraisalCompany) setAppraisalCompany(data.appraisalCompany);
      if (data.industry) setIndustry(data.industry);
      if (data.inspectionDate && !inspectionDateEditedRef.current) {
        setInspectionDate(data.inspectionDate);
      }
      if (data.contractNo) setContractNo(data.contractNo);
      if (data.language) setLanguage(data.language);
      if (data.currency) setCurrency(data.currency);
      if (data.preparedFor) setPreparedFor(data.preparedFor);
      if (data.factorsAgeCondition) setFactorsAgeCondition(data.factorsAgeCondition);
      if (data.factorsQuality) setFactorsQuality(data.factorsQuality);
      if (data.factorsAnalysis) setFactorsAnalysis(data.factorsAnalysis);
      if (typeof data.includeDamageAnalysis === 'boolean') {
        setIncludeDamageAnalysis(data.includeDamageAnalysis);
      }
      if (typeof data.bankPhotosEnabled === 'boolean') {
        setBankPhotosEnabled(data.bankPhotosEnabled);
      }
      setWatermarkImages(restoreImageWatermarkPreference(data.watermarkImages));
      if (typeof data.includeValuationTable === 'boolean')
        setIncludeValuationTable(data.includeValuationTable);
      if (
        Array.isArray(data.selectedValuationMethods) &&
        data.selectedValuationMethods.length > 0
      ) {
        setSelectedValuationMethods(data.selectedValuationMethods);
      }
    }
  }, [savedInputData, visible]);

  useEffect(() => {
    if (!visible) {
      inspectionDateEditedRef.current = false;
      savedInputHydrationRef.current = null;
    }
  }, [visible]);

  const detectCurrency = async () => {
    setCurrencyLoading(true);
    try {
      const locales = Localization.getLocales();
      const locale = locales[0];
      const localeTag = locale?.languageTag || 'en-US';

      // Try exact match first
      let detectedCurrency = CURRENCY_MAP[localeTag];

      // Try language-region match
      if (!detectedCurrency) {
        const langRegion = `${locale?.languageCode}-${locale?.regionCode}`;
        detectedCurrency = CURRENCY_MAP[langRegion];
      }

      // Try region-based detection
      if (!detectedCurrency && locale?.regionCode) {
        const regionMap: Record<string, string> = {
          US: 'USD',
          CA: 'CAD',
          GB: 'GBP',
          AU: 'AUD',
          NZ: 'NZD',
          EU: 'EUR',
          DE: 'EUR',
          FR: 'EUR',
          IT: 'EUR',
          ES: 'EUR',
          MX: 'MXN',
          BR: 'BRL',
          JP: 'JPY',
          CN: 'CNY',
          KR: 'KRW',
          IN: 'INR',
          RU: 'RUB',
          CH: 'CHF',
          SE: 'SEK',
          NO: 'NOK',
        };
        detectedCurrency = regionMap[locale.regionCode];
      }

      setCurrency(detectedCurrency || 'USD');
    } catch (e) {
      console.warn('Currency detection failed:', e);
      setCurrency('USD');
    } finally {
      setCurrencyLoading(false);
    }
  };

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!clientName.trim()) e.clientName = 'Required';
    if (!effectiveDate) e.effectiveDate = 'Required';
    if (!appraisalPurpose.trim()) e.appraisalPurpose = 'Required';
    if (!appraiser.trim()) e.appraiser = 'Required';
    if (!currency || !/^[A-Z]{3}$/.test(currency)) e.currency = 'Use 3-letter code';
    if (lots.length === 0) e.lots = 'Add at least one lot with images';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const clearError = (key: string) => {
    setErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleSubmit = async (options: { forceNew?: boolean; nextLot?: boolean; replaceSubmissionId?: string; replacementSourceId?: string; newSubmissionFromId?: string; automaticResume?: boolean } = {}) => {
    if (submissionLockRef.current || saveLock.current || awaitingDraft || submitting || uploadAcceptedRef.current || auctioneerControl?.accepted) return;
    if (options.nextLot && captureMode === 'offline') return;
    if (saveOnly) { await handleSaveOfflineAndClose(); return; }
    if (auctioneer && (options.forceNew || !hasValidAuctioneerLotStructure(auctioneer, lots))) return;
    if (options.replaceSubmissionId && (auctioneer || submissionIdRef.current !== options.replaceSubmissionId)) return;
    if (options.newSubmissionFromId && (auctioneer || submissionIdRef.current !== options.newSubmissionFromId)) return;
    if (!validateForm()) {
      Alert.alert('Validation Error', 'Please fix the required fields');
      return;
    }

    // Check if there are any images
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0
    );
    if (totalImages === 0) {
      Alert.alert('No Images', 'Please add at least one image to submit');
      return;
    }
    const overLimitLotIndex = lots.findIndex(
      (lot) => lot.files.length + lot.extraFiles.length > MAX_ASSET_LOT_PHOTOS
    );
    if (overLimitLotIndex >= 0) {
      const lot = lots[overLimitLotIndex];
      Alert.alert(
        'Too Many Photos',
        `Lot ${overLimitLotIndex + 1} has ${lot.files.length + lot.extraFiles.length} photos. The maximum is ${MAX_ASSET_LOT_PHOTOS} photos per lot, including report-only photos.`
      );
      return;
    }

    const submissionFileCount = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length + (lot.videoFile ? 1 : 0),
      0
    );
    // Legacy in-app hand-off (services/backgroundUploadManager.ts):
    // an ordinary Submit or Resume from the Dashboard is saved, checked and
    // handed to the upload line, and the form closes. Incoming work keeps
    // waiting here for acceptance (its next lot depends on it), and so do the
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
      [...lot.files, ...lot.extraFiles].every(file => /^(file|content):\/\//.test(getPhotoUploadUri(file))) &&
      (!lot.videoFile || /^(file|content):\/\//.test(lot.videoFile.uri)));
    let lineEligible = backgroundUploads && !auctioneer && !options.nextLot && !options.forceNew
      && !options.replaceSubmissionId && !options.newSubmissionFromId && !options.automaticResume;
    if (backgroundUploads && backgroundUploadManager.prefersForeground(plannedDraftId)) {
      lineEligible = false;
      backgroundUploadManager.consumeForegroundMark(plannedDraftId);
    }
    const background = !durable && lineEligible;
    // A person's Submit or Resume starts a fresh count of automatic tries.
    autoResume.beginAttempt(options.automaticResume === true);
    // The fence begins before local preparation, not only inside the transport.
    // A closed/paused account's asynchronous handler must never start a new upload.
    const operation = createUploadOperation();
    activeOperationRef.current = operation;
    const attemptOwner = OfflineCaptureStore.getOwnerId();
    const attemptRecoveryScope = recoveryScopeRef.current;
    submissionLockRef.current = true;
    pauseRequestedRef.current = false;
    uploadAcceptedRef.current = false;
    setPausingUpload(false);
    setSubmitting(true);
    setProgressPhase('uploading');
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

    let details: AssetCreateDetails | null = null;
    let serviceLots: ServiceMixedLot[] | null = null;
    let attemptDraftId = currentDraftId || draftIdentityRef.current;
    let attemptDraftContent: string | undefined;
    let uploadAccepted = false;
    let draftSaved = false;
    const previousSubmissionId = submissionIdRef.current;
    const previousSupersedesId = supersedesSubmissionIdRef.current;

    try {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      // A deliberately separate report needs its own capture AND submission identity.
      // Ordinary retries keep both identities, including an uncertain acceptance.
      const separateDraftId = options.forceNew || options.newSubmissionFromId ? randomUUID() : undefined;
      if (separateDraftId) {
        submissionIdRef.current = randomUUID();
        supersedesSubmissionIdRef.current = undefined;
        setDraftCaptureMode(separateDraftId, captureMode);
      }
      if (options.replaceSubmissionId) {
        // Save this exact pair before transport, including after a lost response
        // or app restart. The server atomically refuses accepted replacements.
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
      // Persist intent before transport, so a killed process reopens as Resume.
      await OfflineCaptureStore.setSubmissionState(localDraft.id, 'ready');
      operation.assertActive();
      setUploadPaused(false);
      // Generate unique job ID for progress tracking
      const newJobId =
        submissionIdRef.current ||
        `cv-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      submissionIdRef.current = newJobId;
      setJobId(newJobId);
      const locationSnapshot = hiddenLocation || normalizeHiddenLocation();

      // Build mixed_lots mapping for server
      const mixedLotsMapping = lots.map((lot, index) => ({
        ...auctioneerLotSource(auctioneer, index),
        count: lot.files.length,
        extra_count: lot.extraFiles.length,
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
        for (const f of lot.extraFiles) {
          if (f.focusBox) focusBoxes.push({ imageIndex: flatImgIdx, ...f.focusBox });
          flatImgIdx++;
        }
      }

      // Build details object matching web/server format
      details = {
        capture_id: localDraft.captureId,
        auctioneer_work_item_id: auctioneer?.workItemId,
        // Client info
        client_name: clientName.trim(),
        owner_name: ownerName.trim() || undefined,
        prepared_for: preparedFor.trim() || undefined,

        // Appraisal details
        appraisal_purpose: appraisalPurpose.trim(),
        effective_date: effectiveDate,
        inspection_date: inspectionDate || undefined,
        industry: industry.trim() || undefined,
        contract_no: contractNo.trim() || undefined,
        location: locationSnapshot.location,
        latitude: locationSnapshot.latitude,
        longitude: locationSnapshot.longitude,

        // Appraiser info
        appraiser: appraiser.trim(),
        appraisal_company: appraisalCompany.trim() || undefined,

        // Settings
        currency: currency.toUpperCase(),
        language: language,
        grouping_mode: 'mixed',

        // Valuation
        include_valuation_table: includeValuationTable,
        valuation_methods: includeValuationTable ? selectedValuationMethods : undefined,
        include_damage_analysis: includeDamageAnalysis,
        bank_photos_enabled: bankPhotosEnabled,
        watermark_images: watermarkImages,

        // Factors
        factors_age_condition: factorsAgeCondition.trim() || undefined,
        factors_quality: factorsQuality.trim() || undefined,
        factors_analysis: factorsAnalysis.trim() || undefined,

        // Mixed lots mapping
        mixed_lots: mixedLotsMapping,

        // Image enhancement (server-side: +40% saturation, +40% sharpness, +30% contrast)
        enhance_images: enhanceImages,

        // Focus box data for AI (red rectangle drawn server-side)
        focus_boxes: focusBoxes.length > 0 ? focusBoxes : undefined,

        // Progress tracking
        progress_id: newJobId,
        client_submission_id: newJobId,
        supersedes_client_submission_id: supersedesSubmissionIdRef.current,
        force_new: options.forceNew === true,
      };

      // Convert MixedLot to service format
      serviceLots = lots.map((lot) => ({
        id: lot.id,
        files: lot.files.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type || 'image/jpeg',
          size: f.size,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        extraFiles: lot.extraFiles.map((f) => ({
          uri: getPhotoUploadUri(f),
          name: f.name,
          type: f.type || 'image/jpeg',
          size: f.size,
          captureOrder: f.captureOrder,
          originalOrder: f.originalOrder,
        })),
        videoFile: lot.videoFile
          ? {
              uri: lot.videoFile.uri,
              name: lot.videoFile.name,
              type: lot.videoFile.type || 'video/mp4',
              size: lot.videoFile.size,
            }
          : undefined,
        coverIndex: lot.coverIndex || 0,
        mode: lot.mode,
      }));

      // The same details and photos this form would send, frozen now.
      const queuedDetails = details;
      const queuedLots = serviceLots;
      const queueTitle = contractNo.trim() || clientName.trim() || 'Asset report';
      /**
       * Hands this report to the upload line and closes the form. With
       * withDurableHandoff (Android durable builds), each attempt of the line
       * reserves the upload on the server and hands it to Android, which
       * continues it; the line then lets go (backgroundUploadManager.ts).
       */
      const handToLine = (withDurableHandoff: boolean) => {
        if (!attemptOwner) throw new Error('Sign in to the account that owns this draft.');
        const handedOff = backgroundUploadManager.enqueue({
          draftId: localDraft.id,
          type: 'asset',
          ownerId: attemptOwner,
          title: queueTitle,
          totalFiles: submissionFileCount,
          draft: localDraft,
          upload: (onProgress, uploadOperation) =>
            assetService.createAssetReport(queuedDetails, queuedLots, onProgress, {
              operation: uploadOperation,
              ...(withDurableHandoff ? { handoff: durableReportTransfer.handoff(localDraft, queueTitle) } : {}),
            }),
        });
        setSubmitting(false);
        setProgressPhase('idle');
        if (!handedOff) {
          Alert.alert(ALREADY_UPLOADING_TITLE, ALREADY_UPLOADING_MESSAGE);
          return;
        }
        resetForm();
        onClose();
        // With a connection there is no alert: the upload bar shows progress
        // and the outcome. Without one, say that it waits and sends by itself.
        if (noConnection) Alert.alert(WAITING_FOR_SIGNAL_TITLE, WAITING_FOR_SIGNAL_MESSAGE);
      };

      if (background) {
        handToLine(false);
        return;
      }

      const offline = noConnection || (await OfflineQueueService.getConnectivityStatus()).status === 'offline';
      operation.assertActive();
      if (options.nextLot && offline) {
        setSubmitting(false);
        setProgressPhase('idle');
        Alert.alert('Connection required', durable ? 'Keep this lot open and retry when online. The saved upload and its next lot need a short server reservation.' : 'Keep this lot open and retry when online. A new lot starts only after the server accepts this report.');
        return;
      }
      if (offline && lineEligible) {
        // Durable build, ordinary Submit: wait in the line, then hand to Android.
        noConnection = true;
        handToLine(true);
        return;
      }
      if (offline) {
        // While this report stays open it waits for the connection and starts
        // by itself (autoResume); this message shows only when it stops waiting.
        throw Object.assign(new Error('Saved on this device. Connect and tap Resume upload.'), { code: UPLOAD_WAITING_FOR_CONNECTION });
      }

      // Submit to API
      const modernDraft = auctioneer ? await saveCurrentDraftNow() : null;
      if (modernDraft) attemptDraftContent = uploadResumeDraftKey(modernDraft);
      operation.assertActive();
      const acceptedResponse = await assetService.createAssetReport(details, serviceLots, (progress, detail) => {
        if (!operation.isActive() || recoveryScopeRef.current !== attemptRecoveryScope || OfflineCaptureStore.getOwnerId() !== attemptOwner) return;
        setUploadProgress(progress);
        if (detail) setUploadStatus(detail);
        autoResume.noteProgress(detail?.completedFiles);
      }, { operation, ...(durable ? { handoff: options.nextLot && auctioneer
        ? durableContinuationService.handoff(localDraft, contractNo.trim() || clientName.trim() || 'Asset report', auctioneer)
        : durableReportTransfer.handoff(localDraft, contractNo.trim() || clientName.trim() || 'Asset report') } : {}) });
      operation.assertActive();
      if (acceptedResponse.backgroundStaged) {
        if (options.nextLot && auctioneerControl) { await auctioneerControl.continueQueued(localDraft.id); return; }
        setSubmitting(false); setProgressPhase('idle');
        resetForm(); onClose(); return;
      }
      assertReportUploadAccepted(acceptedResponse);
      uploadAccepted = true;
      uploadAcceptedRef.current = true;
      if (isExistingReportUploadReceipt(acceptedResponse)) {
        // The immutable server manifest may match the photos but not recent
        // editable fields. This receipt cannot authorize hiding those edits.
        setSubmitting(false);
        setProgressPhase('idle');
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

      // Upload complete - show success immediately
      onSuccess?.();
      setProgressPhase('done');
      
      // The accepted receipt hides the draft while retaining its inventory history.
      await AutoSaveService.cleanupOrphanedMedia([], 0).catch(() => undefined);
      
      // Brief delay to show "Upload Complete" then close
      setTimeout(() => {
        setSubmitting(false);
        resetForm();
        onClose();
        Alert.alert(
          'Upload Complete! 🎉',
          'Your report has been uploaded successfully. Processing will continue in the background and you will receive an email when ready.'
        );
      }, 800);
    } catch (e: any) {
      console.error('Submit error:', e);
      if (OfflineCaptureStore.getOwnerId() !== attemptOwner) {
        setSubmitting(false);
        setProgressPhase('idle');
        return;
      }
      if (durable && options.nextLot && auctioneerControl && draftSaved) {
        try {
          const intent = await durableContinuationService.forParent(attemptDraftId);
          if (intent && intent.stage !== 'prepared') { await auctioneerControl.continueQueued(attemptDraftId); return; }
        } catch {
          setSubmitting(false); setProgressPhase('error');
          Alert.alert('Continue needs checking', 'The saved upload status could not be read. Keep its originals and retry this Continue request from Drafts; do not submit another copy.');
          return;
        }
      }
      if (uploadAccepted) {
        setSubmitting(false);
        setProgressPhase('done');
        Alert.alert('Upload accepted', 'The server accepted this report. Open Previews to check its progress; local confirmation could not be refreshed.');
        return;
      }
      if (!draftSaved) {
        submissionIdRef.current = previousSubmissionId;
        supersedesSubmissionIdRef.current = previousSupersedesId;
        setSubmitting(false);
        setProgressPhase('error');
        Alert.alert('Draft not saved', 'Your latest changes could not be saved on this device. Keep this form and its originals open. Check device storage, then use Save on device before trying again. No upload was started.');
        return;
      }
      const conflictedSubmissionId = submissionIdRef.current;
      const canAct = () => operation.isActive() && recoveryScopeRef.current === attemptRecoveryScope && OfflineCaptureStore.getOwnerId() === attemptOwner && submissionIdRef.current === conflictedSubmissionId;

      if (!auctioneer && !supersedesSubmissionIdRef.current && e?.response?.status === 409 && e?.response?.data?.code === 'ACTIVE_REPORT_EXISTS') {
        setProgressPhase('error');
        setSubmitting(false);
        Alert.alert(
          'Report Already Processing',
          'An asset report for this contract is already queued or processing. Keep this draft and review it in Reports or Previews, or explicitly create a separate report with these photos.',
          [
            { text: 'Keep Draft', style: 'cancel' },
            {
              text: 'Create Separate',
              onPress: () => { if (canAct()) void handleSubmit({ forceNew: true }); },
            },
          ]
        );
        return;
      }

      setUploadPaused(true);
      await OfflineCaptureStore.setSubmissionState(attemptDraftId, 'paused', undefined, e?.message).catch(() => undefined);
      setProgressPhase('error');
      setSubmitting(false);
      if (showUploadManifestRecovery(e, !auctioneer && conflictedSubmissionId ? {
        replace: () => {
          if (canAct()) void handleSubmit({ replaceSubmissionId: conflictedSubmissionId, replacementSourceId: uploadConflictSource(e, conflictedSubmissionId) });
        },
        startSeparate: () => {
          if (canAct()) void handleSubmit({ newSubmissionFromId: conflictedSubmissionId });
        },
      } : undefined)) return;
      // The app stopped this upload by itself: wait for a steady connection and
      // continue while this report stays open. A Pause the person tapped stays.
      if (!pauseRequestedRef.current && autoResume.scheduleAfterFailure(e, {
        resume: (automatic) => { void handleSubmitRef.current({ nextLot: options.nextLot, automaticResume: automatic }); },
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

  const resetForm = () => {
    uploadAcceptedRef.current = false;
    draftIdentityRef.current = randomUUID();
    setReviewingSavedDraft(false); setDraftLoadError(undefined); reviewEventRef.current = randomUUID();
    setCaptureMode('online'); setManualSubmissionRequired(false); setLocalSavedAt(undefined); setLocalSaveError(undefined); setUploadPaused(false);
    submissionIdRef.current = null;
    supersedesSubmissionIdRef.current = undefined;
    setClientName('');
    setEffectiveDate(isoDate(new Date()));
    setAppraisalPurpose('');
    setOwnerName('');
    setAppraiser((user as any)?.username || '');
    setAppraisalCompany((user as any)?.companyName || '');
    setIndustry('');
    setInspectionDate(isoDate(new Date()));
    setContractNo('');
    setLanguage('en');
    setCurrency('');
    setPreparedFor('');
    setFactorsAgeCondition('');
    setFactorsQuality('');
    setFactorsAnalysis('');
    setIncludeDamageAnalysis(true);
    setEnhanceImages(false);
    setBankPhotosEnabled(false);
    setWatermarkImages(DEFAULT_IMAGE_WATERMARK);
    setHiddenLocation(null);
    setIncludeValuationTable(false);
    setSelectedValuationMethods(['FML']);
    setLots([]);
    setActiveStep('details');
    setProgressPhase('idle');
    setUploadProgress(0);
    setUploadStatus(null);
    setProgressData(null);
    setJobId(null);
    setErrors({});
    setCurrentDraftId(null);
    loadedDraftIdRef.current = null;
    // Re-detect currency
    detectCurrency();
  };

  const createLot = () => {
    if (auctioneer?.kind === 'scheduleA') return -1;
    if (!requireContractNumberForDraft()) return -1;
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newLot: MixedLot = {
      id,
      files: [],
      extraFiles: [],
      coverIndex: 0,
    };
    setLots((prev) => [...prev, newLot]);
    setActiveLotIdx(lots.length);
    return lots.length;
  };

  // Try again (below) runs the handler from the latest render, so it saves the
  // form as it is when tapped, not the snapshot from the failed tap.
  const openCameraForLotRef = useRef<(lotIdx: number) => Promise<void>>(async () => undefined);
  const openingCameraRef = useRef(false);
  const openCameraForLot = async (lotIdx: number) => {
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
        void openCameraForLotRef.current(lotIdx);
      }));
      return;
    } finally { openingCameraRef.current = false; }
    // Camera will auto-create lot if none exist
    // Just set the active index (can be -1 or 0, camera handles it)
    if (OfflineCaptureStore.getOwnerId() !== owner || recoveryScopeRef.current !== scope) return;
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
  };
  openCameraForLotRef.current = openCameraForLot;

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
    resetForm();
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

  const toggleValuationMethod = (method: 'FML' | 'TKV' | 'OLV' | 'FLV') => {
    setSelectedValuationMethods((prev) => {
      if (prev.includes(method)) {
        if (prev.length === 1) {
          Alert.alert('Warning', 'At least one valuation method must be selected');
          return prev;
        }
        return prev.filter((m) => m !== method);
      }
      return [...prev, method];
    });
  };

  const renderDetailsStep = () => (
    <ScrollView
      style={styles.formScroll}
      contentContainerStyle={styles.formContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}>
      <OfflineCapturePanel mode={captureMode} onChange={changeCaptureMode} lots={lots} savedAt={localSavedAt}
        manualSubmissionRequired={manualSubmissionRequired} reviewingSavedDraft={reviewingSavedDraft}
        error={localSaveError} disabled={submitting || savingDraftPreview} paused={uploadPaused}
        onSave={() => { void handleSaveDraftPreview(); }} />
      {/* Client Information Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Client Information</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Client Name *</Text>
          <TextInput
            accessibilityLabel="Client name, required"
            style={[styles.input, errors.clientName && styles.inputError]}
            value={clientName}
            onChangeText={(t) => {
              setClientName(t);
              clearError('clientName');
            }}
            placeholder="Enter client name"
            placeholderTextColor="#9CA3AF"
          />
          {errors.clientName && <Text style={styles.errorText}>{errors.clientName}</Text>}
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Owner Name</Text>
          <TextInput
            accessibilityLabel="Owner name"
            style={styles.input}
            value={ownerName}
            onChangeText={setOwnerName}
            placeholder="Enter owner name"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Prepared For</Text>
          <TextInput
            accessibilityLabel="Prepared for"
            style={styles.input}
            value={preparedFor}
            onChangeText={setPreparedFor}
            placeholder="Enter prepared for"
            placeholderTextColor="#9CA3AF"
          />
        </View>
      </View>

      {/* Appraisal Details Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appraisal Details</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Purpose of Appraisal *</Text>
          <TextInput
            accessibilityLabel="Purpose of appraisal, required"
            style={[styles.input, errors.appraisalPurpose && styles.inputError]}
            value={appraisalPurpose}
            onChangeText={(t) => {
              setAppraisalPurpose(t);
              clearError('appraisalPurpose');
            }}
            placeholder="e.g., Insurance, Sale, Donation"
            placeholderTextColor="#9CA3AF"
          />
          {errors.appraisalPurpose && (
            <Text style={styles.errorText}>{errors.appraisalPurpose}</Text>
          )}
        </View>

        <View style={[styles.row, compactFields && styles.stackedRow]}>
          <View style={[styles.fieldContainer, { flex: 1, marginRight: compactFields ? 0 : 8 }]}>
            <Text style={styles.fieldLabel}>Effective Date *</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Effective date, ${formatDateDisplay(effectiveDate)}`}
              style={[styles.datePickerButton, errors.effectiveDate && styles.inputError]}
              onPress={() => setShowEffectiveDatePicker(true)}>
              <Feather name="calendar" size={18} color="#6B7280" />
              <Text style={styles.datePickerText}>{formatDateDisplay(effectiveDate)}</Text>
            </TouchableOpacity>
            {showEffectiveDatePicker &&
              (Platform.OS === 'ios' ? (
                <Modal
                  transparent
                  animationType="slide"
                  visible={showEffectiveDatePicker}
                  onRequestClose={() => setShowEffectiveDatePicker(false)}>
                  <View style={styles.datePickerModalOverlay}>
                    <View style={styles.datePickerModalContent}>
                      <View style={styles.datePickerModalHeader}>
                        <TouchableOpacity onPress={() => setShowEffectiveDatePicker(false)}>
                          <Text style={styles.datePickerCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={styles.datePickerModalTitle}>Effective Date</Text>
                        <TouchableOpacity onPress={() => setShowEffectiveDatePicker(false)}>
                          <Text style={styles.datePickerDoneText}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        value={parseDate(effectiveDate)}
                        mode="date"
                        display="spinner"
                        onChange={handleEffectiveDateChange}
                        style={styles.iosDatePicker}
                      />
                    </View>
                  </View>
                </Modal>
              ) : (
                <DateTimePicker
                  value={parseDate(effectiveDate)}
                  mode="date"
                  display="default"
                  onChange={handleEffectiveDateChange}
                />
              ))}
          </View>
          <View style={[styles.fieldContainer, { flex: 1, marginLeft: compactFields ? 0 : 8 }]}>
            <Text style={styles.fieldLabel}>Inspection Date</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Inspection date, ${formatDateDisplay(inspectionDate)}`}
              style={styles.datePickerButton}
              onPress={() => setShowInspectionDatePicker(true)}>
              <Feather name="calendar" size={18} color="#6B7280" />
              <Text style={styles.datePickerText}>{formatDateDisplay(inspectionDate)}</Text>
            </TouchableOpacity>
            {showInspectionDatePicker &&
              (Platform.OS === 'ios' ? (
                <Modal
                  transparent
                  animationType="slide"
                  visible={showInspectionDatePicker}
                  onRequestClose={() => setShowInspectionDatePicker(false)}>
                  <View style={styles.datePickerModalOverlay}>
                    <View style={styles.datePickerModalContent}>
                      <View style={styles.datePickerModalHeader}>
                        <TouchableOpacity onPress={() => setShowInspectionDatePicker(false)}>
                          <Text style={styles.datePickerCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={styles.datePickerModalTitle}>Inspection Date</Text>
                        <TouchableOpacity onPress={() => setShowInspectionDatePicker(false)}>
                          <Text style={styles.datePickerDoneText}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        value={parseDate(inspectionDate)}
                        mode="date"
                        display="spinner"
                        onChange={handleInspectionDateChange}
                        style={styles.iosDatePicker}
                      />
                    </View>
                  </View>
                </Modal>
              ) : (
                <DateTimePicker
                  value={parseDate(inspectionDate)}
                  mode="date"
                  display="default"
                  onChange={handleInspectionDateChange}
                />
              ))}
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Industry</Text>
          <TextInput
            accessibilityLabel="Industry"
            style={styles.input}
            value={industry}
            onChangeText={setIndustry}
            placeholder="e.g., Manufacturing, Retail"
            placeholderTextColor="#9CA3AF"
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Contract No.</Text>
          <TextInput
            accessibilityLabel="Contract number"
            editable={!auctioneer}
            style={styles.input}
            value={contractNo}
            onChangeText={setContractNo}
            placeholder="Enter contract number"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>
      </View>

      {/* Appraiser Information Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appraiser Information</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Appraiser Name *</Text>
          <TextInput
            accessibilityLabel="Appraiser name, required"
            style={[styles.input, errors.appraiser && styles.inputError]}
            value={appraiser}
            onChangeText={(t) => {
              setAppraiser(t);
              clearError('appraiser');
            }}
            placeholder="Enter appraiser name"
            placeholderTextColor="#9CA3AF"
          />
          {errors.appraiser && <Text style={styles.errorText}>{errors.appraiser}</Text>}
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Appraisal Company</Text>
          <TextInput
            accessibilityLabel="Appraisal company"
            style={styles.input}
            value={appraisalCompany}
            onChangeText={setAppraisalCompany}
            placeholder="Enter company name"
            placeholderTextColor="#9CA3AF"
          />
        </View>
      </View>

      {/* Settings Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Settings</Text>

        <View style={[styles.row, compactFields && styles.stackedRow]}>
          <View style={[styles.fieldContainer, { flex: 1, marginRight: compactFields ? 0 : 8 }]}>
            <Text style={styles.fieldLabel}>Currency *</Text>
            <View style={styles.currencyContainer}>
              <TextInput
                accessibilityLabel="Currency code, required"
                style={[styles.input, styles.currencyInput, errors.currency && styles.inputError]}
                value={currency}
                onChangeText={(t) => {
                  setCurrency(t.toUpperCase());
                  clearError('currency');
                }}
                placeholder="CAD"
                placeholderTextColor="#9CA3AF"
                maxLength={3}
                autoCapitalize="characters"
              />
              {currencyLoading && (
                <ActivityIndicator size="small" color="#2563EB" style={styles.currencyLoader} />
              )}
            </View>
            {errors.currency && <Text style={styles.errorText}>{errors.currency}</Text>}
          </View>
          <View style={[styles.fieldContainer, { flex: 1, marginLeft: compactFields ? 0 : 8 }]}>
            <Text style={styles.fieldLabel}>Language</Text>
            <View style={styles.languageRow}>
              {(['en', 'fr', 'es'] as const).map((lang) => (
                <TouchableOpacity
                  key={lang}
                  style={[styles.langButton, language === lang && styles.langButtonActive]}
                  onPress={() => setLanguage(lang)}>
                  <Text style={[styles.langText, language === lang && styles.langTextActive]}>
                    {lang.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </View>

      {/* Valuation Methods Section */}
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.toggleRow}
          onPress={() => setIncludeValuationTable(!includeValuationTable)}>
          <Text style={styles.sectionTitle}>Include Valuation Table</Text>
          <View style={[styles.checkbox, includeValuationTable && styles.checkboxActive]}>
            {includeValuationTable && <Feather name="check" size={14} color="#fff" />}
          </View>
        </TouchableOpacity>

        {includeValuationTable && (
          <View style={styles.methodsGrid}>
            {(['FML', 'TKV', 'OLV', 'FLV'] as const).map((method) => (
              <TouchableOpacity
                key={method}
                style={[
                  styles.methodButton,
                  selectedValuationMethods.includes(method) && styles.methodButtonActive,
                ]}
                onPress={() => toggleValuationMethod(method)}>
                <Text
                  style={[
                    styles.methodText,
                    selectedValuationMethods.includes(method) && styles.methodTextActive,
                  ]}>
                  {method}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Factors Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assessment Factors (Optional)</Text>

        <View style={styles.fieldContainer}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.fieldLabel}>Damages</Text>
              <Text style={{ fontSize: 12, color: '#6B7280' }}>
                Applies only to lots 1000 and below. Higher lot numbers are excluded automatically.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setIncludeDamageAnalysis((prev) => !prev)}
              style={[
                styles.checkbox,
                includeDamageAnalysis && styles.checkboxActive,
              ]}>
              {includeDamageAnalysis && <Feather name="check" size={14} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.fieldLabel}>Bank</Text>
              <Text style={{ fontSize: 12, color: '#6B7280' }}>
                Include all lot photos in the CR.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setBankPhotosEnabled((prev) => !prev)}
              style={[
                styles.checkbox,
                bankPhotosEnabled && styles.checkboxActive,
              ]}>
              {bankPhotosEnabled && <Feather name="check" size={14} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.fieldLabel}>Apply watermark</Text>
              <Text style={{ fontSize: 12, color: '#6B7280' }}>
                For imported, unwatermarked photos only. Asset Insight camera photos already have a logo. Off by default.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setWatermarkImages((prev) => !prev)}
              accessibilityRole="switch"
              accessibilityState={{ checked: watermarkImages }}
              style={[
                styles.checkbox,
                watermarkImages && styles.checkboxActive,
              ]}>
              {watermarkImages && <Feather name="check" size={14} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Age & Condition</Text>
          <TextInput
            accessibilityLabel="Age and condition factors"
            style={[styles.input, styles.textArea]}
            value={factorsAgeCondition}
            onChangeText={setFactorsAgeCondition}
            placeholder="Describe age and condition factors..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Quality</Text>
          <TextInput
            accessibilityLabel="Quality factors"
            style={[styles.input, styles.textArea]}
            value={factorsQuality}
            onChangeText={setFactorsQuality}
            placeholder="Describe quality factors..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Analysis</Text>
          <TextInput
            accessibilityLabel="Analysis notes"
            style={[styles.input, styles.textArea]}
            value={factorsAnalysis}
            onChangeText={setFactorsAnalysis}
            placeholder="Additional analysis notes..."
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
          />
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtonsRow}>
        {/* Save Inputs Button */}
        <TouchableOpacity
          style={styles.saveInputsButton}
          onPress={saveInputs}
          disabled={savingInputs}>
          {savingInputs ? (
            <ActivityIndicator color="#059669" size="small" />
          ) : (
            <>
              <Feather name="save" size={18} color="#059669" />
              <Text style={styles.saveInputsButtonText}>Save Inputs</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Next Button */}
        <TouchableOpacity style={styles.nextButton} onPress={() => setActiveStep('images')}>
          <Text style={styles.nextButtonText}>Next: Add Images</Text>
          <Feather name="arrow-right" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.draftPreviewButton, (submitting || savingDraftPreview) && styles.buttonDisabled]}
        onPress={() => void handleSaveDraftPreview()}
        disabled={Boolean(auctioneer) || submitting || savingDraftPreview}>
        {savingDraftPreview ? (
          <ActivityIndicator color="#1D4ED8" size="small" />
        ) : (
          <Feather name="cloud" size={18} color="#1D4ED8" />
        )}
        <Text style={styles.draftPreviewButtonText}>
          {savingDraftPreview ? 'Saving Draft...' : captureMode === 'offline' || manualSubmissionRequired ? 'Save on device' : 'Save Draft & Create Preview'}
        </Text>
      </TouchableOpacity>

      {/* Submit Button - Also available on details page */}
      {!compactAuctioneerActions ? <TouchableOpacity
        style={[
          styles.submitButtonDetails,
          (submitting || (!saveOnly && lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0) === 0)) && styles.submitButtonDisabled,
        ]}
        onPress={() => void handleSubmit()}
        accessibilityRole="button" accessibilityLabel={saveOnly ? 'Save offline asset report' : uploadPaused ? 'Resume upload' : auctioneer ? 'Create Lot & Close' : 'Submit asset report'}
        disabled={submitting || (!saveOnly && lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0) === 0)}>
        {submitting ? (
          <>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={[styles.submitButtonText, { marginLeft: 8 }]}>
              {progressPhase === 'uploading' ? `${uploadProgress}%` : 'Processing...'}
            </Text>
          </>
        ) : (
          <>
            <Feather name={saveOnly ? 'save' : 'send'} size={18} color="#fff" />
            <Text style={styles.submitButtonText}>{saveOnly ? 'Save' : uploadPaused ? 'Resume upload' : auctioneer ? 'Create Lot & Close' : 'Submit Report'}</Text>
          </>
        )}
      </TouchableOpacity> : null}
    </ScrollView>
  );

  const renderUploadProgress = () => {
    // Calculate totals for display
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0
    );
    const totalLots = lots.filter(
      (lot) => lot.files.length > 0 || lot.extraFiles.length > 0
    ).length;
    const uploadStageTitle = uploadStatus?.stage === 'preparing'
      ? 'Preparing Images'
      : uploadStatus?.stage === 'creating_session'
        ? 'Starting Secure Upload'
        : uploadStatus?.stage === 'finalizing'
          ? 'Finalizing Report'
          : uploadStatus?.stage === 'complete'
            ? 'Upload Complete'
            : 'Uploading Images';

    return (
      <Modal testID="asset-upload-progress" visible={visible && submitting} transparent animationType="fade" onRequestClose={handlePauseUpload}>
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard} accessibilityViewIsModal>
              {progressPhase === 'uploading' && uploadStatus?.stage !== 'complete' && uploadStatus?.stage !== 'finalizing' && !uploadAcceptedRef.current ? (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={pausingUpload ? 'Pausing upload' : 'Pause upload'}
                  accessibilityState={{ disabled: pausingUpload }} disabled={pausingUpload} onPress={handlePauseUpload} style={{ minHeight: 44, padding: 12 }}>
                  <Text style={{ color: '#1D4ED8' }}>{pausingUpload ? 'Pausing upload…' : 'Pause upload'}</Text>
                </TouchableOpacity>
              ) : null}
              {/* Header with icon */}
              <View style={styles.progressHeader}>
                {progressPhase === 'done' ? (
                  <View style={[styles.progressIconBg, { backgroundColor: '#D1FAE5' }]}>
                    <Feather name="check" size={28} color="#059669" />
                  </View>
                ) : (
                  <View style={styles.progressIconBg}>
                    <ActivityIndicator size="large" color="#2563EB" />
                  </View>
                )}
                <Text style={styles.progressTitle}>
                  {pausingUpload ? 'Pausing upload…' : progressPhase === 'uploading'
                    ? uploadStageTitle
                    : progressPhase === 'done'
                      ? 'Complete!'
                      : 'Processing Report...'}
                </Text>
              </View>

              {/* Stats summary */}
              <View style={styles.progressStats}>
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalImages}</Text>
                  <Text style={styles.progressStatLabel}>Images</Text>
                </View>
                <View style={styles.progressStatDivider} />
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalLots}</Text>
                  <Text style={styles.progressStatLabel}>Lots</Text>
                </View>
              </View>

              {/* Progress Bar */}
              <View style={styles.progressBarContainer}>
                <View
                  style={[
                    styles.progressBar,
                    {
                      width: `${
                        progressPhase === 'uploading'
                          ? uploadProgress
                          : progressPhase === 'done'
                            ? 100
                            : (progressData?.serverProgress01 || 0) * 100
                      }%`,
                      backgroundColor: progressPhase === 'done' ? '#059669' : '#2563EB',
                    },
                  ]}
                />
              </View>

              <Text style={styles.progressText} accessibilityLiveRegion="polite">
                {pausingUpload ? 'Stopping this transfer. Your saved draft will stay available; tap Resume upload when ready.' : progressPhase === 'uploading'
                  ? uploadStatus?.message || `${uploadProgress}% uploaded`
                  : progressPhase === 'done'
                    ? 'Report submitted successfully!'
                    : progressData?.message || 'Please wait...'}
              </Text>

              {progressPhase === 'uploading' && !!uploadStatus?.totalFiles && (
                <View style={styles.uploadFileProgress}>
                  <Text style={styles.uploadFileProgressText}>
                    {uploadProgress}%
                  </Text>
                  <Text style={styles.uploadFileProgressText}>
                    {uploadStatus.completedFiles} / {uploadStatus.totalFiles} files
                  </Text>
                </View>
              )}
              {progressPhase === 'uploading' && !!uploadStatus?.activeFileName && (
                <Text style={styles.uploadActiveFile} numberOfLines={1}>
                  {uploadStatus.activeFileName}
                </Text>
              )}

              {/* Step indicators */}
              {progressData?.steps && progressData.steps.length > 0 && (
                <View style={styles.stepsContainer}>
                  {progressData.steps.slice(-4).map((step, idx) => (
                    <View key={step.key || idx} style={styles.stepRow}>
                      <Feather
                        name={step.endedAt ? 'check-circle' : 'loader'}
                        size={14}
                        color={step.endedAt ? '#059669' : '#2563EB'}
                      />
                      <Text style={[styles.stepText, step.endedAt && styles.stepTextDone]}>
                        {step.label}
                      </Text>
                      {step.durationMs && (
                        <Text style={styles.stepDuration}>
                          {(step.durationMs / 1000).toFixed(1)}s
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              {/* Processing info */}
              {progressPhase === 'processing' && !progressData?.steps?.length && (
                <Text style={styles.progressHint}>Software is analyzing your images...</Text>
              )}
            </View>
          </View>
      </Modal>
    );
  };

  const renderImagesStep = () => {
    const totalImages = lots.reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0);
    return (
      <View style={styles.imagesContainer}>

        <ScrollView testID="asset-images-scroll" style={styles.imagesScroll}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <OfflineCapturePanel mode={captureMode} onChange={changeCaptureMode} lots={lots} savedAt={localSavedAt}
          manualSubmissionRequired={manualSubmissionRequired} reviewingSavedDraft={reviewingSavedDraft}
          error={localSaveError} disabled={submitting || savingDraftPreview} paused={uploadPaused}
          onSave={() => { void handleSaveDraftPreview(); }} />
        <LotManager
          embedded
          lockedStructure={auctioneer?.kind === 'scheduleA'}
          sourceLabels={auctioneer?.kind === 'scheduleA' ? auctioneer.lots.map((lot, index) => lot.lotNumber ? `Lot ${lot.lotNumber}` : `Lot ${index + 1}`) : undefined}
          lots={lots}
          setLots={setLots}
          activeLotIdx={activeLotIdx}
          setActiveLotIdx={setActiveLotIdx}
          onOpenCamera={openCameraForLot}
          onCreateLot={createLot}
        />
        </ScrollView>

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.backButton, submitting && styles.buttonDisabled]}
            onPress={() => setActiveStep('details')}
            disabled={submitting}>
            <Feather name="arrow-left" size={20} color="#374151" />
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionDraftButton, (submitting || savingDraftPreview) && styles.buttonDisabled]}
            onPress={() => void handleSaveDraftPreview()}
            disabled={Boolean(auctioneer) || submitting || savingDraftPreview}>
            {savingDraftPreview ? (
              <ActivityIndicator color="#1D4ED8" size="small" />
            ) : (
              <Feather name="cloud" size={18} color="#1D4ED8" />
            )}
            <Text style={styles.actionDraftButtonText}>Draft</Text>
          </TouchableOpacity>

          {!compactAuctioneerActions ? <TouchableOpacity
            style={[
              styles.submitButton,
              (submitting || (!saveOnly && totalImages === 0)) && styles.submitButtonDisabled,
            ]}
            onPress={() => void handleSubmit()}
            accessibilityRole="button" accessibilityLabel={saveOnly ? 'Save offline asset report' : uploadPaused ? 'Resume upload' : auctioneer ? 'Create Lot & Close' : 'Submit asset report'}
            disabled={submitting || (!saveOnly && totalImages === 0)}>
            {submitting ? (
              <>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={[styles.submitButtonText, { marginLeft: 8 }]}>
                  {progressPhase === 'uploading' ? `${uploadProgress}%` : 'Processing...'}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.submitButtonText}>{saveOnly ? 'Save' : uploadPaused ? 'Resume upload' : auctioneer ? 'Create Lot & Close' : 'Submit Report'}</Text>
                <Feather name={saveOnly ? 'save' : 'send'} size={18} color="#fff" />
              </>
            )}
          </TouchableOpacity> : null}
        </View>
      </View>
    );
  };

  if (visible && (awaitingDraft || savingLocal)) return <DraftStorageStatus saving={savingLocal} error={draftLoadError}
    onRetry={() => setDraftLoadAttempt(value => value + 1)} onClose={() => { resetForm(); onClose(); }} />;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close asset appraisal">
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Asset Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.stepIndicator}>
              <View style={[styles.stepDot, activeStep === 'details' && styles.stepDotActive]} />
              <View style={styles.stepLine} />
              <View style={[styles.stepDot, activeStep === 'images' && styles.stepDotActive]} />
            </View>
          </View>
        </View>
        {compactAuctioneerActions && auctioneer ? <AuctioneerFormHeader setup={auctioneer}
          disabled={submitting || savingDraftPreview || !lots.some((lot) => lot.files.length > 0)}
          closeDisabled={submitting || savingDraftPreview || !lots.some((lot) => lot.files.length + lot.extraFiles.length > 0)}
          submitting={submitting} paused={uploadPaused}
          onPress={() => void handleSubmit({ nextLot: true })}
          onSubmit={() => void handleSubmit()} /> : null}

        <Modal visible={savingDraftPreview} transparent animationType="fade">
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <View style={styles.progressIconBg}>
                <ActivityIndicator size="large" color="#2563EB" />
              </View>
              <Text style={styles.progressTitle}>Saving Draft to Cloud</Text>
              <Text style={styles.draftProgressText}>
                Uploading and verifying draft media, then starting preview processing. Keep the app open until this finishes.
              </Text>
            </View>
          </View>
        </Modal>
        {renderUploadProgress()}
        <UploadWaitingForSignal testID="asset-upload-waiting" visible={visible && autoResume.waiting}
          completedFiles={uploadStatus?.completedFiles} totalFiles={uploadStatus?.totalFiles}
          onResumeNow={autoResume.resumeNow} onPause={autoResume.stop} />

        {/* 3D Tab Navigation */}
        <View style={styles.tabContainer}>
          <View style={styles.tabBackground}>
            <View
              style={[
                styles.tabSlider,
                {
                  left: activeStep === 'details' ? 4 : '50%',
                },
              ]}
            />
          </View>
          <TouchableOpacity
            style={[styles.tabButton, activeStep === 'details' && styles.tabButtonActive]}
            accessibilityRole="tab" accessibilityLabel="Details"
            accessibilityState={{ selected: activeStep === 'details', disabled: submitting || savingDraftPreview }}
            disabled={submitting || savingDraftPreview}
            onPress={() => setActiveStep('details')}
            activeOpacity={0.7}>
            <View style={styles.tabIconContainer}>
              <Feather
                name="file-text"
                size={20}
                color={activeStep === 'details' ? '#FFFFFF' : '#6B7280'}
              />
            </View>
            <Text style={[styles.tabText, activeStep === 'details' && styles.tabTextActive]}>
              Details
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeStep === 'images' && styles.tabButtonActive]}
            accessibilityRole="tab" accessibilityLabel="Images"
            accessibilityState={{ selected: activeStep === 'images', disabled: submitting || savingDraftPreview }}
            disabled={submitting || savingDraftPreview}
            onPress={() => setActiveStep('images')}
            activeOpacity={0.7}>
            <View style={styles.tabIconContainer}>
              <Feather
                name="image"
                size={20}
                color={activeStep === 'images' ? '#FFFFFF' : '#6B7280'}
              />
            </View>
            <Text style={[styles.tabText, activeStep === 'images' && styles.tabTextActive]}>
              Images
            </Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <KeyboardAvoidingView
          testID="asset-form-keyboard-layout"
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.content}>
          {activeStep === 'details' ? renderDetailsStep() : renderImagesStep()}
        </KeyboardAvoidingView>

        {/* Camera Modal */}
        <CameraCapture
            captureContext={visible && OfflineCaptureStore.getOwnerId() ? { ownerId: OfflineCaptureStore.getOwnerId()!, draftId: currentDraftId || draftIdentityRef.current, sessionId: currentDraftId || draftIdentityRef.current } : undefined}
            manualSubmissionRequired={captureMode === 'offline' || manualSubmissionRequired}
            visible={cameraOpen}
            lockedStructure={auctioneer?.kind === 'scheduleA'}
            sourceLabels={auctioneer?.kind === 'scheduleA' ? auctioneer.lots.map((lot, index) => lot.lotNumber ? `Lot ${lot.lotNumber}` : `Lot ${index + 1}`) : undefined}
            onClose={() => setCameraOpen(false)}
            lots={lots}
            setLots={setLots}
            activeLotIdx={activeLotIdx}
            setActiveLotIdx={setActiveLotIdx}
            onAutoSave={triggerAutoSave}
            enhanceImages={enhanceImages}
            onEnhanceChange={setEnhanceImages}
          />

        {/* Restore Auto-Save Prompt Modal */}
        <Modal
          visible={showRestorePrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowRestorePrompt(false)}>
          <View style={styles.restoreModalOverlay}>
            <View style={styles.restoreModalContent}>
              <View style={styles.restoreModalIcon}>
                <Feather name="refresh-cw" size={32} color="#2563EB" />
              </View>
              <Text style={styles.restoreModalTitle}>Restore Previous Session?</Text>
              <Text style={styles.restoreModalText}>
                Found {autoSaveInfo?.totalImages || 0} images from {autoSaveInfo?.totalLots || 0}{' '}
                lot(s)
                {autoSaveInfo?.savedAt &&
                  `\nSaved: ${new Date(autoSaveInfo.savedAt).toLocaleString()}`}
              </Text>
              <View style={styles.restoreModalButtons}>
                <TouchableOpacity
                  style={styles.restoreModalBtnDiscard}
                  onPress={handleDiscardAutoSave}>
                  <Feather name="trash-2" size={16} color="#EF4444" />
                  <Text style={styles.restoreModalBtnDiscardText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.restoreModalBtnRestore}
                  onPress={handleRestoreAutoSave}>
                  <Feather name="download" size={16} color="#fff" />
                  <Text style={styles.restoreModalBtnRestoreText}>Restore</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    flex: 1,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#D1D5DB',
  },
  stepDotActive: {
    backgroundColor: '#2563EB',
  },
  stepLine: {
    width: 24,
    height: 2,
    backgroundColor: '#D1D5DB',
    marginHorizontal: 4,
  },
  // 3D Tab Navigation Styles
  tabContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    marginHorizontal: 16,
    marginVertical: 12,
    borderRadius: 16,
    padding: 4,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  tabBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  tabSlider: {
    position: 'absolute',
    width: '48%',
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 12,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 1,
  },
  tabButtonActive: {
    // Active state handled by slider background
  },
  tabIconContainer: {
    // Icon container for better alignment
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  formScroll: {
    flex: 1,
  },
  formContent: {
    width: '100%',
    maxWidth: 920,
    alignSelf: 'center',
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.04)',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1F2937',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  fieldContainer: {
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#DC2626',
  },
  // Date picker styles
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  datePickerText: {
    flex: 1,
    fontSize: 15,
    color: '#1F2937',
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
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    color: '#2563EB',
  },
  iosDatePicker: {
    height: 200,
  },
  errorText: {
    fontSize: 12,
    color: '#DC2626',
    marginTop: 4,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
  },
  stackedRow: { flexDirection: 'column' },
  currencyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currencyInput: {
    flex: 1,
  },
  currencyLoader: {
    marginLeft: -32,
    marginRight: 8,
  },
  languageRow: {
    flexDirection: 'row',
  },
  langButton: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingVertical: 10,
    alignItems: 'center',
    marginRight: 4,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  langButtonActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.3,
    elevation: 4,
  },
  langText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  langTextActive: {
    color: '#fff',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  methodsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  methodButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    marginRight: 8,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  methodButtonActive: {
    backgroundColor: '#DBEAFE',
    borderColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.2,
    elevation: 3,
  },
  methodText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  methodTextActive: {
    color: '#2563EB',
    fontWeight: '700',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  saveInputsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D1FAE5',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#059669',
    gap: 6,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  saveInputsButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
  },
  nextButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 14,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  nextButtonText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#fff',
    marginRight: 6,
    letterSpacing: -0.3,
  },
  draftPreviewButton: {
    minHeight: 48,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  draftPreviewButtonText: {
    color: '#1D4ED8',
    fontSize: 14,
    fontWeight: '800',
  },
  imagesContainer: {
    flex: 1,
    minHeight: 0,
  },
  imagesScroll: { flex: 1, minHeight: 0 },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#fff',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    minHeight: 44,
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    marginLeft: 6,
  },
  actionDraftButton: {
    minWidth: 76,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
  },
  actionDraftButtonText: {
    color: '#1D4ED8',
    fontSize: 13,
    fontWeight: '800',
  },
  submitButton: {
    flex: 1,
    minWidth: 160,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    borderRadius: 10,
    paddingVertical: 14,
  },
  submitButtonDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 12,
    marginBottom: 20,
    gap: 8,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    marginRight: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  // Progress UI styles
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 22,
    width: '85%',
    maxWidth: 340,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 14,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.05)',
  },
  progressHeader: {
    alignItems: 'center',
    marginBottom: 16,
  },
  progressIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    textAlign: 'center',
  },
  draftProgressText: {
    color: '#6B7280',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 4,
  },
  progressStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
  },
  progressStat: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  progressStatValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  progressStatLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  progressStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#E5E7EB',
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 12,
  },
  uploadFileProgress: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: -4,
    marginBottom: 8,
  },
  uploadFileProgressText: {
    color: '#4B5563',
    fontSize: 13,
    fontWeight: '700',
  },
  uploadActiveFile: {
    width: '100%',
    color: '#9CA3AF',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  stepsContainer: {
    width: '100%',
    marginTop: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  stepText: {
    fontSize: 13,
    color: '#374151',
    marginLeft: 8,
    flex: 1,
  },
  stepTextDone: {
    color: '#059669',
  },
  stepDuration: {
    fontSize: 11,
    color: '#9CA3AF',
    marginLeft: 8,
  },
  progressHint: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 8,
  },
  // Restore modal styles
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
    elevation: 12,
  },
  restoreModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  restoreModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 8,
    textAlign: 'center',
  },
  restoreModalText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  restoreModalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  restoreModalBtnDiscard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#FEE2E2',
    gap: 6,
  },
  restoreModalBtnDiscardText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#EF4444',
  },
  restoreModalBtnRestore: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#2563EB',
    gap: 6,
  },
  restoreModalBtnRestoreText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
});

export default function AssetFormWithAuctioneer(props: AssetFormSheetProps) {
  const draftSessionRef = useRef<string | null>(props.draftIdToLoad || null);
  if (!props.visible) draftSessionRef.current = null;
  else if (props.draftIdToLoad) draftSessionRef.current = props.draftIdToLoad;
  const sessionDraftId = draftSessionRef.current;
  if (!props.auctioneer && !sessionDraftId) return <AssetFormSheet {...props} />;
  return <AuctioneerFormBoundary visible={props.visible} type="asset" setup={props.auctioneer}
    draftIdToLoad={sessionDraftId} onClose={props.onClose} onSetupChange={props.onAuctioneerSetupChange}>
    {(control) => <AssetFormSheet {...props} auctioneerControl={control}
      savedInputData={control ? undefined : props.savedInputData}
      draftIdToLoad={control?.draftIdToLoad || (control && !control.restoreDraft ? undefined : sessionDraftId)} />}
  </AuctioneerFormBoundary>;
}
