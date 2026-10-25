import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Dimensions,
  useWindowDimensions,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  PanResponder,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import TextInput from "../components/forms/ListingTextInput";
import KeyboardSafeViewport from "../components/KeyboardSafeViewport";
import PreviewLotNavigation from "../components/PreviewLotNavigation";
import { Feather } from "@expo/vector-icons";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import { ensurePhotoPickerAccess } from "../utils/photoPickerAccess";
import {
  Canvas,
  drawAsImage,
  Group,
  ImageFormat,
  Path as SkiaPathNode,
  Skia,
} from "@shopify/react-native-skia";
import api from "../services/api";
import { API_ENDPOINTS } from "../config/api";
import assetService from "../services/assetService";
import lotListingService from "../services/lotListingService";
import assignedApprovalService from "../services/assignedApprovalService";
import {
  ConditionSelectionKey,
} from "../utils/conditionSelections";
import {
  applyDamageAnalysisLotPolicy,
  getLotNumberForDamagePolicy,
  isDamageAnalysisEligibleForLot,
} from "../utils/lotDamagePolicy";
import {
  removeGalleryPhotoEntry,
  removeLotPhotoReference,
} from "../utils/previewPhotoDeletion";
import {
  applyPrimarySerialEdit,
} from "../utils/previewSerialNumber";
import { applyPreviewSpecEdit, previewSpecFieldKey } from "../utils/previewSpecEdits";
import { getPreviewLotPhotoEntries } from "../utils/previewLotPhotos";
import FarmlandValuationSummary from "../components/FarmlandValuationSummary";
import { realEstateSubmissionPath, shouldResubmitRealEstate } from "../utils/realEstateSubmission";
import {
  applyLotConditionSelection,
  applyRunningConditionSelectionToLot,
  applySelectedLotCondition,
  toggleAssetLotSelection,
} from "../utils/assetConditionSelection";
import {
  AssetBulkConditionControls,
  AssetLotConditionEditor,
} from "../components/reports/AssetConditionControls";

const FileSystem = require("expo-file-system/legacy");
const { width: SCREEN_WIDTH } = Dimensions.get("window");
const SIGNATURE_OUTPUT_WIDTH = 900;
const SIGNATURE_OUTPUT_HEIGHT = 260;
type SignaturePoint = { x: number; y: number };
type SignatureStroke = SignaturePoint[];
type SpecFieldEditorState = {
  lotIndex: number;
  fieldName: string;
  draftFieldName?: string;
  value: string;
  lotLabel: string;
  lotTitle: string;
  isNew?: boolean;
  isDamage?: boolean;
  error?: string;
  notice?: string;
};

type GalleryEntry = {
  url: string;
  globalIndex: number | null;
  lotIndex: number | null;
  context: "lot" | "report";
};

const clampSignaturePoint = (value: number) => Math.max(0, Math.min(1, value));

const buildSignaturePath = (
  stroke: SignatureStroke,
  width: number,
  height: number
) => {
  const path = Skia.Path.Make();
  const [firstPoint] = stroke;
  if (!firstPoint) return path;

  path.moveTo(firstPoint.x * width, firstPoint.y * height);
  if (stroke.length === 1) {
    path.lineTo(firstPoint.x * width + 0.1, firstPoint.y * height + 0.1);
    return path;
  }

  for (let i = 1; i < stroke.length; i += 1) {
    const point = stroke[i];
    path.lineTo(point.x * width, point.y * height);
  }
  return path;
};

interface SignaturePadProps {
  value?: string;
  disabled?: boolean;
  themeColor: string;
  onChange: (value: string | null) => void;
}

const AppraiserSignaturePad = ({
  value,
  disabled,
  themeColor,
  onChange,
}: SignaturePadProps) => {
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const strokesRef = useRef<SignatureStroke[]>([]);
  const drawingRef = useRef(false);

  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const exportSignature = useCallback(
    async (nextStrokes: SignatureStroke[]) => {
      const usefulStrokes = nextStrokes.filter((stroke) => stroke.length > 0);
      if (usefulStrokes.length === 0) {
        onChange(null);
        return;
      }

      try {
        const rendered = await drawAsImage(
          <Group>
            {usefulStrokes.map((stroke, index) => (
              <SkiaPathNode
                key={`export-${index}`}
                path={buildSignaturePath(
                  stroke,
                  SIGNATURE_OUTPUT_WIDTH,
                  SIGNATURE_OUTPUT_HEIGHT
                )}
                color="#111827"
                style="stroke"
                strokeWidth={9}
                strokeCap="round"
                strokeJoin="round"
              />
            ))}
          </Group>,
          { width: SIGNATURE_OUTPUT_WIDTH, height: SIGNATURE_OUTPUT_HEIGHT }
        );

        if (!rendered) {
          throw new Error("Unable to render signature.");
        }

        const base64 = rendered.encodeToBase64(ImageFormat.PNG, 100);
        onChange(`data:image/png;base64,${base64}`);
      } catch (error) {
        console.error("[PreviewSignature] Export failed:", error);
        Alert.alert("Signature", "Unable to save the signature. Please try again.");
      }
    },
    [onChange]
  );

  const getPoint = useCallback(
    (locationX: number, locationY: number): SignaturePoint => ({
      x: clampSignaturePoint(locationX / Math.max(canvasSize.width, 1)),
      y: clampSignaturePoint(locationY / Math.max(canvasSize.height, 1)),
    }),
    [canvasSize.height, canvasSize.width]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          if (disabled) return;
          drawingRef.current = true;
          const point = getPoint(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY
          );
          const nextStrokes = [...(value ? [] : strokesRef.current), [point]];
          strokesRef.current = nextStrokes;
          setStrokes(nextStrokes);
        },
        onPanResponderMove: (event) => {
          if (disabled || !drawingRef.current) return;
          const point = getPoint(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY
          );
          const nextStrokes = [...strokesRef.current];
          const lastStroke = [...(nextStrokes[nextStrokes.length - 1] || [])];
          const previous = lastStroke[lastStroke.length - 1];
          if (
            previous &&
            Math.abs(previous.x - point.x) < 0.002 &&
            Math.abs(previous.y - point.y) < 0.002
          ) {
            return;
          }
          lastStroke.push(point);
          nextStrokes[nextStrokes.length - 1] = lastStroke;
          strokesRef.current = nextStrokes;
          setStrokes(nextStrokes);
        },
        onPanResponderRelease: () => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          void exportSignature(strokesRef.current);
        },
        onPanResponderTerminate: () => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          void exportSignature(strokesRef.current);
        },
      }),
    [disabled, exportSignature, getPoint, value]
  );

  const handleClear = () => {
    if (disabled) return;
    strokesRef.current = [];
    setStrokes([]);
    onChange(null);
  };

  return (
    <View style={styles.signatureCard}>
      <View style={styles.signatureHeader}>
        <View style={styles.signatureHeaderText}>
          <Text style={styles.signatureTitle}>Appraiser Signature</Text>
          <Text style={styles.signatureSubtitle}>
            Added to the DOCX appraisal signature areas.
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.signatureClearBtn,
            (!value || disabled) && styles.signatureClearBtnDisabled,
          ]}
          onPress={handleClear}
          disabled={!value || disabled}
          activeOpacity={0.85}
        >
          <Feather name="x" size={14} color="#374151" />
          <Text style={styles.signatureClearText}>Clear</Text>
        </TouchableOpacity>
      </View>
      <View
        style={styles.signatureCanvasWrap}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setCanvasSize({
            width: Math.max(width, 1),
            height: Math.max(height, 1),
          });
        }}
        {...panResponder.panHandlers}
      >
        {value && strokes.length === 0 ? (
          <Image
            source={{ uri: value }}
            resizeMode="contain"
            style={styles.signaturePreviewImage}
          />
        ) : null}
        <Canvas style={styles.signatureCanvas}>
          {strokes.map((stroke, index) => (
            <SkiaPathNode
              key={`signature-${index}`}
              path={buildSignaturePath(stroke, canvasSize.width, canvasSize.height)}
              color="#111827"
              style="stroke"
              strokeWidth={4}
              strokeCap="round"
              strokeJoin="round"
            />
          ))}
        </Canvas>
        {!value && strokes.length === 0 ? (
          <Text style={styles.signaturePlaceholder}>Draw signature here</Text>
        ) : null}
      </View>
      <Text style={[styles.signatureStatus, value ? { color: themeColor } : null]}>
        {value ? "Signature ready. Save changes to keep it." : "Draw, then tap Save."}
      </Text>
    </View>
  );
};

interface PreviewScreenProps {
  reportId: string;
  reportType: "Asset" | "RealEstate" | "LotListing";
  mode: "pending" | "submitted";
  source?: "owner" | "assignedApproval";
  onBack: () => void;
  onSuccess?: () => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
}

interface LotListingLot {
  lot_id?: string;
  lot_number?: string | number;
  title?: string;
  description?: string;
  details?: string | null;
  damage_analysis?: string | null;
  condition_report_specs?: Record<string, string>;
  condition_report_specs_reviewed?: boolean;
  condition_report_specs_deleted?: string[];
  condition_report_specs_custom_order?: string[];
  lotted_by?: string | null;
  estimated_value?: string | null; // FMV as string
  quantity?: number;
  must_take?: boolean | null;
  categories?: string | null;
  serial_number?: string | null; // VIN/SN
  show_on_website?: boolean | null;
  close_date?: string | null;
  bid_increment?: number | null;
  location?: string | null;
  opening_bid?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  item_condition?: string | null;
  tags?: string[];
  image_indexes?: number[];
  image_urls?: string[];
  extra_image_indexes?: number[];
  extra_image_urls?: string[];
  cover_index?: number;
  sub_mode?: string;
  condition_report_selections?: Record<string, string>;
}

interface AssetLot {
  lot_id?: string | number;
  lot_number?: string | number;
  title?: string;
  description?: string;
  details?: string;
  damage_analysis?: string | null;
  condition_report_specs?: Record<string, string>;
  condition_report_specs_reviewed?: boolean;
  condition_report_specs_deleted?: string[];
  condition_report_specs_custom_order?: string[];
  estimated_value?: string;
  categories?: string | null;
  serial_number?: string | null;
  image_indexes?: number[];
  image_index?: number;
  image_urls?: string[];
  extra_image_indexes?: number[];
  extra_image_urls?: string[];
  mixed_group_index?: number;
  sub_mode?: string;
  condition_report_selections?: Record<string, string>;
}

interface AssetCategorySpec {
  parentCategory: string;
  childCategory: string;
  fields: string[];
}

const PreviewScreen = ({
  reportId,
  reportType,
  mode,
  source = "owner",
  onBack,
  onSuccess,
  unreadCount = 0,
  onOpenNotifications,
}: PreviewScreenProps) => {
  const { width, fontScale } = useWindowDimensions();
  const compactFields = width < 480 || fontScale > 1.3;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  
  // Common data
  const [status, setStatus] = useState<string>("");
  const [declineReason, setDeclineReason] = useState<string>("");
  const [previewData, setPreviewData] = useState<any>(null);
  const previewDataRef = useRef(previewData);
  previewDataRef.current = previewData;
  const [filesGenerating, setFilesGenerating] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [imageCount, setImageCount] = useState(0);
  const [categorySpecs, setCategorySpecs] = useState<AssetCategorySpec[]>([]);
  const [previewFiles, setPreviewFiles] = useState<Record<string, string>>({});
  const [expandedSpecSections, setExpandedSpecSections] = useState<Record<string, boolean>>({});
  
  // Asset specific
  const [groupingMode, setGroupingMode] = useState<string>("");
  const [selectedAssetLots, setSelectedAssetLots] = useState<Set<number>>(
    () => new Set()
  );
  const selectedAssetLotsRef = useRef<Set<number>>(new Set());
  const [assetSelectionEpoch, setAssetSelectionEpoch] = useState(0);
  const previewRequestRevisionRef = useRef(0);
  const reportContextKey = `${reportType}:${reportId}:${mode}:${source}`;
  const reportContextRef = useRef(reportContextKey);
  reportContextRef.current = reportContextKey;
  const previewScrollRef = useRef<ScrollView>(null);
  const previewContentRef = useRef<View>(null);
  const firstLotRef = useRef<View>(null);
  const lastLotRef = useRef<View>(null);
  const jumpToLot = useCallback((edge: 'first' | 'last') => {
    const target = edge === 'first' ? firstLotRef.current : lastLotRef.current;
    const content = previewContentRef.current;
    const context = reportContextRef.current;
    if (!target || !content) return;
    target.measureLayout(content, (_x, y) => {
      if (reportContextRef.current !== context) return;
      previewScrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
    }, () => undefined);
  }, []);
  const selectionContextRef = useRef(reportContextKey);
  const resetAssetLotSelection = useCallback(() => {
    selectedAssetLotsRef.current = new Set();
    selectionContextRef.current = reportContextRef.current;
    setSelectedAssetLots(new Set());
    setAssetSelectionEpoch((value) => value + 1);
  }, []);
  
  // Real Estate specific
  const [propertyType, setPropertyType] = useState<string>("");
  const [language, setLanguage] = useState<string>("en");
  
  // Image gallery
  const [galleryVisible, setGalleryVisible] = useState(false);
  const [galleryEntries, setGalleryEntries] = useState<GalleryEntry[]>([]);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [specFieldEditor, setSpecFieldEditor] = useState<SpecFieldEditorState | null>(null);
  const [uploadingLotKey, setUploadingLotKey] = useState<string | null>(null);
  const lastSpecTapRef = useRef<{ key: string; time: number } | null>(null);
  const previewBusyRef = useRef(false);
  previewBusyRef.current =
    loading || refreshing || saving || submitting || filesGenerating || uploadingLotKey !== null;

  const isAsset = reportType === "Asset";
  const isLotListing = reportType === "LotListing";
  const isAssignedApproval = source === "assignedApproval";
  const resubmitMode = isAssignedApproval || (reportType === "RealEstate"
    ? shouldResubmitRealEstate(status, mode)
    : status ? ["pending_approval", "approved", "error"].includes(status) : mode === "submitted");
  const generationLabel = isAssignedApproval ? "Save & Approve" : "Save";
  const themeColor = isAsset ? "#F43F5E" : isLotListing ? "#8B5CF6" : "#10B981";

  const getLotDisplayNumber = (lot: any, index: number) => {
    const candidates = [lot?.lot_number, lot?.lot_id, lot?.lot, lot?.id];
    for (const candidate of candidates) {
      const text = String(candidate ?? "").trim();
      if (text) return text;
    }
    return String(index + 1);
  };

  const duplicateLotNumberKeys = useMemo(() => {
    if (!previewData?.is_merged_report || !Array.isArray(previewData?.lots)) {
      return new Set<string>();
    }
    const counts = new Map<string, number>();
    previewData.lots.forEach((lot: any, index: number) => {
      const key = String(lot?.lot_number ?? getLotDisplayNumber(lot, index)).trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    );
  }, [previewData]);

  const isDuplicateLotNumber = (lot: any, index: number) =>
    duplicateLotNumberKeys.has(
      String(lot?.lot_number ?? getLotDisplayNumber(lot, index)).trim().toLowerCase()
    );

  const normalizeEditableLotNumber = (value: unknown) =>
    String(value ?? "")
      .trim()
      .replace(/^(?:lot\s*#\s*|lot\s+|#\s*)/i, "")
      .trim();

  const getLotUploadKey = (lot: any, index: number) =>
    String(lot?.lot_id || lot?.id || lot?.lot_number || index);

  const getLotPhotoEntries = (lot: any) =>
    getPreviewLotPhotoEntries(lot, imageUrls);

  const mergeSavedPreviewWithLocalLotNumbers = React.useCallback((savedPreview: any, localPreview: any) => {
    if (!savedPreview || !Array.isArray(savedPreview.lots) || !Array.isArray(localPreview?.lots)) {
      return savedPreview;
    }

    const localLots = localPreview.lots;
    const findLocalLot = (savedLot: any, index: number) => {
      const savedKeys = [savedLot?.lot_id, savedLot?.id, savedLot?._id]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
      if (savedKeys.length > 0) {
        const matched = localLots.find((localLot: any) => {
          const localKeys = [localLot?.lot_id, localLot?.id, localLot?._id]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean);
          return localKeys.some((key) => savedKeys.includes(key));
        });
        if (matched) return matched;
      }
      return localLots[index];
    };

    return {
      ...savedPreview,
      lots: savedPreview.lots.map((savedLot: any, index: number) => {
        const localLot = findLocalLot(savedLot, index);
        if (!localLot || !Object.prototype.hasOwnProperty.call(localLot, "lot_number")) {
          return savedLot;
        }
        const localLotNumber = normalizeEditableLotNumber(localLot.lot_number);
        return localLotNumber
          ? { ...savedLot, lot_number: localLotNumber }
          : savedLot;
      }),
    };
  }, []);

  const loadPreviewData = useCallback(async () => {
    const requestRevision = ++previewRequestRevisionRef.current;
    const isCurrent = () =>
      reportContextRef.current === reportContextKey &&
      previewRequestRevisionRef.current === requestRevision;
    resetAssetLotSelection();
    try {
      setLoading(true);
      setSaving(false);
      setSubmitting(false);
      setUploadingLotKey(null);

      let endpoint = "";
      if (!isAssignedApproval) {
        if (mode === "submitted") {
          if (isAsset) endpoint = `${API_ENDPOINTS.GET_PREVIEW}/${reportId}/submitted-preview`;
          else if (isLotListing) endpoint = `/lot-listing/${reportId}/submitted-preview`;
          else endpoint = `/real-estate/${reportId}/submitted-preview`;
        } else {
          if (isAsset) endpoint = `${API_ENDPOINTS.GET_PREVIEW}/${reportId}/preview`;
          else if (isLotListing) endpoint = `/lot-listing/${reportId}/preview`;
          else endpoint = `${API_ENDPOINTS.GET_REAL_ESTATE_PREVIEW}/${reportId}`;
        }
      }

      const [previewResponse, categorySpecResponse] = await Promise.all([
        isAssignedApproval
          ? assignedApprovalService.getPreview(reportId)
          : api.get(endpoint).then((response) => response.data.data),
        isAsset || isLotListing
          ? api.get("/asset/category-specs").catch(() => ({ data: { data: { specs: [] } } }))
          : Promise.resolve({ data: { data: { specs: [] } } }),
      ]);
      if (!isCurrent()) return;
      const data = previewResponse;
      setCategorySpecs(categorySpecResponse.data?.data?.specs || []);

      setStatus(data.status || "");
      setFilesGenerating(Boolean(data.files_generating || data.files_regenerating));
      setDeclineReason(data.decline_reason || "");
      const nextPreviewData = data.preview_data || {};
      setPreviewData(applyDamageAnalysisLotPolicy(
        isLotListing
          ? {
              ...nextPreviewData,
              include_damage_analysis:
                nextPreviewData.include_damage_analysis ?? (data.include_damage_analysis !== false),
              valuation_methods:
                nextPreviewData.valuation_methods || data.valuation_methods || ["FML"],
            }
          : nextPreviewData
      ));
      const loadedImages = data.imageUrls || [];
      const reportOnlyImages = !isAsset && !isLotListing ? data.extraImageUrls || [] : [];
      setImageUrls([...loadedImages, ...reportOnlyImages]);
      setImageCount((data.image_count || loadedImages.length) + reportOnlyImages.length);
      setPreviewFiles(data.preview_files || data.files || {});
      setHasChanges(false);

      if (isAsset) {
        setGroupingMode(data.grouping_mode || "mixed");
      } else {
        setPropertyType(data.property_type || "residential");
        setLanguage(data.language || "en");
      }
    } catch (error: any) {
      if (!isCurrent()) return;
      console.error("Error loading preview:", error);
      Alert.alert("Error", error.response?.data?.message || "Failed to load preview data");
      onBack();
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [isAsset, isAssignedApproval, isLotListing, mode, onBack, reportId, reportType,
    reportContextKey, resetAssetLotSelection]);

  useEffect(() => {
    loadPreviewData();
    return () => { previewRequestRevisionRef.current += 1; };
  }, [loadPreviewData]);

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (saving || submitting || uploadingLotKey !== null) return;
    setRefreshing(true);
    loadPreviewData();
  }, [loadPreviewData, saving, submitting, uploadingLotKey]);

  const updateField = (field: string, value: any) => {
    if ((isAsset || isLotListing) && previewBusyRef.current) return;
    setPreviewData((prev: any) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateAppraiserSignature = (dataUrl: string | null) => {
    setPreviewData((prev: any) => {
      const next = { ...(prev || {}) };
      if (dataUrl) {
        next.appraiser_signature_data_url = dataUrl;
        next.appraiser_signature_updated_at = new Date().toISOString();
      } else {
        delete next.appraiser_signature_data_url;
        delete next.appraiser_signature_updated_at;
      }
      return next;
    });
    setHasChanges(true);
  };

  const updateNestedField = (path: string, value: any) => {
    if ((isAsset || isLotListing) && previewBusyRef.current) return;
    setPreviewData((prev: any) => {
      const parts = path.split(".");
      const newData = { ...prev };
      let current: any = newData;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current[parts[i]] = { ...current[parts[i]] };
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      return newData;
    });
    setHasChanges(true);
  };

  const getValue = (path: string) => {
    const parts = path.split(".");
    let current: any = previewData;
    for (const part of parts) {
      if (!current) return "";
      current = current[part];
    }
    return current ?? "";
  };

  const updateLot = (index: number, field: string, value: any) => {
    if ((isAsset || isLotListing) && previewBusyRef.current) return;
    setPreviewData((prev: any) => {
      const newLots = [...(prev.lots || [])];
      const nextLot =
        field === "serial_number"
          ? applyPrimarySerialEdit(newLots[index] || {}, value)
          : { ...newLots[index], [field]: value };
      if (
        field === "lot_number" &&
        !isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(nextLot))
      ) {
        nextLot.damage_analysis = "";
      }
      newLots[index] = nextLot;
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };

  const normalizeSpecKey = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");

  const normalizeVisiblePresenceValue = (value: unknown) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    // Only normalize standalone presence labels, never narrative inspection notes.
    if (/^(?:(?:not|no)\s+visible|visible\s*[:=-]?\s*(?:no|false))$/i.test(text)) {
      return "No";
    }
    if (/^visible(?:\s*[:=-]?\s*(?:yes|true))?$/i.test(text)) {
      return "Yes";
    }
    return "";
  };

  const specsByCategory = React.useMemo(() => {
    const map = new Map<string, AssetCategorySpec>();
    categorySpecs.forEach((spec) => map.set(normalizeSpecKey(spec.childCategory), spec));
    return map;
  }, [categorySpecs]);

  const changeLotSpec = (index: number, fieldName: string, value: string, options: { deleted?: boolean; added?: boolean } = {}) => {
    setPreviewData((prev: any) => {
      const newLots = [...(prev?.lots || [])];
      const lot = newLots[index] || {};
      const categoryFields = categorySpecs.find(spec => normalizeSpecKey(spec.childCategory) === normalizeSpecKey(lot.categories))?.fields || [];
      newLots[index] = applyPreviewSpecEdit(lot, fieldName, value, categoryFields, options);
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };
  const updateLotSpec = (index: number, fieldName: string, value: string) => changeLotSpec(index, fieldName, value);
  const deleteLotSpec = (index: number, fieldName: string) => changeLotSpec(index, fieldName, '', { deleted: true });
  const addLotSpec = (index: number, fieldName: string, value: string) => changeLotSpec(index, fieldName, value, { added: true });

  const deleteLotImage = (
    lotIndex: number,
    entry: Pick<GalleryEntry, "globalIndex" | "url">
  ) => {
    Alert.alert(
      "Remove photo?",
      "The photo will be removed from this lot now and permanently deleted from storage after you Save or Submit. Closing without saving leaves storage unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setPreviewData((prev: any) =>
              removeLotPhotoReference(prev, lotIndex, entry)
            );
            const nextGallery = removeGalleryPhotoEntry(
              galleryEntries,
              galleryIndex,
              { ...entry, lotIndex }
            );
            setGalleryEntries(nextGallery.entries);
            if (nextGallery.entries.length === 0) {
              setGalleryIndex(0);
              setGalleryVisible(false);
            } else {
              setGalleryIndex(nextGallery.currentIdx);
            }
            setHasChanges(true);
          },
        },
      ]
    );
  };

  const addPhotosToLot = async (lot: any, lotIndex: number) => {
    if ((isAsset || isLotListing) && previewBusyRef.current) return;
    const contextAtStart = reportContextKey;
    const requestRevision = previewRequestRevisionRef.current;
    const isCurrent = () =>
      reportContextRef.current === contextAtStart &&
      previewRequestRevisionRef.current === requestRevision;
    const permissionGranted = await ensurePhotoPickerAccess();
    if (!isCurrent()) return;
    if (!permissionGranted) {
      Alert.alert("Photos permission needed", "Please allow photo access to add images to this lot.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
      exif: false,
    });

    if (!isCurrent() || result.canceled || !result.assets?.length) return;

    const lotKey = getLotUploadKey(lot, lotIndex);
    const selectedImages = result.assets.map((asset, index) => ({
      uri: asset.uri,
      name: asset.fileName || `preview-lot-${lotIndex + 1}-${index + 1}.jpg`,
      type: asset.mimeType || "image/jpeg",
    }));

    setUploadingLotKey(lotKey);
    resetAssetLotSelection();
    try {
      const response = isLotListing
        ? await lotListingService.uploadPreviewLotImages(reportId, lotKey, selectedImages, previewData)
        : isAssignedApproval
          ? await assignedApprovalService.uploadPreviewLotImages(reportId, lotKey, selectedImages, previewData)
          : await assetService.uploadPreviewLotImages(reportId, lotKey, selectedImages, previewData);
      if (!isCurrent()) return;
      const payload = response?.data || {};
      if (payload.preview_data) {
        setPreviewData(applyDamageAnalysisLotPolicy(payload.preview_data));
      }
      if (Array.isArray(payload.imageUrls)) {
        setImageUrls(payload.imageUrls);
        setImageCount(payload.imageUrls.length);
      }
      if (payload.preview_files) {
        setPreviewFiles(payload.preview_files || {});
      }
      setHasChanges(false);
      Alert.alert("Images added", response?.files_regeneration_queued ? "Files are regenerating with the added photos." : "Photos were added to this lot.");
    } catch (error: any) {
      if (!isCurrent()) return;
      Alert.alert("Upload failed", error?.response?.data?.message || "Could not upload photos for this lot.");
    } finally {
      if (isCurrent()) setUploadingLotKey(null);
    }
  };

  const updateLotConditionSelection = (
    index: number,
    field: ConditionSelectionKey,
    value: string
  ) => {
    if (isAsset && (previewBusyRef.current || reportContextRef.current !== reportContextKey)) {
      return;
    }
    setPreviewData((prev: any) => {
      const newLots = [...(prev?.lots || [])];
      if (!newLots[index]) return prev;
      newLots[index] = isAsset
        ? applyLotConditionSelection(newLots[index], field, value)
        : field === "condition"
          ? applyRunningConditionSelectionToLot(newLots[index], value)
          : {
              ...newLots[index],
              condition_report_selections: {
                ...newLots[index].condition_report_selections,
                [field]: value,
              },
            };
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };

  const selectAssetLots = (indexes: Set<number>) => {
    if (previewBusyRef.current || reportContextRef.current !== reportContextKey) return;
    selectedAssetLotsRef.current = indexes;
    selectionContextRef.current = reportContextKey;
    setSelectedAssetLots(indexes);
  };

  const applyAssetLotCondition = (field: ConditionSelectionKey, value: string) => {
    if (previewBusyRef.current || selectionContextRef.current !== reportContextKey ||
        reportContextRef.current !== reportContextKey) return;
    const indexes = selectedAssetLotsRef.current;
    if (!indexes.size) return;
    const revision = previewRequestRevisionRef.current;
    setPreviewData((prev: any) => {
      if (previewRequestRevisionRef.current !== revision ||
          reportContextRef.current !== reportContextKey) return prev;
      return {
        ...prev,
        lots: applySelectedLotCondition(prev?.lots || [], indexes, field, value),
      };
    });
    setHasChanges(true);
  };

  const deleteLot = (index: number) => {
    if (isAsset && previewBusyRef.current) return;
    const contextAtOpen = reportContextKey;
    const revisionAtOpen = previewRequestRevisionRef.current;
    Alert.alert(
      "Delete Lot",
      "Are you sure you want to delete this lot?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (reportContextRef.current !== contextAtOpen ||
                previewRequestRevisionRef.current !== revisionAtOpen ||
                (isAsset && previewBusyRef.current)) return;
            previewRequestRevisionRef.current += 1;
            resetAssetLotSelection();
            setPreviewData((prev: any) => {
              const lots = Array.isArray(prev?.lots) ? [...prev.lots] : [];
              lots.splice(index, 1);
              return { ...prev, lots };
            });
            setHasChanges(true);
          },
        },
      ]
    );
  };

  const handleSave = async () => {
    if (previewBusyRef.current) return;
    previewBusyRef.current = true;
    const requestRevision = ++previewRequestRevisionRef.current;
    const isCurrent = () =>
      reportContextRef.current === reportContextKey &&
      previewRequestRevisionRef.current === requestRevision;
    resetAssetLotSelection();
    try {
      setSaving(true);
      
      const localPreviewBeforeSave = applyDamageAnalysisLotPolicy(previewData);
      setPreviewData(localPreviewBeforeSave);
      const saveResponse = isAssignedApproval
        ? await assignedApprovalService.updatePreview(reportId, localPreviewBeforeSave)
        : await api.put(
            isAsset
              ? `${API_ENDPOINTS.UPDATE_PREVIEW}/${reportId}/preview`
              : isLotListing
                ? `/lot-listing/${reportId}/preview`
                : `${API_ENDPOINTS.UPDATE_REAL_ESTATE_PREVIEW}/${reportId}`,
            { preview_data: localPreviewBeforeSave }
          );
      if (!isCurrent()) return;
      const saveBody = isAssignedApproval ? saveResponse : saveResponse?.data;
      const savedData = saveBody?.data;
      const regenerationQueued = saveBody?.files_regeneration_queued === true;
      const savedImageUrls = Array.isArray(saveBody?.imageUrls)
        ? saveBody.imageUrls
        : Array.isArray(savedData?.imageUrls)
          ? savedData.imageUrls
          : null;
      if (savedImageUrls) {
        setImageUrls(savedImageUrls);
        setImageCount(savedImageUrls.length);
      }
      if (isAsset && savedData) {
        setPreviewData(
          applyDamageAnalysisLotPolicy(
            mergeSavedPreviewWithLocalLotNumbers(savedData, localPreviewBeforeSave)
          )
        );
      } else if (isLotListing && savedData?.preview_data) {
        setPreviewData(
          applyDamageAnalysisLotPolicy(
            mergeSavedPreviewWithLocalLotNumbers(
              savedData.preview_data,
              localPreviewBeforeSave
            )
          )
        );
      } else if (savedData) {
        setPreviewData(applyDamageAnalysisLotPolicy(savedData));
      }
      if ((isAsset || isLotListing) && !regenerationQueued) {
        const pdfEndpoint = isAssignedApproval
          ? `/reports/assigned-approvals/${reportId}/preview/spec-pdf`
          : isAsset
            ? `/asset/${reportId}/preview/spec-pdf`
            : `/lot-listing/${reportId}/preview/spec-pdf`;
        try {
          const pdfResponse = await api.post(pdfEndpoint, {});
          if (!isCurrent()) return;
          const pdfData = pdfResponse?.data?.data || {};
          const refreshedPreview = pdfData.preview_data;
          if (refreshedPreview) {
            setPreviewData(
              applyDamageAnalysisLotPolicy(
                mergeSavedPreviewWithLocalLotNumbers(
                  refreshedPreview,
                  localPreviewBeforeSave
                )
              )
            );
          }
          if (Array.isArray(pdfData.imageUrls)) {
            setImageUrls(pdfData.imageUrls);
            setImageCount(pdfData.imageUrls.length);
          }
          setPreviewFiles((prev) => ({
            ...(prev || {}),
            ...(pdfData.preview_files || {}),
            spec_pdf: pdfData.spec_pdf || pdfData.preview_files?.spec_pdf || prev?.spec_pdf,
            cr_docx: pdfData.cr_docx || pdfData.preview_files?.cr_docx || prev?.cr_docx,
          }));
        } catch (pdfError: any) {
          if (!isCurrent()) return;
          console.warn("CR refresh failed after save:", pdfError?.message || pdfError);
        }
      }
      setHasChanges(false);
      const isFirstMergedPreviewBuild =
        regenerationQueued &&
        isAsset &&
        previewData?.is_merged_report === true &&
        !previewFiles?.excel;
      const successMessage = isFirstMergedPreviewBuild
        ? "Lot conflicts resolved. The merged preview is being generated."
        : regenerationQueued
          ? "Changes saved. Files are being regenerated with the updated report data."
          : "Changes saved successfully!";
      Alert.alert(
        "Success",
        successMessage,
        isFirstMergedPreviewBuild
          ? [{
              text: "OK",
              onPress: () => {
                if (onSuccess) onSuccess();
                onBack();
              },
            }]
          : undefined
      );
    } catch (error: any) {
      if (!isCurrent()) return;
      console.error("Error saving:", error);
      Alert.alert("Error", error.response?.data?.message || "Failed to save changes");
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (previewBusyRef.current) return;
    const submissionContext = reportContextKey;
    const confirmationRevision = previewRequestRevisionRef.current;
    let confirmed = false;
    const isSubmittedMode = resubmitMode;
    Alert.alert(
      isAsset || isLotListing
        ? generationLabel
        : isAssignedApproval ? "Submit and Approve" : (isSubmittedMode ? "Regenerate Files" : "Submit Report"),
      isAsset || isLotListing
        ? "Saves your edits exactly as shown and rebuilds the Excel, PDF and Word files. Nothing is re-read by the AI." +
          (isAssignedApproval ? " The report is approved after the files are rebuilt." :
            isLotListing ? " Files are released automatically after generation succeeds." :
              " Existing approval and release requirements still apply.")
        : isAssignedApproval
        ? "This will save your latest edits, regenerate the report files, and approve the report after generation succeeds."
        : isSubmittedMode
        ? isLotListing
          ? "This will save your latest edits and regenerate all lot listing files. They will be released automatically after generation succeeds."
          : "This will save your latest edits, regenerate all report files, and continue the approval and release workflow."
        : isLotListing
          ? "This will save your latest edits, generate all lot listing files, and release them automatically after generation succeeds."
          : "This will save your latest edits, generate files, and continue through any assigned approval and release steps.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isAsset || isLotListing
            ? generationLabel
            : isAssignedApproval ? "Submit" : (isSubmittedMode ? "Resubmit" : "Submit"),
          onPress: async () => {
            if (confirmed || reportContextRef.current !== submissionContext || previewBusyRef.current ||
                previewRequestRevisionRef.current !== confirmationRevision) return;
            confirmed = true;
            previewBusyRef.current = true;
            const requestRevision = ++previewRequestRevisionRef.current;
            const isCurrent = () =>
              reportContextRef.current === submissionContext &&
              previewRequestRevisionRef.current === requestRevision;
            resetAssetLotSelection();
            try {
              setSubmitting(true);
              const previewForRequest = applyDamageAnalysisLotPolicy(previewDataRef.current);
              setPreviewData(previewForRequest);

              if (isSubmittedMode) {
                if (isAssignedApproval) {
                  await assignedApprovalService.resubmit(reportId, previewForRequest);
                } else {
                  let endpoint: string;
                  if (isAsset) endpoint = `/asset/${reportId}/resubmit`;
                  else if (isLotListing) endpoint = `/lot-listing/${reportId}/resubmit`;
                  else endpoint = realEstateSubmissionPath(reportId, status, mode);
                  await api.post(endpoint, { preview_data: previewForRequest });
                }
                if (!isCurrent()) return;
                if (isAsset || isLotListing) setFilesGenerating(true);
                setHasChanges(false);
                Alert.alert(
                  "Success",
                  isAssignedApproval
                    ? "Files are regenerating. The report will approve after generation succeeds."
                    : isLotListing
                    ? "Approved files are being regenerated."
                    : "Report resubmitted successfully! Files are being regenerated."
                );
              } else {
                let endpoint: string;
                if (isAsset) endpoint = `${API_ENDPOINTS.SUBMIT_PREVIEW}/${reportId}/submit-approval`;
                else if (isLotListing) endpoint = `/lot-listing/${reportId}/submit-approval`;
                else endpoint = realEstateSubmissionPath(reportId, status, mode);

                // Lot Listing submit accepts the complete edited preview. A
                // separate save request raced this request with stale state.
                await api.post(
                  endpoint,
                  isLotListing || isAsset
                    ? { preview_data: previewForRequest }
                    : undefined
                );
                if (!isCurrent()) return;
                if (isAsset || isLotListing) setFilesGenerating(true);
                setHasChanges(false);
                Alert.alert(
                  "Success",
                  isLotListing
                    ? "Files are being generated and will be released automatically."
                    : "Report submitted. Files are being generated."
                );
              }
              if (onSuccess) onSuccess();
              onBack();
            } catch (error: any) {
              if (!isCurrent()) return;
              console.error("Error submitting:", error);
              Alert.alert("Error", error.response?.data?.message || "Failed to submit report");
            } finally {
              if (isCurrent()) {
                previewBusyRef.current = false;
                setSubmitting(false);
              }
            }
          },
        },
      ]
    );
  };

  const openLotGallery = (
    entries: Array<{ url: string; globalIndex: number | null }>,
    lotIndex: number,
    startIndex: number = 0
  ) => {
    setGalleryEntries(
      entries.map((entry) => ({ ...entry, lotIndex, context: "lot" }))
    );
    setGalleryIndex(startIndex);
    setGalleryVisible(true);
  };

  const openReportGallery = (images: string[], startIndex: number = 0) => {
    setGalleryEntries(
      images.map((url, globalIndex) => ({
        url,
        globalIndex,
        lotIndex: null,
        context: "report",
      }))
    );
    setGalleryIndex(startIndex);
    setGalleryVisible(true);
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return "";
    return dateString.split("T")[0];
  };

  const renderInput = (label: string, field: string, placeholder: string, multiline = false) => (
    <View style={styles.fieldContainer}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[styles.input, multiline && styles.textArea]}
        value={String(getValue(field) ?? "")}
        onChangeText={(text) => updateNestedField(field, text)}
        placeholder={placeholder}
        placeholderTextColor="#9CA3AF"
        multiline={multiline}
        numberOfLines={multiline ? 4 : 1}
      />
    </View>
  );

  const renderDateInput = (label: string, field: string) => (
    <View style={styles.fieldContainer}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint="Enter the date as year, month, day"
        style={styles.input}
        value={formatDate(getValue(field))}
        onChangeText={(text) => updateNestedField(field, text)}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#9CA3AF"
      />
    </View>
  );

  const getSpecRecord = (value: unknown, reviewed = false): Record<string, string> => {
    const isUsefulSpecValue = (raw: unknown) => {
      const text = String(raw ?? "").trim();
      if (normalizeVisiblePresenceValue(text)) return true;
      return (
        !!text &&
        !/^(n\/a|na|none|null|unknown|not found|tbd|false|not available|not applicable)$/i.test(text) &&
        !/title clearance clarification fee|applied to your invoice|over and above the purchase price|applicable taxes|following the close of the sale/i.test(text)
      );
    };
    if (Array.isArray(value)) {
      return Object.fromEntries(
        value
          .map((entry: any) => ({
            field: String(entry?.field || "").trim(),
            text: String(entry?.value ?? ""),
            raw: entry?.value,
          }))
          .filter((entry: { field: string; text: string; raw: unknown }) =>
            entry.field &&
            (reviewed || entry.raw === "" ||
              (typeof entry.raw === "string" && !entry.text.trim()) ||
              isUsefulSpecValue(entry.text))
          )
          .map((entry: { field: string; text: string }) => [entry.field, entry.text])
      );
    }
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([field, raw]) => ({
          field,
          text: String(raw ?? ""),
          raw,
        }))
        .filter((entry: { field: string; text: string; raw: unknown }) =>
          entry.field &&
          (reviewed || entry.raw === "" ||
            (typeof entry.raw === "string" && !entry.text.trim()) ||
            isUsefulSpecValue(entry.text))
        )
        .map((entry: { field: string; text: string }) => [entry.field, entry.text])
    );
  };

  const getSpecValue = (record: Record<string, string>, fieldName: string, categoryFields: string[] = []) => {
    if (record[fieldName] !== undefined) {
      return normalizeVisiblePresenceValue(record[fieldName]) || record[fieldName];
    }
    const key = previewSpecFieldKey(fieldName, categoryFields);
    const existingKey = Object.keys(record).find((candidate) => previewSpecFieldKey(candidate, categoryFields) === key);
    return existingKey
      ? normalizeVisiblePresenceValue(record[existingKey]) || record[existingKey]
      : "";
  };

  const openSpecFieldEditor = (
    lot: AssetLot | LotListingLot,
    index: number,
    fieldName: string
  ) => {
    const specRecord = getSpecRecord(lot.condition_report_specs, lot.condition_report_specs_reviewed === true);
    setSpecFieldEditor({
      lotIndex: index,
      fieldName,
      value: getSpecValue(specRecord, fieldName, specsByCategory.get(normalizeSpecKey(lot.categories))?.fields || []),
      lotLabel: getLotDisplayNumber(lot, index),
      lotTitle: String(lot.title || lot.description || "").trim(),
    });
  };

  const openAddSpecFieldEditor = (lot: AssetLot | LotListingLot, index: number) => {
    setSpecFieldEditor({
      lotIndex: index,
      fieldName: "",
      draftFieldName: "",
      value: "",
      lotLabel: getLotDisplayNumber(lot, index),
      lotTitle: String(lot.title || lot.description || "").trim(),
      isNew: true,
    });
  };

  const openDamageAnalysisEditor = (
    lot: AssetLot | LotListingLot,
    index: number,
    value = String((lot as any).damage_analysis || ""),
    notice?: string
  ) => {
    if (!isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(lot))) {
      Alert.alert(
        "Damage Analysis not required",
        "This lot is above 1000, so Damage Analysis is excluded from the report and generated files."
      );
      return;
    }
    setSpecFieldEditor({
      lotIndex: index,
      fieldName: "Damages",
      value,
      lotLabel: getLotDisplayNumber(lot, index),
      lotTitle: String(lot.title || lot.description || "").trim(),
      isDamage: true,
      notice,
    });
  };

  const handleSpecFieldPress = (
    lot: AssetLot | LotListingLot,
    index: number,
    fieldName: string
  ) => {
    lastSpecTapRef.current = null;
    Keyboard.dismiss();
    openSpecFieldEditor(lot, index, fieldName);
  };

  const closeSpecFieldEditor = () => {
    setSpecFieldEditor(null);
  };

  const saveSpecFieldEditor = () => {
    if (!specFieldEditor) return;
    if (specFieldEditor.isDamage) {
      const lot = previewData?.lots?.[specFieldEditor.lotIndex] || {};
      if (!isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(lot))) {
        closeSpecFieldEditor();
        return;
      }
      updateLot(specFieldEditor.lotIndex, "damage_analysis", specFieldEditor.value);
      closeSpecFieldEditor();
      return;
    }
    if (specFieldEditor.isNew) {
      const fieldName = String(specFieldEditor.draftFieldName || "").trim();
      const value = String(specFieldEditor.value || "").trim();
      if (!fieldName) {
        setSpecFieldEditor((prev) =>
          prev ? { ...prev, error: "Field name is required." } : prev
        );
        return;
      }
      if (isDamageSpecField(fieldName)) {
        const lot = previewData?.lots?.[specFieldEditor.lotIndex] || {};
        if (!isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(lot))) {
          setSpecFieldEditor((prev) =>
            prev
              ? {
                  ...prev,
                  error:
                    "Damage Analysis is unavailable for lot numbers above 1000.",
                }
              : prev
          );
          return;
        }
        openDamageAnalysisEditor(
          lot,
          specFieldEditor.lotIndex,
          specFieldEditor.value,
          "Damage notes are saved in the Damages section."
        );
        return;
      }
      if (!value) {
        setSpecFieldEditor((prev) =>
          prev ? { ...prev, error: "Field value is required." } : prev
        );
        return;
      }
      const lot = previewData?.lots?.[specFieldEditor.lotIndex] || {};
      const specRecord = getSpecRecord(lot.condition_report_specs, lot.condition_report_specs_reviewed === true);
      const existingField = Object.keys(specRecord).find(
        (candidate) => normalizeSpecKey(candidate) === normalizeSpecKey(fieldName)
      );
      if (existingField) {
        setSpecFieldEditor({
          ...specFieldEditor,
          fieldName: existingField,
          value: getSpecValue(specRecord, existingField),
          isNew: false,
          error: "This field already exists. Edit the existing value.",
        });
        return;
      }
      addLotSpec(specFieldEditor.lotIndex, fieldName, specFieldEditor.value);
      closeSpecFieldEditor();
      return;
    }
    updateLotSpec(
      specFieldEditor.lotIndex,
      specFieldEditor.fieldName,
      specFieldEditor.value
    );
    closeSpecFieldEditor();
  };

  const deleteSpecFieldFromEditor = () => {
    if (!specFieldEditor) return;
    if (specFieldEditor.isNew) {
      closeSpecFieldEditor();
      return;
    }
    if (specFieldEditor.isDamage) {
      updateLot(specFieldEditor.lotIndex, "damage_analysis", "");
      closeSpecFieldEditor();
      return;
    }
    deleteLotSpec(specFieldEditor.lotIndex, specFieldEditor.fieldName);
    closeSpecFieldEditor();
  };

  const isDamageSpecField = (fieldName: string) => {
    const key = normalizeSpecKey(fieldName);
    return key === "damage" || key === "damages" || key === "damageanalysis";
  };

  const renderAuctioneerSpecs = (lot: AssetLot | LotListingLot, index: number) => {
    const categorySpec = specsByCategory.get(normalizeSpecKey(lot.categories));
    const reviewed = lot.condition_report_specs_reviewed === true;
    const specRecord = getSpecRecord(lot.condition_report_specs, reviewed);
    const categoryFields = (categorySpec?.fields || []).filter((field) => !isDamageSpecField(field));
    const deletedSpecKeys = new Set(
      (Array.isArray((lot as any).condition_report_specs_deleted)
        ? (lot as any).condition_report_specs_deleted
        : []
      )
        .map((field: unknown) => previewSpecFieldKey(field, categoryFields))
        .filter(Boolean)
    );
    const extraFields = Object.keys(specRecord).filter(
      (field) =>
        !isDamageSpecField(field) &&
        !deletedSpecKeys.has(previewSpecFieldKey(field, categoryFields)) &&
        !categoryFields.some((knownField) => previewSpecFieldKey(knownField, categoryFields) === previewSpecFieldKey(field, categoryFields))
    );
    const fields = [
      ...categoryFields.filter((field) => !deletedSpecKeys.has(previewSpecFieldKey(field, categoryFields)) &&
        (!reviewed || Object.keys(specRecord).some(key => previewSpecFieldKey(key, categoryFields) === previewSpecFieldKey(field, categoryFields)))),
      ...extraFields,
    ];
    const categoryChipText = categorySpec
      ? `${categorySpec.childCategory} - ${categoryFields.length} fields`
      : "Category not matched";
    const includeDamageAnalysis = previewData?.include_damage_analysis !== false;
    const damageEligible = isDamageAnalysisEligibleForLot(
      getLotNumberForDamagePolicy(lot)
    );
    const damageText = String((lot as any).damage_analysis || "").trim();
    const specSectionKey = `${reportType}-${String(
      (lot as any).lot_id ?? (lot as any).lot_number ?? index
    )}-${index}`;
    const specsExpanded = expandedSpecSections[specSectionKey] !== false;
    const toggleSpecsExpanded = () => {
      setExpandedSpecSections((prev) => ({
        ...prev,
        [specSectionKey]: !(prev[specSectionKey] !== false),
      }));
    };

    return (
      <View style={styles.specEditorCard}>
        <View style={styles.specEditorHeader}>
          <View style={styles.specHeaderText}>
            <Text style={styles.specEditorTitle}>CONDITION REPORT</Text>
            <Text style={styles.specEditorSubtitle}>
              {categorySpec
                ? `Category fields for ${categorySpec.childCategory}`
                : lot.categories
                  ? "No matching category field list found"
              : "Enter a category to show field names"}
            </Text>
          </View>
          <View style={styles.specHeaderActions}>
            <TouchableOpacity
              style={[styles.specToggleBtn, { borderColor: themeColor }]}
              onPress={toggleSpecsExpanded}
              activeOpacity={0.85}
            >
              <Feather
                name={specsExpanded ? "chevron-up" : "chevron-down"}
                size={15}
                color={themeColor}
              />
              <Text style={[styles.specToggleText, { color: themeColor }]}>
                {specsExpanded ? "Minimize" : "Expand"}
              </Text>
            </TouchableOpacity>
            <View
              style={[
                styles.specCountBadge,
                {
                  borderColor: categorySpec ? themeColor : "#F59E0B",
                  backgroundColor: categorySpec ? "#F9FAFB" : "#FFFBEB",
                },
              ]}
            >
              <Text
                style={[
                  styles.specCountText,
                  { color: categorySpec ? themeColor : "#B45309" },
                ]}
                numberOfLines={2}
              >
                {categoryChipText}
              </Text>
            </View>
          </View>
        </View>
        {!specsExpanded ? (
          <Text style={styles.specCollapsedText}>
            {fields.length || categoryFields.length} field names hidden. Tap Expand to edit.
          </Text>
        ) : (
          <View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Add condition report field to lot ${index + 1}`}
              style={styles.addSpecFieldBtn}
              onPress={() => openAddSpecFieldEditor(lot, index)}
              activeOpacity={0.85}
            >
              <Feather name="plus" size={15} color={themeColor} />
              <Text style={[styles.addSpecFieldText, { color: themeColor }]}>Add field</Text>
            </TouchableOpacity>
            {!damageEligible ? (
              <View style={styles.damagePolicyCard} accessibilityRole="text">
                <Text style={styles.damagePolicyTitle}>DAMAGE ANALYSIS NOT REQUIRED</Text>
                <Text style={styles.damagePolicyText}>
                  This lot is above 1000, so Damage Analysis is excluded from the report and generated files.
                </Text>
              </View>
            ) : includeDamageAnalysis ? (
              <TouchableOpacity
                style={styles.damageAnalysisCard}
                onPress={() => openDamageAnalysisEditor(lot, index)}
                activeOpacity={0.88}
              >
                <View style={styles.damageAnalysisHeader}>
                  <View style={styles.damageAnalysisTitleWrap}>
                    <Text style={styles.damageAnalysisTitle}>DAMAGES</Text>
                    <Text style={styles.damageAnalysisSubtitle}>
                      Manual damage notes for the CR damages section.
                    </Text>
                  </View>
                  <View style={styles.damageAnalysisEditPill}>
                    <Feather name="edit-3" size={13} color="#B91C1C" />
                    <Text style={styles.damageAnalysisEditText}>Edit</Text>
                  </View>
                </View>
                <Text style={damageText ? styles.damageAnalysisBody : styles.damageAnalysisPlaceholder}>
                  {damageText || "No manual damage notes yet."}
                </Text>
              </TouchableOpacity>
            ) : null}
            {fields.length > 0 ? (
              <View style={styles.specFields}>
                {fields.map((fieldName) => (
                  <View key={fieldName} style={styles.specFieldContainer}>
                    <View style={styles.specFieldHeader}>
                      <Text style={styles.specFieldLabel}>{fieldName}</Text>
                      <TouchableOpacity
                        style={styles.specDeleteBtn}
                        onPress={() => deleteLotSpec(index, fieldName)}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${fieldName}`}
                      >
                        <Feather name="x" size={16} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={styles.input}
                      value={getSpecValue(specRecord, fieldName, categoryFields)}
                      accessibilityLabel={`Lot ${index + 1}, ${fieldName}`}
                      onPressIn={() => handleSpecFieldPress(lot, index, fieldName)}
                      onChangeText={(text) => updateLotSpec(index, fieldName, text)}
                      placeholder="Value found in uploaded images"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.specEmptyText}>
                Spec values found in uploaded images will appear here.
              </Text>
            )}
          </View>
        )}
      </View>
    );
  };

  // Asset Preview Content
  const renderAssetPreview = () => {
    const lots: AssetLot[] = Array.isArray(previewData?.lots) ? previewData.lots : [];
    const bankPhotosEnabled = previewData?.bank_photos_enabled === true;

    return (
      <>
        {/* Basic Information */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>👤</Text>
            <Text style={styles.sectionTitle}>Basic Information</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderInput("Client Name *", "client_name", "Client name")}
            {renderInput("Owner Name", "owner_name", "Owner name")}
            {renderInput("Contract Number", "contract_no", "Contract number")}
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => updateField("bank_photos_enabled", !bankPhotosEnabled)}
            >
              <View
                style={[
                  styles.checkbox,
                  bankPhotosEnabled && {
                    backgroundColor: themeColor,
                    borderColor: themeColor,
                  },
                ]}
              >
                {bankPhotosEnabled && <Feather name="check" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkboxLabel}>Bank</Text>
                <Text style={styles.typeBadgeSubtitle}>Include all lot photos in the CR.</Text>
              </View>
            </TouchableOpacity>
            {renderInput("Industry", "industry", "Industry")}
          </View>
        </View>

        {/* Dates & Financial */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📅</Text>
            <Text style={styles.sectionTitle}>Dates & Financial</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderDateInput("Effective Date", "effective_date")}
            {renderDateInput("Inspection Date", "inspection_date")}
            {renderInput("Currency", "currency", "CAD")}
            {renderInput("Total Appraised Value", "total_appraised_value", "$0.00")}
          </View>
        </View>

        {/* Appraisal Details */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📋</Text>
            <Text style={styles.sectionTitle}>Appraisal Details</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderInput("Appraisal Purpose", "appraisal_purpose", "Purpose")}
            {renderInput("Appraiser Name", "appraiser", "Appraiser")}
            <AppraiserSignaturePad
              value={previewData?.appraiser_signature_data_url || ""}
              disabled={saving || submitting}
              themeColor={themeColor}
              onChange={updateAppraiserSignature}
            />
            {renderInput("Company", "appraisal_company", "Company")}
            {renderInput("Prepared For", "prepared_for", "Prepared for")}
          </View>
        </View>

        {/* Factors */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📝</Text>
            <Text style={styles.sectionTitle}>Factors Affecting Value</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderInput("Age & Condition", "factors_age_condition", "Describe age and condition...", true)}
            {renderInput("Quality", "factors_quality", "Describe quality...", true)}
            {renderInput("Analysis", "factors_analysis", "Overall analysis...", true)}
          </View>
        </View>

        {/* Quick Stats */}
        <View style={[styles.statsCard, { backgroundColor: `${themeColor}10` }]}>
          <Text style={styles.statsTitle}>📊 Report Statistics</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: themeColor }]}>{lots.length}</Text>
              <Text style={styles.statLabel}>Lots</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: "#059669" }]}>{previewData?.currency || "CAD"}</Text>
              <Text style={styles.statLabel}>Currency</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: "#7C3AED" }]}>{groupingMode}</Text>
              <Text style={styles.statLabel}>Mode</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: "#2563EB" }]}>{imageCount}</Text>
              <Text style={styles.statLabel}>Images</Text>
            </View>
          </View>
        </View>


        {/* Lots */}
        <AssetBulkConditionControls
          lots={lots}
          indexes={selectionContextRef.current === reportContextKey ? selectedAssetLots : new Set()}
          accent={themeColor}
          disabled={previewBusyRef.current}
          onSelectAll={() => selectAssetLots(new Set(lots.map((_, index) => index)))}
          onClear={() => selectAssetLots(new Set())}
          onChange={applyAssetLotCondition}
        />
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📦</Text>
            <Text style={styles.sectionTitle}>Assets / Lots</Text>
            <View style={[styles.sectionCountBadge, { backgroundColor: `${themeColor}12`, borderColor: `${themeColor}35` }]}>
              <Text style={[styles.sectionCountText, { color: themeColor }]}>{lots.length}</Text>
            </View>
          </View>
          <PreviewLotNavigation count={lots.length} position="top" onJump={jumpToLot} />
          {lots.map((lot, idx) => {
            const lotImages = getLotPhotoEntries(lot);
            const lotUploadKey = getLotUploadKey(lot, idx);

            return (
              <View key={idx} testID={`preview-lot-${idx + 1}`} style={styles.lotCard} collapsable={idx !== 0 && idx !== lots.length - 1}
                ref={idx === 0 ? firstLotRef : idx === lots.length - 1 ? lastLotRef : null}>
                <View style={[styles.lotHeader, { borderTopColor: themeColor }]}>
                  {lots.length > 1 ? (
                    <TouchableOpacity
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Select lot ${getLotDisplayNumber(lot, idx)} for bulk update`}
                      accessibilityState={{
                        checked: selectionContextRef.current === reportContextKey && selectedAssetLots.has(idx),
                        disabled: previewBusyRef.current,
                      }}
                      disabled={previewBusyRef.current}
                      style={styles.assetLotCheckbox}
                      onPress={() => selectAssetLots(
                        toggleAssetLotSelection(selectedAssetLotsRef.current, idx, lots.length)
                      )}
                    >
                      <Feather
                        name={selectedAssetLots.has(idx) ? "check-square" : "square"}
                        size={22}
                        color={themeColor}
                      />
                    </TouchableOpacity>
                  ) : null}
                  <Text style={styles.lotTitle}>Lot {getLotDisplayNumber(lot, idx)}</Text>
                  <TouchableOpacity 
                    onPress={() => deleteLot(idx)}
                    style={styles.deleteLotBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete lot ${getLotDisplayNumber(lot, idx)}`}
                    disabled={previewBusyRef.current}
                  >
                    <Feather name="trash-2" size={16} color="#EF4444" />
                  </TouchableOpacity>
                </View>

                {/* Lot Images */}
                <View style={styles.lotImagesContainer}>
                    <View style={styles.lotImagesHeader}>
                      <Text style={styles.lotImagesLabel}>
                        <Feather name="image" size={12} color="#6B7280" /> Photos ({lotImages.length})
                      </Text>
                      <TouchableOpacity
                        style={[styles.addPhotosButton, uploadingLotKey === lotUploadKey && styles.disabledButton]}
                        onPress={() => addPhotosToLot(lot, idx)}
                        disabled={uploadingLotKey === lotUploadKey}
                      >
                        {uploadingLotKey === lotUploadKey ? (
                          <ActivityIndicator size="small" color={themeColor} />
                        ) : (
                          <Feather name="plus" size={14} color={themeColor} />
                        )}
                        <Text style={[styles.addPhotosText, { color: themeColor }]}>
                          {uploadingLotKey === lotUploadKey ? "Adding" : "Add photos"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {lotImages.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.lotImagesScroll}>
                      {lotImages.slice(0, 10).map(({ url, globalIndex }, imgIdx) => (
                        <TouchableOpacity 
                          key={imgIdx} 
                          onPress={() => openLotGallery(lotImages, idx, imgIdx)}
                          accessibilityRole="button"
                          accessibilityLabel={`View lot ${getLotDisplayNumber(lot, idx)} photo ${imgIdx + 1}`}
                          style={styles.lotImageThumb}
                        >
                          <Image source={{ uri: url }} style={styles.lotImage} />
                          <TouchableOpacity
                            style={styles.lotImageDeleteBtn}
                            onPress={() => deleteLotImage(idx, { globalIndex, url })}
                            activeOpacity={0.85}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove photo ${imgIdx + 1}`}
                          >
                            <Feather name="x" size={13} color="#FFFFFF" />
                          </TouchableOpacity>
                        </TouchableOpacity>
                      ))}
                      {lotImages.length > 10 && (
                        <TouchableOpacity 
                          onPress={() => openLotGallery(lotImages, idx, 10)}
                          style={[styles.lotImageThumb, styles.moreImagesThumb]}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${lotImages.length - 10} more photos`}
                        >
                          <Text style={styles.moreImagesText}>+{lotImages.length - 10}</Text>
                        </TouchableOpacity>
                      )}
                    </ScrollView>
                    )}
                  </View>

                {/* Lot Fields */}
                <View style={styles.lotFields}>
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Lot #</Text>
                    <TextInput
                      style={[styles.input, isDuplicateLotNumber(lot, idx) && styles.duplicateLotInput]}
                      accessibilityLabel={`Lot ${idx + 1} number`}
                      value={String(lot.lot_number ?? getLotDisplayNumber(lot, idx))}
                      onChangeText={(text) => updateLot(idx, "lot_number", text)}
                      placeholder={String(idx + 1)}
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Title</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.title || ""}
                      accessibilityLabel={`Lot ${idx + 1} title`}
                      accessibilityHint="Used as Description in Excel and condition report files."
                      onChangeText={(text) => updateLot(idx, "title", text)}
                      placeholder="Title"
                      placeholderTextColor="#9CA3AF"
                    />
                    <Text style={styles.fieldHelp}>Used as Description in Excel and condition report files.</Text>
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Category</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.categories || ""}
                      accessibilityLabel={`Lot ${idx + 1} category`}
                      onChangeText={(text) => updateLot(idx, "categories", text)}
                      placeholder="Auctioneer Import category"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Serial Number (VIN/SN)</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.serial_number || ""}
                      accessibilityLabel={`Lot ${idx + 1} serial number or VIN`}
                      autoCorrect={false}
                      onChangeText={(text) => updateLot(idx, "serial_number", text)}
                      placeholder="Serial number or VIN"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                  {renderAuctioneerSpecs(lot, idx)}
                  <AssetLotConditionEditor
                    key={`${assetSelectionEpoch}:${idx}`}
                    lotNumber={getLotDisplayNumber(lot, idx)}
                    selections={lot.condition_report_selections}
                    accent={themeColor}
                    disabled={previewBusyRef.current}
                    onChange={(field, value) => updateLotConditionSelection(idx, field, value)}
                  />
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Estimated Value</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.estimated_value || ""}
                      accessibilityLabel={`Lot ${idx + 1} estimated value`}
                      onChangeText={(text) => updateLot(idx, "estimated_value", text)}
                      placeholder="$0.00"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                </View>
              </View>
            );
          })}
          <PreviewLotNavigation count={lots.length} position="bottom" onJump={jumpToLot} />
        </View>

        {/* Valuation Table Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📊</Text>
            <Text style={styles.sectionTitle}>Valuation</Text>
          </View>
          <View style={styles.sectionContent}>
            {/* Include Valuation Table Toggle */}
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => updateField("include_valuation_table", !previewData?.include_valuation_table)}
            >
              <View style={[styles.checkbox, previewData?.include_valuation_table && styles.checkboxChecked]}>
                {previewData?.include_valuation_table && <Feather name="check" size={14} color="#fff" />}
              </View>
              <Text style={styles.checkboxLabel}>Include Valuation Comparison Table</Text>
            </TouchableOpacity>

            {previewData?.include_valuation_table && (
              <>
                {/* Valuation Methods */}
                {previewData?.valuation_methods?.length > 0 && (
                  <View style={styles.valuationMethodsContainer}>
                    <Text style={styles.valuationMethodsTitle}>Valuation Methods Selected</Text>
                    <View style={styles.methodBadges}>
                      {previewData.valuation_methods.map((method: string, idx: number) => (
                        <View key={idx} style={styles.methodBadge}>
                          <Text style={styles.methodBadgeText}>{method}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Base FMV */}
                {previewData?.valuation_data && (
                  <View style={styles.baseFmvContainer}>
                    <Text style={styles.baseFmvLabel}>Base Fair Market Value ({previewData?.currency || "CAD"})</Text>
                    <TextInput
                      style={styles.input}
                      value={String(previewData.valuation_data?.baseFMV || "")}
                      accessibilityLabel="Base fair market value"
                      onChangeText={(text) => {
                        const numVal = parseFloat(text) || 0;
                        setPreviewData((prev: any) => ({
                          ...prev,
                          valuation_data: { ...(prev?.valuation_data || {}), baseFMV: numVal }
                        }));
                        setHasChanges(true);
                      }}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="numeric"
                    />
                  </View>
                )}

                {/* Comparison Table */}
                {Array.isArray(previewData?.valuation_data?.methods) && previewData.valuation_data.methods.length > 0 && (
                  <View style={styles.comparisonTableContainer}>
                    <Text style={styles.comparisonTableTitle}>Comparison Table</Text>
                    {previewData.valuation_data.methods.map((method: any, idx: number) => (
                      <View key={idx} style={styles.methodCard}>
                        <View style={styles.methodCardHeader}>
                          <Text style={styles.methodCardCode}>{method.method || "—"}</Text>
                          <Text style={styles.methodCardName}>{method.fullName || "Method " + (idx + 1)}</Text>
                        </View>
                        <View style={styles.methodCardFields}>
                          <View style={styles.fieldContainer}>
                            <Text style={styles.fieldLabel}>Value ({previewData?.currency || "CAD"})</Text>
                            <TextInput
                              style={styles.input}
                              value={String(method.value || "")}
                              accessibilityLabel={`${method.method || idx + 1} valuation value`}
                              onChangeText={(text) => {
                                const numVal = parseFloat(text) || 0;
                                setPreviewData((prev: any) => {
                                  const vd = { ...(prev?.valuation_data || {}) };
                                  const methods = [...(vd.methods || [])];
                                  methods[idx] = { ...methods[idx], value: numVal };
                                  return { ...prev, valuation_data: { ...vd, methods } };
                                });
                                setHasChanges(true);
                              }}
                              placeholder="0"
                              placeholderTextColor="#9CA3AF"
                              keyboardType="numeric"
                            />
                          </View>
                          <View style={styles.fieldContainer}>
                            <Text style={styles.fieldLabel}>Conditions</Text>
                            <TextInput
                              style={[styles.input, styles.textArea]}
                              value={method.saleConditions || ""}
                              accessibilityLabel={`${method.method || idx + 1} sale conditions`}
                              onChangeText={(text) => {
                                setPreviewData((prev: any) => {
                                  const vd = { ...(prev?.valuation_data || {}) };
                                  const methods = [...(vd.methods || [])];
                                  methods[idx] = { ...methods[idx], saleConditions: text };
                                  return { ...prev, valuation_data: { ...vd, methods } };
                                });
                                setHasChanges(true);
                              }}
                              placeholder="Sale conditions..."
                              placeholderTextColor="#9CA3AF"
                              multiline
                              numberOfLines={2}
                            />
                          </View>
                          <View style={styles.fieldContainer}>
                            <Text style={styles.fieldLabel}>Timeline</Text>
                            <TextInput
                              style={styles.input}
                              value={method.timeline || ""}
                              accessibilityLabel={`${method.method || idx + 1} timeline`}
                              onChangeText={(text) => {
                                setPreviewData((prev: any) => {
                                  const vd = { ...(prev?.valuation_data || {}) };
                                  const methods = [...(vd.methods || [])];
                                  methods[idx] = { ...methods[idx], timeline: text };
                                  return { ...prev, valuation_data: { ...vd, methods } };
                                });
                                setHasChanges(true);
                              }}
                              placeholder="Timeline"
                              placeholderTextColor="#9CA3AF"
                            />
                          </View>
                          <View style={styles.fieldContainer}>
                            <Text style={styles.fieldLabel}>Use Case</Text>
                            <TextInput
                              style={styles.input}
                              value={method.useCase || ""}
                              accessibilityLabel={`${method.method || idx + 1} use case`}
                              onChangeText={(text) => {
                                setPreviewData((prev: any) => {
                                  const vd = { ...(prev?.valuation_data || {}) };
                                  const methods = [...(vd.methods || [])];
                                  methods[idx] = { ...methods[idx], useCase: text };
                                  return { ...prev, valuation_data: { ...vd, methods } };
                                });
                                setHasChanges(true);
                              }}
                              placeholder="Use case"
                              placeholderTextColor="#9CA3AF"
                            />
                          </View>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </View>
        </View>
      </>
    );
  };

  // Lot Listing Preview Content
  const renderLotListingPreview = () => {
    const lots: LotListingLot[] = Array.isArray(previewData?.lots) ? previewData.lots : [];
    const includeDamageAnalysis = previewData?.include_damage_analysis !== false;
    const bankPhotosEnabled = previewData?.bank_photos_enabled === true;

    return (
      <>
        {/* Lot Listing Badge */}
        <View style={[styles.typeBadge, { backgroundColor: `${themeColor}15`, borderColor: themeColor }]}>
          <Feather name="list" size={20} color={themeColor} />
          <View style={styles.typeBadgeText}>
            <Text style={[styles.typeBadgeTitle, { color: themeColor }]}>Lot Listing</Text>
            <Text style={styles.typeBadgeSubtitle}>{lots.length} lots | {imageCount} images</Text>
          </View>
        </View>

        {/* Basic Information */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📋</Text>
            <Text style={styles.sectionTitle}>Listing Details</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderInput("Contract Number *", "contract_no", "Contract number")}
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => updateField("bank_photos_enabled", !bankPhotosEnabled)}
            >
              <View
                style={[
                  styles.checkbox,
                  bankPhotosEnabled && {
                    backgroundColor: themeColor,
                    borderColor: themeColor,
                  },
                ]}
              >
                {bankPhotosEnabled && <Feather name="check" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkboxLabel}>Bank</Text>
                <Text style={styles.typeBadgeSubtitle}>Include all lot photos in the CR.</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="alert-triangle" size={18} color={themeColor} />
            <Text style={styles.sectionTitle}>Damages</Text>
          </View>
          <View style={styles.sectionContent}>
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => updateField("include_damage_analysis", !includeDamageAnalysis)}
            >
              <View
                style={[
                  styles.checkbox,
                  includeDamageAnalysis && {
                    backgroundColor: themeColor,
                    borderColor: themeColor,
                  },
                ]}
              >
                {includeDamageAnalysis && <Feather name="check" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkboxLabel}>Include Damages</Text>
                <Text style={styles.typeBadgeSubtitle}>
                  Applies only to lots 1000 and below. Higher lot numbers are excluded automatically.
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Quick Stats */}
        <View style={[styles.statsCard, { backgroundColor: `${themeColor}10` }]}>
          <Text style={styles.statsTitle}>📊 Listing Statistics</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: themeColor }]}>{lots.length}</Text>
              <Text style={styles.statLabel}>Lots</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: "#2563EB" }]}>{imageCount}</Text>
              <Text style={styles.statLabel}>Images</Text>
            </View>
          </View>
        </View>


        {/* Lots */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>📦</Text>
            <Text style={styles.sectionTitle}>Lots</Text>
            <View style={[styles.sectionCountBadge, { backgroundColor: `${themeColor}12`, borderColor: `${themeColor}35` }]}>
              <Text style={[styles.sectionCountText, { color: themeColor }]}>{lots.length}</Text>
            </View>
          </View>
          <PreviewLotNavigation count={lots.length} position="top" onJump={jumpToLot} />
          {lots.map((lot, idx) => {
            const lotImages = getLotPhotoEntries(lot);
            const lotUploadKey = getLotUploadKey(lot, idx);

            return (
              <View key={idx} testID={`preview-lot-${idx + 1}`} style={styles.lotCard} collapsable={idx !== 0 && idx !== lots.length - 1}
                ref={idx === 0 ? firstLotRef : idx === lots.length - 1 ? lastLotRef : null}>
                <View style={[styles.lotHeader, { borderTopColor: themeColor }]}>
                  <Text style={styles.lotTitle}>Lot {getLotDisplayNumber(lot, idx)}</Text>
                  <View style={[styles.badge, { backgroundColor: "#F3F4F6" }]}>
                    <Text style={[styles.badgeText, { color: "#6B7280" }]}>{lot.sub_mode || "bundle"}</Text>
                  </View>
                </View>

                {/* Lot Images */}
                <View style={styles.lotImagesContainer}>
                    <View style={styles.lotImagesHeader}>
                      <Text style={styles.lotImagesLabel}>
                        <Feather name="image" size={12} color="#6B7280" /> Photos ({lotImages.length})
                      </Text>
                      <TouchableOpacity
                        style={[styles.addPhotosButton, uploadingLotKey === lotUploadKey && styles.disabledButton]}
                        onPress={() => addPhotosToLot(lot, idx)}
                        disabled={uploadingLotKey === lotUploadKey}
                      >
                        {uploadingLotKey === lotUploadKey ? (
                          <ActivityIndicator size="small" color={themeColor} />
                        ) : (
                          <Feather name="plus" size={14} color={themeColor} />
                        )}
                        <Text style={[styles.addPhotosText, { color: themeColor }]}>
                          {uploadingLotKey === lotUploadKey ? "Adding" : "Add photos"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {lotImages.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.lotImagesScroll}>
                      {lotImages.slice(0, 10).map(({ url, globalIndex }, imgIdx) => (
                        <TouchableOpacity 
                          key={imgIdx} 
                          onPress={() => openLotGallery(lotImages, idx, imgIdx)}
                          accessibilityRole="button"
                          accessibilityLabel={`View lot ${getLotDisplayNumber(lot, idx)} photo ${imgIdx + 1}`}
                          style={styles.lotImageThumb}
                        >
                          <Image source={{ uri: url }} style={styles.lotImage} />
                          <TouchableOpacity
                            style={styles.lotImageDeleteBtn}
                            onPress={() => deleteLotImage(idx, { globalIndex, url })}
                            activeOpacity={0.85}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove photo ${imgIdx + 1}`}
                          >
                            <Feather name="x" size={13} color="#FFFFFF" />
                          </TouchableOpacity>
                        </TouchableOpacity>
                      ))}
                      {lotImages.length > 10 && (
                        <TouchableOpacity 
                          onPress={() => openLotGallery(lotImages, idx, 10)}
                          style={[styles.lotImageThumb, styles.moreImagesThumb]}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${lotImages.length - 10} more photos`}
                        >
                          <Text style={styles.moreImagesText}>+{lotImages.length - 10}</Text>
                        </TouchableOpacity>
                      )}
                    </ScrollView>
                    )}
                  </View>

                {/* Lot Fields - Matching Asset Excel Format */}
                <View style={styles.lotFields}>
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Lot #</Text>
                    <TextInput
                      style={styles.input}
                      value={String(lot.lot_number ?? getLotDisplayNumber(lot, idx))}
                      accessibilityLabel={`Lot ${idx + 1} number`}
                      onChangeText={(text) => updateLot(idx, "lot_number", text)}
                      placeholder={String(idx + 1)}
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>
                  {/* Title */}
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Title</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.title || ""}
                      accessibilityLabel={`Lot ${idx + 1} title`}
                      accessibilityHint="Used as Description in Excel and condition report files."
                      onChangeText={(text) => updateLot(idx, "title", text)}
                      placeholder={`Lot ${getLotDisplayNumber(lot, idx)}`}
                      placeholderTextColor="#9CA3AF"
                    />
                    <Text style={styles.fieldHelp}>Used as Description in Excel and condition report files.</Text>
                  </View>

                  {/* FMV & Quantity Row */}
                  <View style={[styles.fieldRow, compactFields && styles.fieldRowStack]}>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>FMV ($)</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.estimated_value || ""}
                        accessibilityLabel={`Lot ${idx + 1} fair market value`}
                        onChangeText={(text) => updateLot(idx, "estimated_value", text)}
                        placeholder="0"
                        placeholderTextColor="#9CA3AF"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>Quantity</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.quantity?.toString() || "1"}
                        accessibilityLabel={`Lot ${idx + 1} quantity`}
                        onChangeText={(text) => updateLot(idx, "quantity", parseInt(text) || 1)}
                        placeholder="1"
                        placeholderTextColor="#9CA3AF"
                        keyboardType="numeric"
                      />
                    </View>
                  </View>

                  {/* Categories & Item Condition Row */}
                  <View style={[styles.fieldRow, compactFields && styles.fieldRowStack]}>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>Categories</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.categories || ""}
                        accessibilityLabel={`Lot ${idx + 1} category`}
                        onChangeText={(text) => updateLot(idx, "categories", text)}
                        placeholder="Category"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>Item Condition</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.item_condition || ""}
                        accessibilityLabel={`Lot ${idx + 1} item condition`}
                        onChangeText={(text) => updateLot(idx, "item_condition", text)}
                        placeholder="Unverified Working Condition"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                  </View>

                  {/* Serial Number */}
                  <View style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>Serial Number (VIN/SN)</Text>
                    <TextInput
                      style={styles.input}
                      value={lot.serial_number || ""}
                      accessibilityLabel={`Lot ${idx + 1} serial number or VIN`}
                      autoCorrect={false}
                      onChangeText={(text) => updateLot(idx, "serial_number", text)}
                      placeholder="Serial number, VIN, model number"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>

                  {renderAuctioneerSpecs(lot, idx)}

                  {/* Opening Bid & Bid Increment Row */}
                  <View style={[styles.fieldRow, compactFields && styles.fieldRowStack]}>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>Opening Bid ($)</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.opening_bid?.toString() || ""}
                        accessibilityLabel={`Lot ${idx + 1} opening bid`}
                        onChangeText={(text) => updateLot(idx, "opening_bid", text ? parseInt(text) : null)}
                        placeholder="0"
                        placeholderTextColor="#9CA3AF"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={[styles.fieldContainer, styles.fieldRowItem]}>
                      <Text style={styles.fieldLabel}>Bid Increment ($)</Text>
                      <TextInput
                        style={styles.input}
                        value={lot.bid_increment?.toString() || ""}
                        accessibilityLabel={`Lot ${idx + 1} bid increment`}
                        onChangeText={(text) => updateLot(idx, "bid_increment", text ? parseInt(text) : null)}
                        placeholder="25"
                        placeholderTextColor="#9CA3AF"
                        keyboardType="numeric"
                      />
                    </View>
                  </View>

                </View>
              </View>
            );
          })}
          <PreviewLotNavigation count={lots.length} position="bottom" onJump={jumpToLot} />
        </View>
      </>
    );
  };

  // Real Estate Preview Content
  const renderRealEstatePreview = () => (
    <>
      {/* Property Type Badge */}
      <View style={[styles.typeBadge, { backgroundColor: `${themeColor}15`, borderColor: themeColor }]}>
        <Feather name="home" size={20} color={themeColor} />
        <View style={styles.typeBadgeText}>
          <Text style={[styles.typeBadgeTitle, { color: themeColor }]}>{propertyType} Property</Text>
          <Text style={styles.typeBadgeSubtitle}>Language: {language.toUpperCase()} | {imageCount} images</Text>
        </View>
      </View>

      {/* Property Details */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionIcon}>🏠</Text>
          <Text style={styles.sectionTitle}>Property Details</Text>
        </View>
        <View style={styles.sectionContent}>
          {renderInput("Address *", "property_details.address", "Property address")}
          {renderInput("Owner Name", "property_details.owner_name", "Owner name")}
          {renderInput("Municipality", "property_details.municipality", "Municipality")}
          {renderInput("Title Number", "property_details.title_number", "Title number")}
          {renderInput("Land Area (Acres)", "property_details.land_area_acres", "160")}
        </View>
      </View>

      {/* Report Dates */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionIcon}>📅</Text>
          <Text style={styles.sectionTitle}>Report Dates</Text>
        </View>
        <View style={styles.sectionContent}>
          {renderDateInput("Report Date", "report_dates.report_date")}
          {renderDateInput("Effective Date", "report_dates.effective_date")}
          {renderDateInput("Inspection Date", "report_dates.inspection_date")}
        </View>
      </View>

      {/* Building Details */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionIcon}>🏢</Text>
          <Text style={styles.sectionTitle}>Building Details</Text>
        </View>
        <View style={styles.sectionContent}>
          {renderInput("Year Built", "house_details.year_built", "2010")}
          {renderInput("Square Footage", "house_details.square_footage", "2500")}
          {renderInput("Lot Size (sqft)", "house_details.lot_size_sqft", "5000")}
          {renderInput("Rooms", "house_details.number_of_rooms", "4")}
          {renderInput("Full Bathrooms", "house_details.number_of_full_bathrooms", "2")}
          {renderInput("Half Bathrooms", "house_details.number_of_half_bathrooms", "1")}
        </View>
      </View>

      {/* Valuation */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionIcon}>💰</Text>
          <Text style={styles.sectionTitle}>Valuation</Text>
        </View>
        <View style={styles.sectionContent}>
          {previewData?.valuation_warning ? (
            <Text accessibilityRole="alert" style={{ color: '#B45309', marginBottom: 12 }}>{String(previewData.valuation_warning)}</Text>
          ) : null}
          {(propertyType === "agricultural" || propertyType === "farmland") ? <FarmlandValuationSummary preview={previewData || {}} /> : null}
          {renderInput("Fair Market Value", "valuation.fair_market_value", "$500,000 CAD")}
          {renderInput("Value Source", "valuation.value_source", "Direct Comparison Approach")}
          {renderInput("Valuation Summary", "valuation.final_estimate_summary", "Summary...", true)}
        </View>
      </View>

      {/* Inspector Info */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionIcon}>👤</Text>
          <Text style={styles.sectionTitle}>Inspector Info</Text>
        </View>
        <View style={styles.sectionContent}>
          {renderInput("Inspector Name", "inspector_info.inspector_name", "Inspector name")}
          {renderInput("Company Name", "inspector_info.company_name", "Company")}
          {renderInput("Contact Email", "inspector_info.contact_email", "email@example.com")}
          {renderInput("Credentials", "inspector_info.credentials", "CRA, AACI")}
        </View>
      </View>

      {/* Farmland Details Section (only for farmland property type) */}
      {(propertyType === "agricultural" || propertyType === "farmland") && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>🌾</Text>
            <Text style={styles.sectionTitle}>Farmland Details</Text>
          </View>
          <View style={styles.sectionContent}>
            {renderInput("Total Title Acres", "farmland_details.total_title_acres", "160")}
            {renderInput("Cultivated Acres", "farmland_details.cultivated_acres", "150")}
            {renderInput("RM / Area", "farmland_details.rm_area", "RM of Corman Park")}
            {renderInput("Soil Class", "farmland_details.soil_class", "1-5")}
            {renderInput("Crop Type", "farmland_details.crop_type", "Wheat, Canola")}
            {renderInput("Access Quality", "farmland_details.access_quality", "good")}
            {renderInput("Distance to City (km)", "farmland_details.distance_to_city_km", "25")}
            {renderInput("Annual Rent ($/acre)", "farmland_details.annual_rent_per_acre", "80")}
          </View>

          {/* Comparable Sales (if available) */}
          {Array.isArray(previewData?.farmland_details?.comparable_sales) && 
           previewData.farmland_details.comparable_sales.length > 0 && (
            <View style={styles.comparableContainer}>
              <Text style={styles.comparableTitle}>Comparable Sales</Text>
              {previewData.farmland_details.comparable_sales.map((sale: any, idx: number) => (
                <View key={idx} style={styles.comparableCard}>
                  <View style={styles.comparableHeader}>
                    <Text style={styles.comparableNumber}>#{idx + 1}</Text>
                    <Text style={styles.comparableLocation}>{sale.location || "Location"}</Text>
                  </View>
                  <View style={styles.comparableFields}>
                    <View style={styles.comparableRow}>
                      <Text style={styles.comparableLabel}>Sale Date:</Text>
                      <Text style={styles.comparableValue}>{sale.sale_date || "—"}</Text>
                    </View>
                    <View style={styles.comparableRow}>
                      <Text style={styles.comparableLabel}>Price/Acre:</Text>
                      <Text style={styles.comparableValue}>{sale.price_per_acre || "—"}</Text>
                    </View>
                    <View style={styles.comparableRow}>
                      <Text style={styles.comparableLabel}>Total Acres:</Text>
                      <Text style={styles.comparableValue}>{sale.total_acres || "—"}</Text>
                    </View>
                    <View style={styles.comparableRow}>
                      <Text style={styles.comparableLabel}>Soil Class:</Text>
                      <Text style={styles.comparableValue}>{sale.soil_class || "—"}</Text>
                    </View>
                    {sale.adjustments && (
                      <View style={styles.comparableRow}>
                        <Text style={styles.comparableLabel}>Adj. Rate:</Text>
                        <Text style={styles.comparableValue}>{sale.adjusted_rate || "—"}</Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Quick Stats */}
      <View style={[styles.statsCard, { backgroundColor: `${themeColor}10` }]}>
        <Text style={styles.statsTitle}>📊 Report Statistics</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: themeColor }]}>{propertyType}</Text>
            <Text style={styles.statLabel}>Type</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: "#2563EB" }]}>{language.toUpperCase()}</Text>
            <Text style={styles.statLabel}>Language</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: "#7C3AED" }]}>{imageCount}</Text>
            <Text style={styles.statLabel}>Images</Text>
          </View>
        </View>
      </View>

      {/* Property Photos */}
      {imageUrls.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="image" size={18} color={themeColor} />
            <Text style={styles.sectionTitle}>Property Photos ({imageUrls.length})</Text>
          </View>
          <View style={styles.photoGrid}>
            {imageUrls.slice(0, 12).map((url, idx) => (
              <TouchableOpacity 
                key={idx} 
                onPress={() => openReportGallery(imageUrls, idx)}
                style={styles.photoThumb}
              >
                <Image source={{ uri: url }} style={styles.photoImage} />
                <View style={styles.photoIndex}>
                  <Text style={styles.photoIndexText}>{idx + 1}</Text>
                </View>
              </TouchableOpacity>
            ))}
            {imageUrls.length > 12 && (
              <TouchableOpacity 
                onPress={() => openReportGallery(imageUrls, 12)}
                style={[styles.photoThumb, styles.morePhotosThumb]}
              >
                <Text style={styles.morePhotosText}>+{imageUrls.length - 12}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={themeColor} />
          <Text style={styles.loadingText}>Loading preview...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const conditionalReportUrl = (isAsset || isLotListing) ? previewFiles?.spec_pdf : undefined;
  const conditionalReportDocxUrl = (isAsset || isLotListing) ? previewFiles?.cr_docx : undefined;
  const downloadConditionalReport = async () => {
    if (!conditionalReportUrl) return;
    try {
      const docDir = FileSystem.documentDirectory as string | null;
      if (!docDir) throw new Error("Storage directory not available.");
      const safeReportId = String(reportId || "report").replace(/[^a-zA-Z0-9._-]/g, "_");
      const downloadPath = `${docDir}${Date.now()}_CR_${safeReportId}.pdf`;
      const downloadResult = await FileSystem.downloadAsync(conditionalReportUrl, downloadPath);
      if (downloadResult.status !== 200) {
        throw new Error(`Server returned status ${downloadResult.status}`);
      }
      const sharingAvailable = await Sharing.isAvailableAsync();
      if (sharingAvailable) {
        await Sharing.shareAsync(downloadResult.uri, {
          mimeType: "application/pdf",
          dialogTitle: "Open CR",
        });
      } else {
        Alert.alert("CR downloaded", `File saved at:\n${downloadResult.uri}`);
      }
      setTimeout(async () => {
        try {
          await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
        } catch {}
      }, 10000);
    } catch (error: any) {
      Alert.alert("CR", error?.message || "Unable to download CR.");
    }
  };

  const downloadConditionalReportDocx = async () => {
    if (!conditionalReportDocxUrl) return;
    try {
      const docDir = FileSystem.documentDirectory as string | null;
      if (!docDir) throw new Error("Storage directory not available.");
      const safeReportId = String(reportId || "report").replace(/[^a-zA-Z0-9._-]/g, "_");
      const downloadPath = `${docDir}${Date.now()}_CR_${safeReportId}.docx`;
      const downloadResult = await FileSystem.downloadAsync(conditionalReportDocxUrl, downloadPath);
      if (downloadResult.status !== 200) {
        throw new Error(`Server returned status ${downloadResult.status}`);
      }
      const sharingAvailable = await Sharing.isAvailableAsync();
      if (sharingAvailable) {
        await Sharing.shareAsync(downloadResult.uri, {
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          dialogTitle: "Open CR DOCX",
        });
      } else {
        Alert.alert("CR DOCX downloaded", `File saved at:\n${downloadResult.uri}`);
      }
      setTimeout(async () => {
        try {
          await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
        } catch {}
      }, 10000);
    } catch (error: any) {
      Alert.alert("CR DOCX", error?.message || "Unable to download CR DOCX.");
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          ref={previewScrollRef}
          pointerEvents={submitting && (isAsset || isLotListing) ? "none" : "auto"}
          accessibilityElementsHidden={submitting && (isAsset || isLotListing)}
          importantForAccessibility={submitting && (isAsset || isLotListing) ? "no-hide-descendants" : "auto"}
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            keyboardVisible && styles.scrollContentKeyboard,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              testID="preview-refresh"
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={themeColor}
              colors={[themeColor]}
            />
          }
        >
          <View ref={previewContentRef} collapsable={false}>
          {/* Hero Header */}
          <View style={[styles.heroCard, { backgroundColor: themeColor }]}>
            <View style={styles.heroGlow} />
            <View style={styles.heroContent}>
              <View style={styles.heroTop}>
                <View style={styles.heroLeft}>
                  <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back from report preview">
                    <Feather name="arrow-left" size={20} color="#fff" />
                  </TouchableOpacity>
                  <View style={styles.heroTitleSection}>
                    <Text style={styles.heroTitle}>
                      {isAsset ? "Asset Preview" : isLotListing ? "Lot Listing Preview" : "Real Estate Preview"}
                    </Text>
                    <Text style={styles.heroSubtitle}>
                      {isAssignedApproval
                        ? `Status: ${status} - Edit, regenerate, and approve`
                        : mode === "submitted"
                        ? `Status: ${status} - Edit and regenerate files`
                        : status === "preview"
                          ? isLotListing
                            ? "Edit and generate approved files"
                            : "Edit and submit report"
                          : `Status: ${status}`}
                    </Text>
                  </View>
                </View>
                {onOpenNotifications ? (
                  <TouchableOpacity onPress={onOpenNotifications} style={styles.notifBtn} activeOpacity={0.85}>
                    <Feather name="bell" size={20} color="#fff" />
                    {unreadCount > 0 ? (
                      <View style={styles.notifBadge}>
                        <Text style={styles.notifBadgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                ) : null}
              </View>

              {/* Decline Reason */}
              {status === "declined" && declineReason && (
                <View style={styles.declineBox}>
                  <Feather name="alert-circle" size={16} color="#DC2626" />
                  <View style={styles.declineTextContainer}>
                    <Text style={styles.declineTitle}>Report Declined</Text>
                    <Text style={styles.declineReason}>{declineReason}</Text>
                  </View>
                </View>
              )}
              {isAsset && previewData?.is_merged_report ? (
                <View style={styles.mergeBanner}>
                  <Feather
                    name={duplicateLotNumberKeys.size > 0 ? "alert-triangle" : "git-merge"}
                    size={17}
                    color={duplicateLotNumberKeys.size > 0 ? "#92400E" : "#1D4ED8"}
                  />
                  <View style={styles.mergeBannerText}>
                    <Text style={styles.mergeBannerTitle}>
                      Merged from {Array.isArray(previewData?.merged_from_report_ids) ? previewData.merged_from_report_ids.length : 2} reports
                    </Text>
                    <Text style={styles.mergeBannerBody}>
                      {duplicateLotNumberKeys.size > 0
                        ? `Change duplicate lot numbers: ${Array.from(duplicateLotNumberKeys).join(", ")}. Submission is blocked until they are unique.`
                        : "Source reports remain unchanged. Review the combined lots before submission."}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          </View>

          {conditionalReportUrl ? (
            <View style={styles.conditionalReportCard}>
              <View style={[styles.conditionalReportIcon, { backgroundColor: `${themeColor}18` }]}>
                <Feather name="file-text" size={18} color={themeColor} />
              </View>
              <View style={styles.conditionalReportText}>
                <Text style={styles.conditionalReportTitle}>CR</Text>
              </View>
              <TouchableOpacity
                style={[styles.conditionalReportButton, { backgroundColor: themeColor }]}
                onPress={downloadConditionalReport}
                activeOpacity={0.85}
              >
                <Feather name="download" size={15} color="#fff" />
                <Text style={styles.conditionalReportButtonText}>Download</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {conditionalReportDocxUrl ? (
            <View style={styles.conditionalReportCard}>
              <View style={[styles.conditionalReportIcon, { backgroundColor: `${themeColor}18` }]}>
                <Feather name="file" size={18} color={themeColor} />
              </View>
              <View style={styles.conditionalReportText}>
                <Text style={styles.conditionalReportTitle}>CR DOCX</Text>
              </View>
              <TouchableOpacity
                style={[styles.conditionalReportButton, { backgroundColor: themeColor }]}
                onPress={downloadConditionalReportDocx}
                activeOpacity={0.85}
              >
                <Feather name="download" size={15} color="#fff" />
                <Text style={styles.conditionalReportButtonText}>Download</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Content */}
          <View style={styles.contentSection}>
            {isAsset ? renderAssetPreview() : isLotListing ? renderLotListingPreview() : renderRealEstatePreview()}
          </View>
          </View>
        </ScrollView>

        {/* Action Buttons */}
        {!keyboardVisible ? (
        <View style={styles.actionBar}>
          {!isLotListing && !isAsset ? (
            <TouchableOpacity
              style={[styles.saveBtn, !hasChanges && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving || !hasChanges}
              accessibilityRole="button"
              accessibilityLabel="Save preview changes"
            >
              {saving ? (
                <ActivityIndicator size="small" color="#374151" />
              ) : (
                <>
                  <Feather name="save" size={18} color="#374151" />
                  <Text style={styles.saveBtnText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          {(() => {
            const submitDisabled =
              previewBusyRef.current || (!isAssignedApproval && !isLotListing && !isAsset &&
                (reportType === "RealEstate" ? !shouldResubmitRealEstate(status, mode) : mode === "pending") && hasChanges);
            const submitText = filesGenerating
              ? "Generating files..."
              : isAsset || isLotListing
                ? generationLabel
                : isAssignedApproval ? "Submit & Approve" : resubmitMode ? "Resubmit" : "Submit Report";
            return (
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (isLotListing || isAsset) && styles.submitBtnFull,
              { backgroundColor: themeColor },
              submitDisabled && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={submitDisabled}
            accessibilityRole="button"
            accessibilityLabel={submitText}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name="send" size={18} color="#fff" />
                <Text style={styles.submitBtnText}>{submitText}</Text>
              </>
            )}
          </TouchableOpacity>
            );
          })()}
        </View>
        ) : null}
      </KeyboardAvoidingView>

      {/* Expanded Spec Field Editor */}
      <Modal
        visible={!!specFieldEditor}
        transparent
        animationType="slide"
        onRequestClose={closeSpecFieldEditor}
      >
        <KeyboardSafeViewport
          testID="listing-spec-keyboard-layout"
          style={styles.specModalOverlay}
        >
          <SafeAreaView style={styles.specModalSafeArea} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.specModalCard} accessibilityViewIsModal onAccessibilityEscape={closeSpecFieldEditor}>
            <ScrollView
              testID="listing-spec-editor-scroll"
              style={styles.specModalScroll}
              contentContainerStyle={styles.specModalScrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag">
            <View style={styles.specModalHeader}>
              <View style={styles.specModalTitleWrap}>
                <Text style={styles.specModalTitle} numberOfLines={2}>
                  {specFieldEditor?.isDamage
                    ? "DAMAGES"
                    : specFieldEditor?.isNew
                    ? "ADD CONDITION REPORT FIELD"
                    : specFieldEditor?.fieldName || "Condition report field"}
                </Text>
                <Text style={styles.specModalSubtitle} numberOfLines={2}>
                  {[
                    specFieldEditor?.lotLabel ? `Lot ${specFieldEditor.lotLabel}` : "",
                    specFieldEditor?.lotTitle || "",
                  ].filter(Boolean).join(" - ") || "Edit spec value"}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.specModalCloseBtn}
                onPress={closeSpecFieldEditor}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Close spec editor"
              >
                <Feather name="x" size={22} color="#475569" />
              </TouchableOpacity>
            </View>

            {specFieldEditor?.isNew ? (
              <View style={styles.specModalFieldNameWrap}>
                <Text style={styles.specModalFieldNameLabel}>Field name</Text>
                <TextInput
                  accessibilityLabel="Condition report field name"
                  style={styles.specModalFieldNameInput}
                  value={specFieldEditor?.draftFieldName || ""}
                  onChangeText={(text) =>
                    setSpecFieldEditor((prev) =>
                      prev ? { ...prev, draftFieldName: text, error: undefined, notice: undefined } : prev
                    )
                  }
                  placeholder="Example: Engine Hours"
                  placeholderTextColor="#94A3B8"
                  autoFocus
                />
              </View>
            ) : null}

            <TextInput
              accessibilityLabel={specFieldEditor?.isDamage ? "Damage details" : `${specFieldEditor?.fieldName || "Condition report field"} value`}
              style={styles.specModalInput}
              value={specFieldEditor?.value || ""}
              onChangeText={(text) =>
                setSpecFieldEditor((prev) =>
                  prev ? { ...prev, value: text, error: undefined, notice: undefined } : prev
                )
              }
              multiline
              textAlignVertical="top"
              placeholder="Edit the full field value"
              placeholderTextColor="#94A3B8"
              autoFocus={!specFieldEditor?.isNew}
            />

            {specFieldEditor?.error ? (
              <Text style={styles.specModalErrorText}>{specFieldEditor.error}</Text>
            ) : null}
            {specFieldEditor?.notice ? (
              <Text style={styles.specModalNoticeText}>{specFieldEditor.notice}</Text>
            ) : null}

            <View style={styles.specModalActions}>
              {!specFieldEditor?.isNew ? (
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.specModalDeleteBtn}
                onPress={deleteSpecFieldFromEditor}
                activeOpacity={0.85}
              >
                <Feather name="trash-2" size={16} color="#DC2626" />
                <Text style={styles.specModalDeleteText}>
                  {specFieldEditor?.isDamage
                      ? "Clear damage"
                      : "Delete field"}
                </Text>
              </TouchableOpacity>
              ) : null}
              <View style={styles.specModalSaveActions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.specModalCancelBtn}
                  onPress={closeSpecFieldEditor}
                  activeOpacity={0.85}
                >
                  <Text style={styles.specModalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Save condition report field"
                  style={[styles.specModalSaveBtn, { backgroundColor: themeColor }]}
                  onPress={saveSpecFieldEditor}
                  activeOpacity={0.9}
                >
                  <Text style={styles.specModalSaveText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
            </ScrollView>
          </View>
          </SafeAreaView>
        </KeyboardSafeViewport>
      </Modal>

      {/* Image Gallery Modal */}
      <Modal
        visible={galleryVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setGalleryVisible(false)}
      >
        <View style={styles.galleryOverlay} testID="preview-photo-viewer">
          {/* Header */}
          <View style={styles.galleryHeader}>
            <Text style={styles.galleryCounter}>
              {galleryIndex + 1} / {galleryEntries.length}
            </Text>
            <View style={styles.galleryHeaderActions}>
              <TouchableOpacity
                onPress={() => setGalleryVisible(false)}
                style={styles.galleryCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Close photo gallery"
              >
                <Feather name="x" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Main Image */}
          <View style={styles.galleryMain}>
            {galleryIndex > 0 && (
              <TouchableOpacity
                style={[styles.galleryNav, styles.galleryNavLeft]}
                onPress={() => setGalleryIndex(galleryIndex - 1)}
                accessibilityRole="button"
                accessibilityLabel="Previous photo"
              >
                <Feather name="chevron-left" size={32} color="#fff" />
              </TouchableOpacity>
            )}
            
            {galleryEntries[galleryIndex]?.url && (
              <Image
                source={{ uri: galleryEntries[galleryIndex].url }}
                style={styles.galleryImage}
                resizeMode="contain"
              />
            )}

            {galleryIndex < galleryEntries.length - 1 && (
              <TouchableOpacity
                style={[styles.galleryNav, styles.galleryNavRight]}
                onPress={() => setGalleryIndex(galleryIndex + 1)}
                accessibilityRole="button"
                accessibilityLabel="Next photo"
              >
                <Feather name="chevron-right" size={32} color="#fff" />
              </TouchableOpacity>
            )}
          </View>

          {/* Thumbnails */}
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            style={styles.galleryThumbs}
            contentContainerStyle={styles.galleryThumbsContent}
          >
            {galleryEntries.map((entry, idx) => (
              <TouchableOpacity
                key={`${entry.context}-${entry.lotIndex ?? "report"}-${entry.globalIndex ?? "url"}-${entry.url}`}
                onPress={() => setGalleryIndex(idx)}
                style={[
                  styles.galleryThumb,
                  idx === galleryIndex && styles.galleryThumbActive,
                ]}
              >
                <Image source={{ uri: entry.url }} style={styles.galleryThumbImage} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F3F4F6",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 100,
  },
  scrollContentKeyboard: {
    paddingBottom: 28,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: "#6B7280",
  },

  // Hero Card
  heroCard: {
    borderRadius: 24,
    marginBottom: 20,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 12,
  },
  heroGlow: {
    position: "absolute",
    top: -50,
    right: -50,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
  },
  heroContent: {
    padding: 20,
  },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  heroLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  notifBadge: {
    position: "absolute",
    top: 3,
    right: 3,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#EF4444",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.72)",
  },
  notifBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    textAlign: "center",
  },
  heroTitleSection: {
    flex: 1,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.85)",
    marginTop: 2,
  },

  // Decline Box
  declineBox: {
    flexDirection: "row",
    backgroundColor: "#FEE2E2",
    borderRadius: 12,
    padding: 12,
    marginTop: 16,
    gap: 10,
  },
  declineTextContainer: {
    flex: 1,
  },
  declineTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#DC2626",
  },
  declineReason: {
    fontSize: 13,
    color: "#991B1B",
    marginTop: 2,
  },

  // CR
  conditionalReportCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
    gap: 12,
  },
  conditionalReportIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  conditionalReportText: {
    flex: 1,
  },
  conditionalReportTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#111827",
  },
  conditionalReportSubtitle: {
    fontSize: 12,
    color: "#6B7280",
    marginTop: 2,
  },
  conditionalReportButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 5,
  },
  conditionalReportButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
  },

  // Content
  contentSection: {
    flex: 1,
  },

  // Type Badge (Real Estate)
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
    gap: 12,
  },
  typeBadgeText: {
    flex: 1,
  },
  typeBadgeTitle: {
    fontSize: 16,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  typeBadgeSubtitle: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 2,
  },

  // Sections
  section: {
    backgroundColor: "#fff",
    borderRadius: 20,
    marginBottom: 16,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap: 10,
    backgroundColor: "#FFFFFF",
  },
  sectionIcon: {
    fontSize: 18,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: "#1F2937",
    flex: 1,
  },
  sectionCountBadge: {
    minWidth: 34,
    height: 30,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  sectionCountText: {
    fontSize: 14,
    fontWeight: "900",
  },
  sectionContent: {
    padding: 16,
  },

  // Fields
  fieldContainer: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 6,
  },
  fieldHelp: {
    fontSize: 12,
    color: "#4B5563",
    marginTop: 4,
  },
  signatureCard: {
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 12,
    marginBottom: 14,
  },
  signatureHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
  },
  signatureHeaderText: {
    flex: 1,
  },
  signatureTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#111827",
  },
  signatureSubtitle: {
    fontSize: 12,
    color: "#6B7280",
    lineHeight: 17,
    marginTop: 2,
  },
  mergeBanner: {
    marginTop: 14,
    flexDirection: "row",
    gap: 9,
    borderRadius: 12,
    padding: 12,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  mergeBannerText: { flex: 1 },
  mergeBannerTitle: { color: "#0F172A", fontSize: 13, fontWeight: "800" },
  mergeBannerBody: { color: "#475569", fontSize: 12, lineHeight: 17, marginTop: 2 },
  signatureClearBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
    backgroundColor: "#F9FAFB",
  },
  signatureClearBtnDisabled: {
    opacity: 0.45,
  },
  signatureClearText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#374151",
  },
  signatureCanvasWrap: {
    height: 150,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#CBD5E1",
    backgroundColor: "#F8FAFC",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  signatureCanvas: {
    ...StyleSheet.absoluteFillObject,
  },
  signaturePreviewImage: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  signaturePlaceholder: {
    fontSize: 13,
    fontWeight: "700",
    color: "#94A3B8",
  },
  signatureStatus: {
    marginTop: 8,
    fontSize: 12,
    color: "#6B7280",
    fontWeight: "700",
  },
  input: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#1F2937",
  },
  duplicateLotInput: {
    borderColor: "#F59E0B",
    backgroundColor: "#FFFBEB",
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  // Stats Card
  statsCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  statsTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  statItem: {
    alignItems: "center",
  },
  statValue: {
    fontSize: 20,
    fontWeight: "800",
  },
  statLabel: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 2,
  },

  // Lot Card
  lotCard: {
    backgroundColor: "#F9FAFB",
    borderRadius: 16,
    margin: 12,
    marginTop: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  lotHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: "#fff",
    borderTopWidth: 6,
    borderTopColor: "#8B5CF6",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  lotTitle: {
    fontSize: 21,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: 0,
  },
  deleteLotBtn: {
    padding: 8,
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
  },
  lotImagesContainer: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  lotImagesLabel: {
    fontSize: 12,
    color: "#6B7280",
  },
  lotImagesHeader: {
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  addPhotosButton: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E9D5FF",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  addPhotosText: {
    fontSize: 12,
    fontWeight: "800",
  },
  disabledButton: {
    opacity: 0.65,
  },
  lotImagesScroll: {
    flexDirection: "row",
  },
  lotImageThumb: {
    width: 64,
    height: 64,
    borderRadius: 10,
    marginRight: 8,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#E5E7EB",
  },
  lotImageDeleteBtn: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: "#DC2626",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.9)",
  },
  lotImage: {
    width: "100%",
    height: "100%",
  },
  moreImagesThumb: {
    backgroundColor: "#E5E7EB",
    justifyContent: "center",
    alignItems: "center",
  },
  moreImagesText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#6B7280",
  },
  lotFields: {
    padding: 14,
  },
  specEditorCard: {
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: 0,
    padding: 0,
    marginBottom: 14,
  },
  specEditorHeader: {
    gap: 12,
    marginBottom: 14,
  },
  specHeaderText: {
    width: "100%",
  },
  specHeaderActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  specEditorTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  specEditorSubtitle: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
    lineHeight: 18,
  },
  specCountBadge: {
    flex: 1,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  specCountText: {
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  specToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
    backgroundColor: "#FFFFFF",
  },
  specToggleText: {
    fontSize: 11,
    fontWeight: "800",
  },
  addSpecFieldBtn: {
    minHeight: 44,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
  },
  addSpecFieldText: {
    fontSize: 12,
    fontWeight: "900",
  },
  damageAnalysisCard: {
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 16,
    backgroundColor: "#FFF7F7",
    padding: 12,
  },
  damageAnalysisHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },
  damageAnalysisTitleWrap: {
    flex: 1,
  },
  damageAnalysisTitle: {
    fontSize: 12,
    fontWeight: "900",
    color: "#B91C1C",
    letterSpacing: 0.5,
  },
  damageAnalysisSubtitle: {
    marginTop: 2,
    fontSize: 11,
    color: "#6B7280",
    lineHeight: 15,
  },
  damageAnalysisEditPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  damageAnalysisEditText: {
    fontSize: 11,
    fontWeight: "900",
    color: "#B91C1C",
  },
  damageAnalysisBody: {
    fontSize: 13,
    color: "#1F2937",
    lineHeight: 18,
  },
  damageAnalysisPlaceholder: {
    fontSize: 13,
    color: "#9CA3AF",
    lineHeight: 18,
  },
  damagePolicyCard: {
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 14,
    backgroundColor: "#FFFBEB",
    padding: 12,
  },
  damagePolicyTitle: {
    fontSize: 12,
    fontWeight: "900",
    color: "#92400E",
    letterSpacing: 0.4,
  },
  damagePolicyText: {
    marginTop: 4,
    fontSize: 12,
    color: "#92400E",
    lineHeight: 18,
  },
  specFields: {
    gap: 10,
  },
  specFieldContainer: {
    marginBottom: 2,
  },
  specFieldHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  specFieldLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    color: "#374151",
    lineHeight: 18,
  },
  specDeleteBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    alignItems: "center",
    justifyContent: "center",
  },
  specCollapsedText: {
    fontSize: 12,
    color: "#64748B",
    paddingVertical: 8,
  },
  specEmptyText: {
    fontSize: 12,
    color: "#6B7280",
    paddingVertical: 8,
  },
  specModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.48)",
  },
  specModalCard: {
    maxHeight: "100%",
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 18,
  },
  specModalSafeArea: { flex: 1, minHeight: 0, justifyContent: "flex-end" },
  specModalScroll: { flexShrink: 1 },
  specModalScrollContent: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
  specModalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
  },
  specModalTitleWrap: {
    flex: 1,
  },
  specModalTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#111827",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  specModalSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: "#64748B",
    lineHeight: 18,
  },
  specModalCloseBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    alignItems: "center",
    justifyContent: "center",
  },
  specModalFieldNameWrap: {
    marginBottom: 12,
  },
  specModalFieldNameLabel: {
    marginBottom: 6,
    fontSize: 11,
    fontWeight: "900",
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  specModalFieldNameInput: {
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: "#0F172A",
    backgroundColor: "#FFFFFF",
  },
  specModalInput: {
    minHeight: 88,
    maxHeight: 240,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 16,
    backgroundColor: "#F8FAFC",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 23,
    color: "#111827",
  },
  specModalErrorText: {
    marginTop: 8,
    marginBottom: 4,
    fontSize: 12,
    fontWeight: "800",
    color: "#DC2626",
  },
  specModalNoticeText: {
    marginTop: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 12,
    backgroundColor: "#FFFBEB",
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: "800",
    color: "#92400E",
  },
  specModalActions: {
    marginTop: 14,
    gap: 12,
  },
  specModalDeleteBtn: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  specModalDeleteText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#DC2626",
  },
  specModalSaveActions: {
    flexDirection: "row",
    gap: 10,
  },
  specModalCancelBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  specModalCancelText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#475569",
  },
  specModalSaveBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 7,
  },
  specModalSaveText: {
    fontSize: 15,
    fontWeight: "900",
    color: "#FFFFFF",
  },

  // Photo Grid
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: 12,
    gap: 8,
  },
  photoThumb: {
    width: (SCREEN_WIDTH - 64) / 4,
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#E5E7EB",
  },
  photoImage: {
    width: "100%",
    height: "100%",
  },
  photoIndex: {
    position: "absolute",
    bottom: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  photoIndexText: {
    fontSize: 10,
    color: "#fff",
    fontWeight: "600",
  },
  morePhotosThumb: {
    backgroundColor: "#E5E7EB",
    justifyContent: "center",
    alignItems: "center",
  },
  morePhotosText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#6B7280",
  },

  // Action Bar
  actionBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    padding: 16,
    paddingBottom: 24,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  saveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    gap: 8,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#374151",
  },
  submitBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 14,
    gap: 8,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  submitBtnFull: {
    flex: 1,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },

  // Gallery Modal
  galleryOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  galleryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingTop: 50,
  },
  galleryCounter: {
    fontSize: 16,
    color: "#fff",
    fontWeight: "600",
  },
  galleryHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  galleryCloseBtn: {
    padding: 8,
  },
  galleryMain: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  galleryImage: {
    width: SCREEN_WIDTH - 32,
    height: SCREEN_WIDTH - 32,
    borderRadius: 12,
  },
  galleryNav: {
    position: "absolute",
    padding: 12,
    backgroundColor: "rgba(0,0,0,0.3)",
    borderRadius: 30,
    zIndex: 10,
  },
  galleryNavLeft: {
    left: 16,
  },
  galleryNavRight: {
    right: 16,
  },
  galleryThumbs: {
    maxHeight: 100,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  galleryThumbsContent: {
    padding: 12,
    gap: 8,
    alignItems: "center",
  },
  galleryThumb: {
    width: 60,
    height: 60,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
    marginRight: 8,
  },
  galleryThumbActive: {
    borderColor: "#fff",
  },
  galleryThumbImage: {
    width: "100%",
    height: "100%",
  },

  // Checkbox styles
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#D1D5DB",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  checkboxChecked: {
    backgroundColor: "#F43F5E",
    borderColor: "#F43F5E",
  },
  checkboxLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
  },

  // Valuation section styles
  valuationMethodsContainer: {
    backgroundColor: "#EFF6FF",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  valuationMethodsTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1E40AF",
    marginBottom: 10,
  },
  methodBadges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  methodBadge: {
    backgroundColor: "#DBEAFE",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  methodBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1D4ED8",
  },
  baseFmvContainer: {
    marginBottom: 14,
  },
  baseFmvLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#374151",
    marginBottom: 8,
  },
  comparisonTableContainer: {
    marginTop: 8,
  },
  comparisonTableTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 12,
  },
  methodCard: {
    backgroundColor: "#F9FAFB",
    borderRadius: 14,
    marginBottom: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  methodCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
    gap: 10,
  },
  methodCardCode: {
    backgroundColor: "#FEE2E2",
    color: "#DC2626",
    fontSize: 11,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: "hidden",
  },
  methodCardName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1F2937",
    flex: 1,
  },
  methodCardFields: {
    padding: 12,
  },

  // Comparable sales styles (Farmland)
  comparableContainer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  comparableTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 12,
  },
  comparableCard: {
    backgroundColor: "#F0FDF4",
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#BBF7D0",
    overflow: "hidden",
  },
  comparableHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    backgroundColor: "#DCFCE7",
    borderBottomWidth: 1,
    borderBottomColor: "#BBF7D0",
    gap: 10,
  },
  comparableNumber: {
    fontSize: 13,
    fontWeight: "800",
    color: "#166534",
  },
  comparableLocation: {
    fontSize: 13,
    fontWeight: "600",
    color: "#15803D",
    flex: 1,
  },
  comparableFields: {
    padding: 12,
  },
  comparableRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  comparableLabel: {
    fontSize: 12,
    color: "#6B7280",
    fontWeight: "500",
  },
  comparableValue: {
    fontSize: 12,
    color: "#1F2937",
    fontWeight: "600",
  },
  // Badge styles for lot listing
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  assetLotCheckbox: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  bulkConditionCard: {
    marginBottom: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#FACC15",
    backgroundColor: "#FFFBEB",
    padding: 14,
  },
  bulkConditionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  bulkConditionHeaderText: {
    flex: 1,
  },
  bulkConditionTitle: {
    fontSize: 14,
    fontWeight: "900",
    color: "#78350F",
  },
  bulkConditionSubtitle: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
    color: "#92400E",
  },
  bulkConditionCountBadge: {
    borderWidth: 1,
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  bulkConditionCountText: {
    fontSize: 11,
    fontWeight: "900",
  },
  bulkConditionOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  bulkConditionChip: {
    minHeight: 38,
    maxWidth: "100%",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FDE68A",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  bulkConditionChipText: {
    color: "#78350F",
    fontSize: 12,
    fontWeight: "800",
    flexShrink: 1,
  },
  selectionCard: {
    marginBottom: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#FACC15",
    backgroundColor: "#FFFBEB",
    padding: 12,
  },
  selectionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 10,
  },
  selectionHeaderText: {
    flex: 1,
    minWidth: 180,
    maxWidth: "100%",
  },
  selectionTitle: {
    color: "#92400E",
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  selectionSubtitle: {
    marginTop: 2,
    color: "#92400E",
    fontSize: 11,
    fontWeight: "600",
  },
  selectionBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: "#FFFFFF",
    alignSelf: "flex-start",
    flexShrink: 0,
  },
  selectionBadgeText: {
    fontSize: 11,
    fontWeight: "900",
  },
  selectionGroup: {
    marginTop: 8,
  },
  selectionGroupLabel: {
    color: "#374151",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 6,
  },
  selectionOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
  selectionChip: {
    minHeight: 44,
    maxWidth: "100%",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  selectionChipText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800",
    flexShrink: 1,
  },
  // Field row for side-by-side inputs
  fieldRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 0,
  },
  fieldRowStack: { flexDirection: "column", gap: 0 },
  fieldRowItem: {
    flex: 1,
  },
});

export default PreviewScreen;
