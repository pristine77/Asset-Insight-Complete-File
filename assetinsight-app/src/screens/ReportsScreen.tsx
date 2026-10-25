import React, { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
// Use legacy API for expo-file-system v54+
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FileSystem = require("expo-file-system/legacy");
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import assetService, { AssetReport } from "../services/assetService";
import api from "../services/api";
import AssetMergeSheet from "../components/AssetMergeSheet";

interface RealEstateReport {
  _id: string;
  status: string;
  property_details?: {
    address?: string;
    owner_name?: string;
  };
  preview_data?: {
    property_details?: {
      address?: string;
    };
    valuation?: {
      fair_market_value?: string;
    };
  };
  preview_files?: {
    pdf?: string;
    spec_pdf?: string;
    cr_docx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  };
  release_status?: "pending_release" | "released";
  released_at?: string | null;
  downloadable?: boolean;
  generation_state?: "queued" | "processing" | "ready" | "error";
  files_ready?: boolean;
  job_error?: string;
  generation_progress?: ReportGroup["generationProgress"];
  createdAt: string;
}

interface ReportGroup {
  id: string;
  name: string;
  type: "Asset" | "RealEstate" | "LotListing";
  status: string;
  fmv: string;
  createdAt: string;
  releaseStatus?: "pending_release" | "released";
  downloadable: boolean;
  generationState?: "queued" | "processing" | "ready" | "error";
  jobError?: string;
  generationProgress?: {
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
  };
  files: {
    pdf?: string;
    conditionalReport?: string;
    crDocx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  };
  isMergedReport?: boolean;
  mergedSourceCount?: number;
  contract: string;
  lotCount: number;
  lotSummary: string;
  thumbnail?: string;
}

interface LotListingReport {
  _id: string;
  status: string;
  contract_no: string;
  location: string;
  sales_date: string;
  preview_data?: {
    contract_no?: string;
    location?: string;
    lots?: any[];
  };
  preview_files?: {
    spec_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  files?: {
    spec_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  lots?: any[];
  release_status?: "pending_release" | "released";
  released_at?: string | null;
  downloadable?: boolean;
  generation_state?: "queued" | "processing" | "ready" | "error";
  files_ready?: boolean;
  job_error?: string;
  generation_progress?: ReportGroup["generationProgress"];
  createdAt: string;
}

interface ReportsScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  onOpenPreview?: (reportId: string, reportType: "Asset" | "RealEstate" | "LotListing") => void;
  onMergeCreated?: (reportId: string) => void;
}

const ReportsScreen = ({
  onOpenDrawer,
  onBack,
  unreadCount = 0,
  onOpenNotifications,
  onOpenPreview,
  onMergeCreated,
}: ReportsScreenProps) => {
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "pending" | "approved">("all");
  const [reports, setReports] = useState<ReportGroup[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [mergeAnchorId, setMergeAnchorId] = useState<string | null>(null);

  const getFirstLotImage = useCallback((lots: any[], globalUrls: string[] = []) => {
    for (const lot of Array.isArray(lots) ? lots : []) {
      const direct = lot?.image_url || lot?.image_urls?.[0] || lot?.extra_image_urls?.[0];
      if (direct) return String(direct);
      const firstIndex = lot?.image_indexes?.[0];
      if (Number.isInteger(firstIndex) && globalUrls[firstIndex]) return globalUrls[firstIndex];
    }
    return globalUrls[0];
  }, []);

  const summarizeLots = (lots: any[], reportId: string) => {
    const numbers = (Array.isArray(lots) ? lots : [])
      .map((lot) => String(lot?.lot_number ?? "").trim())
      .filter(Boolean);
    if (numbers.length > 0) {
      const first = numbers.slice(0, 3).map((value) => `Lot ${value}`).join(", ");
      return numbers.length > 3 ? `${first} +${numbers.length - 3}` : first;
    }
    return `#${reportId.slice(-6)}`;
  };
  
  // ZIP Modal state
  const [zipModalVisible, setZipModalVisible] = useState(false);
  const [selectedZipUrl, setSelectedZipUrl] = useState<string | null>(null);
  const [selectedZipName, setSelectedZipName] = useState<string>("");
  const [extracting, setExtracting] = useState(false);

  const fetchReports = useCallback(async () => {
    try {
      // Fetch asset reports
      const assetReports = await assetService.getAssetReports();
      
      // Fetch real estate reports
      let realEstateReports: RealEstateReport[] = [];
      try {
        const reResponse = await api.get("/real-estate");
        realEstateReports = reResponse.data.data || [];
      } catch (e) {
        console.log("No real estate reports or error fetching");
      }

      // Fetch lot listing reports
      let lotListingReports: LotListingReport[] = [];
      try {
        const llResponse = await api.get("/lot-listing");
        lotListingReports = llResponse.data.data || [];
      } catch (e) {
        console.log("No lot listing reports or error fetching");
      }

      // Filter and transform reports - include preview and declined for editing
      const visibleStatuses = ["approved", "pending_approval", "preview", "declined", "processing", "error"];
      const visibleAssets = assetReports.filter(
        (r) => visibleStatuses.includes(r.status)
      );
      const visibleRealEstate = realEstateReports.filter(
        (r) => visibleStatuses.includes(r.status)
      );
      const visibleLotListings = lotListingReports.filter(
        (r) => visibleStatuses.includes(r.status)
      );

      // Transform to ReportGroup
      const groups: ReportGroup[] = [];

      for (const ar of visibleAssets) {
        const previewData = ar.preview_data || {};
        const clientName = previewData?.client_name || "Asset Report";
        const lots = Array.isArray(previewData?.lots) ? previewData.lots : [];
        const total = lots.reduce((acc: number, lot: any) => {
          const raw = typeof lot?.estimated_value === "string" ? lot.estimated_value : "";
          const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
          return acc + (Number.isFinite(num) ? num : 0);
        }, 0);
        const currency = previewData?.currency || "CAD";
        const fmvStr = total > 0
          ? new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(total)
          : `${currency} —`;

        groups.push({
          id: ar._id,
          name: `${clientName} - ${summarizeLots(lots, ar._id)}`,
          type: "Asset",
          status: ar.status === "approved" ? "approved" : (ar.status === "preview" || ar.status === "declined" ? ar.status : "pending"),
          fmv: fmvStr,
          createdAt: ar.createdAt,
          releaseStatus: ar.release_status,
          downloadable: ar.downloadable !== false,
          generationState: ar.generation_state,
          jobError: ar.job_error,
          generationProgress: ar.generation_progress,
          files: {
            pdf: ar.preview_files?.pdf,
            conditionalReport: ar.preview_files?.spec_pdf,
            crDocx: ar.preview_files?.cr_docx,
            docx: ar.preview_files?.docx,
            excel: ar.preview_files?.excel,
            images: ar.preview_files?.images,
          },
          isMergedReport: ar.is_merged_report === true,
          mergedSourceCount: Array.isArray(ar.merged_from_report_ids)
            ? ar.merged_from_report_ids.length
            : 0,
          contract: String(previewData?.contract_no || (ar as any).contract_no || "").trim(),
          lotCount: lots.length,
          lotSummary: summarizeLots(lots, ar._id),
          thumbnail: getFirstLotImage(lots, Array.isArray(previewData?.image_urls) ? previewData.image_urls : []),
        });
      }

      for (const re of visibleRealEstate) {
        const address = re.property_details?.address ||
          re.preview_data?.property_details?.address ||
          re.property_details?.owner_name ||
          "Real Estate Report";
        const fmv = re.preview_data?.valuation?.fair_market_value || "—";

        groups.push({
          id: re._id,
          name: address,
          type: "RealEstate",
          status: re.status === "approved" ? "approved" : (re.status === "preview" || re.status === "declined" ? re.status : "pending"),
          fmv: String(fmv),
          createdAt: re.createdAt,
          releaseStatus: re.release_status,
          downloadable: re.downloadable !== false,
          generationState: re.generation_state,
          jobError: re.job_error,
          generationProgress: re.generation_progress,
          files: {
            pdf: (re as any).preview_files?.pdf,
            docx: (re as any).preview_files?.docx,
            excel: (re as any).preview_files?.excel,
            images: (re as any).preview_files?.images,
          },
          contract: String((re as any).contract_no || "").trim(),
          lotCount: 1,
          lotSummary: "Property",
          thumbnail: (re as any).preview_data?.image_urls?.[0] || (re as any).image_urls?.[0],
        });
      }

      for (const ll of visibleLotListings) {
        const previewData = ll.preview_data || {};
        const contractNo = previewData.contract_no || ll.contract_no || "Lot Listing";
        const location = previewData.location || ll.location || "";
        const lots = previewData.lots || ll.lots || [];
        const displayName = `${contractNo} - ${summarizeLots(lots, ll._id)}${location ? ` - ${location}` : ""}`;

        groups.push({
          id: ll._id,
          name: displayName,
          type: "LotListing",
          status: ll.status === "approved" ? "approved" : (ll.status === "preview" || ll.status === "declined" ? ll.status : "pending"),
          fmv: `${lots.length} lots`,
          createdAt: ll.createdAt,
          releaseStatus: ll.release_status,
          downloadable: ll.downloadable !== false,
          generationState: ll.generation_state,
          jobError: ll.job_error,
          generationProgress: ll.generation_progress,
          files: {
            conditionalReport: ll.preview_files?.spec_pdf || ll.files?.spec_pdf,
            crDocx: ll.preview_files?.cr_docx || ll.files?.cr_docx,
            // Lot listings use preview_files for all statuses (auto-approved)
            excel: ll.preview_files?.excel || ll.files?.excel,
            images: ll.preview_files?.images || ll.files?.images,
          },
          contract: String(contractNo).trim(),
          lotCount: lots.length,
          lotSummary: summarizeLots(lots, ll._id),
          thumbnail: getFirstLotImage(
            lots,
            Array.isArray((previewData as any).image_urls) ? (previewData as any).image_urls : []
          ),
        });
      }

      // Sort by date descending
      groups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setReports(groups);
    } catch (e: any) {
      console.error("Failed to fetch reports:", e);
      Alert.alert("Error", "Failed to load reports");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [getFirstLotImage]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    const hasActive = reports.some(
      (report) => report.generationState === "queued" || report.generationState === "processing"
    );
    if (!hasActive) return;
    const timer = setInterval(() => void fetchReports(), 10000);
    return () => clearInterval(timer);
  }, [fetchReports, reports]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchReports();
  }, [fetchReports]);

  const filteredReports = reports.filter((r) => {
    // Filter by tab
    let tabMatch = true;
    if (activeTab === "pending") tabMatch = r.status === "pending" || r.status === "preview" || r.status === "declined";
    if (activeTab === "approved") tabMatch = r.status === "approved";
    
    // Filter by search query
    let searchMatch = true;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const nameMatch = r.name.toLowerCase().includes(query);
      const idMatch = r.id.toLowerCase().includes(query);
      searchMatch = nameMatch || idMatch;
    }
    
    return tabMatch && searchMatch;
  });

  const stats = {
    total: reports.length,
    pending: reports.filter((r) => r.status === "pending" || r.status === "preview" || r.status === "declined").length,
    approved: reports.filter((r) => r.status === "approved").length,
  };

  const tabs = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
  ];

  // Download file directly (DOCX, XLSX) - In-app download
  const handleDownload = async (url: string, filename: string, reportId: string) => {
    if (!url) {
      Alert.alert("Error", "Download URL not available");
      return;
    }

    setDownloadingId(reportId);
    
    try {
      // Get document directory
      const docDir = FileSystem.documentDirectory as string | null;
      console.log("[Download] docDir:", docDir);
      console.log("[Download] URL:", url);
      
      if (!docDir) {
        throw new Error("Storage directory not available. Please rebuild the app with: npx expo prebuild --clean && npx expo run:android");
      }
      
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const timestamp = Date.now();
      const downloadPath = `${docDir}${timestamp}_${sanitizedFilename}`;
      
      console.log("[Download] Downloading to:", downloadPath);
      
      // Download file using downloadAsync
      const downloadResult = await FileSystem.downloadAsync(url, downloadPath);
      console.log("[Download] Result status:", downloadResult.status);
      console.log("[Download] Result uri:", downloadResult.uri);
      
      if (downloadResult.status !== 200) {
        throw new Error(`Server returned status ${downloadResult.status}`);
      }
      
      // Verify file exists
      const fileInfo = await FileSystem.getInfoAsync(downloadResult.uri);
      console.log("[Download] File exists:", fileInfo.exists);
      
      if (!fileInfo.exists) {
        throw new Error("File was not saved properly");
      }
      
      // Determine MIME type
      let mimeType = "application/octet-stream";
      if (filename.endsWith(".pdf")) {
        mimeType = "application/pdf";
      } else if (filename.endsWith(".docx")) {
        mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      } else if (filename.endsWith(".xlsx")) {
        mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      } else if (filename.endsWith(".zip")) {
        mimeType = "application/zip";
      }
      
      // Check if sharing is available
      const sharingAvailable = await Sharing.isAvailableAsync();
      console.log("[Download] Sharing available:", sharingAvailable);
      
      if (sharingAvailable) {
        // Open share dialog - user can save to Files, open in app, etc.
        await Sharing.shareAsync(downloadResult.uri, {
          mimeType,
          dialogTitle: `Save ${filename}`,
        });
        
        Alert.alert("Success", `${filename} downloaded successfully!`);
      } else {
        Alert.alert(
          "Download Complete",
          `File saved. Sharing not available on this device.\n\nPath: ${downloadResult.uri}`,
          [{ text: "OK" }]
        );
      }
      
      // Clean up after 10 seconds
      setTimeout(async () => {
        try {
          await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
        } catch {}
      }, 10000);
      
    } catch (e: any) {
      console.error("[Download] Error:", e);
      Alert.alert(
        "Download Error",
        e.message || "Unknown error occurred",
        [{ text: "OK" }]
      );
    } finally {
      setDownloadingId(null);
    }
  };

  // Show ZIP modal with options
  const handleZipPress = (url: string, reportName: string) => {
    if (!url) {
      Alert.alert("Error", "ZIP download URL not available");
      return;
    }
    setSelectedZipUrl(url);
    setSelectedZipName(reportName);
    setZipModalVisible(true);
  };

  // Download ZIP only (no extract) - In-app download
  const handleDownloadZipOnly = async () => {
    if (!selectedZipUrl) return;
    
    setZipModalVisible(false);
    setDownloadingId("zip-download");
    
    try {
      const docDir = FileSystem.documentDirectory as string | null;
      console.log("[ZipDownload] docDir:", docDir);
      
      if (!docDir) {
        throw new Error("Storage directory not available. Please rebuild the app.");
      }
      
      const zipFilename = `${selectedZipName.replace(/[^a-zA-Z0-9]/g, "_")}_images.zip`;
      const timestamp = Date.now();
      const downloadPath = `${docDir}${timestamp}_${zipFilename}`;
      
      console.log("[ZipDownload] Downloading:", selectedZipUrl);
      console.log("[ZipDownload] To:", downloadPath);
      
      const downloadResult = await FileSystem.downloadAsync(selectedZipUrl, downloadPath);
      console.log("[ZipDownload] Status:", downloadResult.status);
      
      if (downloadResult.status !== 200) {
        throw new Error(`Server returned status ${downloadResult.status}`);
      }
      
      const fileInfo = await FileSystem.getInfoAsync(downloadResult.uri);
      if (!fileInfo.exists) {
        throw new Error("File was not saved properly");
      }
      
      const sharingAvailable = await Sharing.isAvailableAsync();
      console.log("[ZipDownload] Sharing available:", sharingAvailable);
      
      if (sharingAvailable) {
        await Sharing.shareAsync(downloadResult.uri, {
          mimeType: "application/zip",
          dialogTitle: `Save ${zipFilename}`,
        });
        Alert.alert("Success", `${zipFilename} downloaded successfully!`);
      } else {
        Alert.alert("Download Complete", `File saved to: ${downloadResult.uri}`);
      }
      
      setTimeout(async () => {
        try {
          await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
        } catch {}
      }, 10000);
      
    } catch (e: any) {
      console.error("[ZipDownload] Error:", e);
      Alert.alert("Download Error", e.message || "Unknown error");
    } finally {
      setDownloadingId(null);
    }
  };

  // Download ZIP and extract images to gallery
  const handleDownloadAndExtract = async () => {
    if (!selectedZipUrl) return;
    
    setExtracting(true);
    
    try {
      const docDir = FileSystem.documentDirectory as string | null;
      console.log("[ExtractDownload] docDir:", docDir);
      
      if (!docDir) {
        throw new Error("Storage directory not available. Please rebuild the app.");
      }

      const zipFileName = `${selectedZipName.replace(/[^a-zA-Z0-9]/g, "_")}_images.zip`;
      const timestamp = Date.now();
      const downloadPath = `${docDir}${timestamp}_${zipFileName}`;
      
      console.log("[ExtractDownload] Downloading:", selectedZipUrl);
      
      const downloadResult = await FileSystem.downloadAsync(selectedZipUrl, downloadPath);
      console.log("[ExtractDownload] Status:", downloadResult.status);

      if (downloadResult.status !== 200) {
        throw new Error(`Server returned status ${downloadResult.status}`);
      }

      const fileInfo = await FileSystem.getInfoAsync(downloadResult.uri);
      if (!fileInfo.exists) {
        throw new Error("File was not saved properly");
      }

      const sharingAvailable = await Sharing.isAvailableAsync();
      console.log("[ExtractDownload] Sharing available:", sharingAvailable);
      
      if (sharingAvailable) {
        await Sharing.shareAsync(downloadResult.uri, {
          mimeType: "application/zip",
          dialogTitle: `Save ${zipFileName}`,
        });
        Alert.alert("Success", `${zipFileName} downloaded successfully!`);
      } else {
        Alert.alert("Download Complete", `File saved to: ${downloadResult.uri}`);
      }
      
      setTimeout(async () => {
        try {
          await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
        } catch {}
      }, 10000);
      
    } catch (e: any) {
      console.error("[ExtractDownload] Error:", e);
      Alert.alert("Download Error", e.message || "Unknown error");
    } finally {
      setExtracting(false);
      setZipModalVisible(false);
    }
  };

  const getStatusBadge = (status: string, releaseStatus?: string, generationState?: string) => {
    if (generationState === "error") {
      return { bg: "#FEE2E2", text: "#DC2626", label: "Generation failed" };
    }
    if (generationState === "queued" || generationState === "processing") {
      return { bg: "#DBEAFE", text: "#2563EB", label: "Generating files" };
    }
    if (status === "approved" && releaseStatus === "pending_release") {
      return { bg: "#FEF3C7", text: "#D97706", label: "Awaiting release" };
    }
    if (status === "approved") {
      return { bg: "#D1FAE5", text: "#059669", label: "Approved" };
    }
    if (status === "preview") {
      return { bg: "#DBEAFE", text: "#2563EB", label: "Preview" };
    }
    if (status === "declined") {
      return { bg: "#FEE2E2", text: "#DC2626", label: "Declined" };
    }
    return { bg: "#FEF3C7", text: "#D97706", label: "Pending" };
  };

  const getTypeBadge = (type: string) => {
    if (type === "RealEstate") {
      return { bg: "#D1FAE5", text: "#059669", label: "Real Estate" };
    }
    if (type === "LotListing") {
      return { bg: "#F5F3FF", text: "#8B5CF6", label: "Lot Listing" };
    }
    return { bg: "#DBEAFE", text: "#2563EB", label: "Asset" };
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh}
            tintColor="#F43F5E"
            colors={["#F43F5E"]}
          />
        }
      >
        {/* Hero Header Card */}
        <View style={styles.heroCard}>
          <View style={styles.heroGlow} />
          <View style={styles.heroContent}>
            <View style={styles.heroTop}>
              <View style={styles.heroLeft}>
                <TouchableOpacity onPress={onOpenDrawer} style={styles.menuBtn}>
                  <Feather name="menu" size={22} color="#fff" />
                </TouchableOpacity>
                <View style={styles.heroTitleSection}>
                  <Text style={styles.heroTitle}>My Reports</Text>
                  <Text style={styles.heroSubtitle}>
                    {stats.total} {stats.total === 1 ? 'report' : 'reports'} • {stats.approved} approved
                  </Text>
                </View>
              </View>
              <View style={styles.heroActions}>
                <TouchableOpacity
                  onPress={onRefresh}
                  style={[styles.notifBtn, (refreshing || loading) && styles.headerIconDisabled]}
                  activeOpacity={0.85}
                  disabled={refreshing || loading}>
                  {refreshing || loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Feather name="refresh-cw" size={19} color="#fff" />
                  )}
                </TouchableOpacity>
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
                <TouchableOpacity onPress={onBack} style={styles.backBtn}>
                  <Feather name="arrow-left" size={20} color="rgba(255,255,255,0.9)" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Search Bar inside hero */}
            <View style={styles.searchContainer}>
              <Feather name="search" size={16} color="rgba(255,255,255,0.7)" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search by name or ID..."
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery("")} style={styles.searchClear}>
                  <Feather name="x" size={14} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              )}
            </View>

            {/* Tabs inside hero */}
            <View style={styles.tabContainer}>
              {tabs.map((tab) => (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.tab, activeTab === tab.key && styles.tabActive]}
                  onPress={() => setActiveTab(tab.key as typeof activeTab)}
                >
                  <Feather 
                    name={tab.key === "all" ? "layers" : tab.key === "pending" ? "clock" : "check-circle"} 
                    size={14} 
                    color={activeTab === tab.key ? "#F43F5E" : "rgba(255,255,255,0.7)"} 
                  />
                  <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Content Section */}
        <View style={styles.contentSection}>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#F43F5E" />
          </View>
        ) : filteredReports.length === 0 ? (
          <View style={styles.emptyState}>
            <Feather name="file-text" size={48} color="#D1D5DB" />
            <Text style={styles.emptyText}>No reports yet</Text>
            <Text style={styles.emptySubtext}>
              Your appraisal reports will appear here once created
            </Text>
          </View>
        ) : (
          <View style={styles.reportsList}>
            {filteredReports.map((report) => {
              const statusBadge = getStatusBadge(report.status, report.releaseStatus, report.generationState);
              const typeBadge = getTypeBadge(report.type);
              const hasFiles = report.files.pdf || report.files.conditionalReport || report.files.crDocx || report.files.docx || report.files.excel || report.files.images;
              const isDownloading = downloadingId === report.id;
              const downloadable = report.downloadable !== false;

              return (
                <View key={report.id} style={styles.reportCard}>
                  {/* Report Header */}
                  <View style={styles.reportHeader}>
                    <View style={styles.reportIconContainer}>
                      <Feather
                        name={report.type === "RealEstate" ? "home" : report.type === "LotListing" ? "list" : "package"}
                        size={18}
                        color={typeBadge.text}
                      />
                    </View>
                    <View style={styles.reportInfo}>
                      <Text style={styles.reportName} numberOfLines={1}>
                        {report.name}
                      </Text>
                      <Text style={styles.reportDate}>
                        {new Date(report.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                  </View>

                  {/* Badges Row */}
                  <View style={styles.badgesRow}>
                    <View style={[styles.badge, { backgroundColor: typeBadge.bg }]}>
                      <Text style={[styles.badgeText, { color: typeBadge.text }]}>
                        {typeBadge.label}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: statusBadge.bg }]}>
                      <Text style={[styles.badgeText, { color: statusBadge.text }]}>
                        {statusBadge.label}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: "#F0FDF4" }]}>
                      <Text style={[styles.badgeText, { color: "#16A34A" }]}>
                        {report.fmv}
                      </Text>
                    </View>
                    {report.isMergedReport ? (
                      <View style={[styles.badge, { backgroundColor: "#EFF6FF" }]}>
                        <Text style={[styles.badgeText, { color: "#2563EB" }]}>
                          Merged · {report.mergedSourceCount || 2}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  {/* Action Buttons */}
                  {(report.generationState === "queued" || report.generationState === "processing") ? (
                    <View style={styles.progressPanel}>
                      <View style={styles.progressHeadingRow}>
                        <Text style={styles.progressMessage} numberOfLines={1}>
                          {report.generationProgress?.message || "Processing report"}
                        </Text>
                        <Text style={styles.progressPercent}>
                          {Math.round(Number(report.generationProgress?.progressPercent || 0))}%
                        </Text>
                      </View>
                      <View style={styles.progressTrack}>
                        <View
                          style={[
                            styles.progressFill,
                            { width: `${Math.max(3, Math.min(100, Number(report.generationProgress?.progressPercent || 0)))}%` },
                          ]}
                        />
                      </View>
                      {report.generationProgress?.totalLots ? (
                        <Text style={styles.progressLotText}>
                          Lot {report.generationProgress.currentLot || 0} of {report.generationProgress.totalLots}
                        </Text>
                      ) : null}
                    </View>
                  ) : report.generationState === "error" && !hasFiles ? (
                    <View style={styles.pendingNote}>
                      <Feather name="alert-circle" size={14} color="#DC2626" />
                      <Text style={[styles.pendingNoteText, { color: "#DC2626" }]} numberOfLines={2}>
                        {report.jobError || "File generation failed."}
                      </Text>
                      <TouchableOpacity
                        onPress={async () => {
                          try {
                            if (report.type !== "Asset" && report.type !== "LotListing") {
                              Alert.alert(
                                "Retry unavailable",
                                "Open this report's preview to retry generation."
                              );
                              return;
                            }
                            await api.post(
                              report.type === "LotListing"
                                ? `/lot-listing/${report.id}/retry-processing`
                                : `/asset/${report.id}/retry-processing`,
                              {}
                            );
                            await fetchReports();
                          } catch (error: any) {
                            Alert.alert("Retry failed", error?.response?.data?.message || error?.message || "Unable to retry");
                          }
                        }}
                      >
                        <Text style={{ color: "#2563EB", fontWeight: "700" }}>Retry</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (report.status === "preview" || report.status === "declined") ? (
                    <TouchableOpacity
                      style={[styles.previewBtn, report.status === "declined" && styles.previewBtnDeclined]}
                      onPress={() => onOpenPreview?.(report.id, report.type)}
                    >
                      <Feather name="edit-3" size={16} color="#fff" />
                      <Text style={styles.previewBtnText}>
                        {report.status === "declined" ? "Edit & Resubmit" : "Preview & Submit"}
                      </Text>
                    </TouchableOpacity>
                  ) : hasFiles && report.status === "approved" && downloadable ? (
                    <View style={styles.downloadButtons}>
                      {report.type !== "LotListing" && (
                        <TouchableOpacity
                          style={[
                            styles.downloadBtn,
                            !report.files.pdf && styles.downloadBtnDisabled,
                          ]}
                          onPress={() =>
                            report.files.pdf &&
                            handleDownload(report.files.pdf, `${report.name}.pdf`, report.id)
                          }
                          disabled={!report.files.pdf || isDownloading}
                        >
                          <Feather name="file-text" size={14} color="#fff" />
                          <Text style={styles.downloadBtnText}>PDF</Text>
                        </TouchableOpacity>
                      )}

                      {(report.type === "Asset" || report.type === "LotListing") && (
                        <TouchableOpacity
                          style={[
                            styles.downloadBtn,
                            !report.files.conditionalReport && styles.downloadBtnDisabled,
                          ]}
                          onPress={() =>
                            report.files.conditionalReport &&
                            handleDownload(
                              report.files.conditionalReport,
                              `${report.name}-conditional-report.pdf`,
                              report.id
                            )
                          }
                          disabled={!report.files.conditionalReport || isDownloading}
                        >
                          <Feather name="file-text" size={14} color="#fff" />
                          <Text style={styles.downloadBtnText}>CR</Text>
                        </TouchableOpacity>
                      )}

                      {(report.type === "Asset" || report.type === "LotListing") && (
                        <TouchableOpacity
                          style={[
                            styles.downloadBtn,
                            !report.files.crDocx && styles.downloadBtnDisabled,
                          ]}
                          onPress={() =>
                            report.files.crDocx &&
                            handleDownload(report.files.crDocx, `${report.name}-CR.docx`, report.id)
                          }
                          disabled={!report.files.crDocx || isDownloading}
                        >
                          <Feather name="file" size={14} color="#fff" />
                          <Text style={styles.downloadBtnText}>CR DOCX</Text>
                        </TouchableOpacity>
                      )}

                      {/* DOCX button - only for Asset and RealEstate */}
                      {report.type !== "LotListing" && (
                        <TouchableOpacity
                          style={[
                            styles.downloadBtn,
                            !report.files.docx && styles.downloadBtnDisabled,
                          ]}
                          onPress={() =>
                            report.files.docx &&
                            handleDownload(report.files.docx, `${report.name}.docx`, report.id)
                          }
                          disabled={!report.files.docx || isDownloading}
                        >
                          <Feather name="file-text" size={14} color="#fff" />
                          <Text style={styles.downloadBtnText}>DOCX</Text>
                        </TouchableOpacity>
                      )}

                      <TouchableOpacity
                        style={[
                          styles.downloadBtn,
                          styles.downloadBtnExcel,
                          !report.files.excel && styles.downloadBtnDisabled,
                        ]}
                        onPress={() =>
                          report.files.excel &&
                          handleDownload(report.files.excel, `${report.name}.xlsx`, report.id)
                        }
                        disabled={!report.files.excel || isDownloading}
                      >
                        <Feather name="grid" size={14} color="#fff" />
                        <Text style={styles.downloadBtnText}>Excel</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.downloadBtn,
                          styles.downloadBtnZip,
                          !report.files.images && styles.downloadBtnDisabled,
                        ]}
                        onPress={() =>
                          report.files.images &&
                          handleZipPress(report.files.images, report.name)
                        }
                        disabled={!report.files.images || isDownloading}
                      >
                        <Feather name="image" size={14} color="#fff" />
                        <Text style={styles.downloadBtnText}>Images</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.pendingNote}>
                      <Feather name="clock" size={14} color="#9CA3AF" />
                      <Text style={styles.pendingNoteText}>
                        {!downloadable && report.status === "approved"
                          ? "Files available after release"
                          : hasFiles && report.type !== "LotListing"
                          ? "Awaiting approval for download"
                          : "Files generating..."}
                      </Text>
                    </View>
                  )}
                  {report.type === "Asset" && report.generationState !== "queued" && report.generationState !== "processing" ? (
                    <TouchableOpacity style={styles.mergeAssetBtn} onPress={() => setMergeAnchorId(report.id)}>
                      <Feather name="git-merge" size={15} color="#2563EB" />
                      <Text style={styles.mergeAssetText}>Merge Asset Reports</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
        </View>
      </ScrollView>

      <AssetMergeSheet
        visible={Boolean(mergeAnchorId)}
        anchorReportId={mergeAnchorId}
        onClose={() => setMergeAnchorId(null)}
        onCreated={(result) => {
          setMergeAnchorId(null);
          void fetchReports();
          onMergeCreated?.(result.reportId);
        }}
      />

      {/* ZIP Options Modal */}
      <Modal
        visible={zipModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setZipModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.modalIconContainer}>
                <Feather name="archive" size={24} color="#2563EB" />
              </View>
              <Text style={styles.modalTitle}>Download Images</Text>
              <Text style={styles.modalSubtitle}>{selectedZipName}</Text>
            </View>

            {extracting ? (
              <View style={styles.extractingContainer}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.extractingText}>Downloading & extracting...</Text>
              </View>
            ) : (
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalBtn}
                  onPress={handleDownloadZipOnly}
                >
                  <Feather name="download" size={20} color="#2563EB" />
                  <View style={styles.modalBtnTextContainer}>
                    <Text style={styles.modalBtnTitle}>Download ZIP</Text>
                    <Text style={styles.modalBtnDesc}>Save as compressed file</Text>
                  </View>
                  <Feather name="chevron-right" size={20} color="#9CA3AF" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.modalBtn}
                  onPress={handleDownloadAndExtract}
                >
                  <Feather name="image" size={20} color="#059669" />
                  <View style={styles.modalBtnTextContainer}>
                    <Text style={styles.modalBtnTitle}>Download & Extract</Text>
                    <Text style={styles.modalBtnDesc}>Save images to gallery</Text>
                  </View>
                  <Feather name="chevron-right" size={20} color="#9CA3AF" />
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={styles.modalCancelBtn}
              onPress={() => setZipModalVisible(false)}
              disabled={extracting}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
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
    paddingBottom: 32,
  },
  // Hero Card - Red Theme (matching SavedInputsScreen)
  heroCard: {
    backgroundColor: "#F43F5E",
    borderRadius: 24,
    marginBottom: 20,
    overflow: "hidden",
    shadowColor: "#F43F5E",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
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
    marginBottom: 16,
  },
  heroLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  heroActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  heroTitleSection: {
    flex: 1,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.85)",
    marginTop: 2,
  },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerIconDisabled: {
    opacity: 0.65,
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
    borderColor: "#F43F5E",
  },
  notifBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    textAlign: "center",
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  // Search inside hero
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: "#fff",
    paddingVertical: 2,
  },
  searchClear: {
    padding: 4,
  },
  // Tabs inside hero
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 6,
  },
  tabActive: {
    backgroundColor: "#fff",
  },
  tabText: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(255, 255, 255, 0.85)",
  },
  tabTextActive: {
    color: "#F43F5E",
  },
  // Content Section
  contentSection: {
    flex: 1,
  },
  loadingContainer: {
    paddingVertical: 60,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyState: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 36,
    alignItems: "center",
    marginTop: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.04)",
  },
  emptyText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#374151",
    marginTop: 14,
  },
  emptySubtext: {
    fontSize: 14,
    color: "#9CA3AF",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },
  reportsList: {
    gap: 12,
  },
  reportCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.04)",
  },
  reportHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  reportIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#EFF6FF",
    justifyContent: "center",
    alignItems: "center",
  },
  reportInfo: {
    flex: 1,
    marginLeft: 12,
  },
  reportName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1F2937",
  },
  reportDate: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: 2,
  },
  badgesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  downloadButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  mergeAssetBtn: {
    marginTop: 10,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#BFDBFE",
    backgroundColor: "#EFF6FF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mergeAssetText: { color: "#2563EB", fontSize: 13, fontWeight: "800" },
  progressPanel: {
    backgroundColor: "#EFF6FF",
    borderRadius: 10,
    padding: 12,
  },
  progressHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  progressMessage: { flex: 1, color: "#1D4ED8", fontSize: 13, fontWeight: "700" },
  progressPercent: { color: "#1D4ED8", fontSize: 12, fontWeight: "800" },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: "#BFDBFE", overflow: "hidden", marginTop: 9 },
  progressFill: { height: "100%", backgroundColor: "#2563EB" },
  progressLotText: { marginTop: 7, color: "#64748B", fontSize: 11, fontWeight: "600" },
  downloadBtn: {
    flexGrow: 1,
    flexBasis: "47%",
    minWidth: 132,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563EB",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    gap: 6,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  downloadBtnExcel: {
    backgroundColor: "#059669",
    shadowColor: "#059669",
  },
  downloadBtnZip: {
    backgroundColor: "#7C3AED",
    shadowColor: "#7C3AED",
  },
  downloadBtnDisabled: {
    backgroundColor: "#D1D5DB",
    shadowOpacity: 0,
    elevation: 0,
  },
  downloadBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
  pendingNote: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    backgroundColor: "#F9FAFB",
    borderRadius: 10,
  },
  pendingNoteText: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  previewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563EB",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    gap: 8,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  previewBtnDeclined: {
    backgroundColor: "#DC2626",
    shadowColor: "#DC2626",
  },
  previewBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 24,
    width: "100%",
    maxWidth: 340,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 15,
  },
  modalHeader: {
    alignItems: "center",
    marginBottom: 20,
  },
  modalIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "#EFF6FF",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#1F2937",
  },
  modalSubtitle: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
    textAlign: "center",
  },
  extractingContainer: {
    alignItems: "center",
    paddingVertical: 30,
  },
  extractingText: {
    fontSize: 14,
    color: "#6B7280",
    marginTop: 12,
  },
  modalButtons: {
    gap: 10,
  },
  modalBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    padding: 14,
    borderRadius: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  modalBtnTextContainer: {
    flex: 1,
  },
  modalBtnTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1F2937",
  },
  modalBtnDesc: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: 2,
  },
  modalCancelBtn: {
    alignItems: "center",
    paddingVertical: 14,
    marginTop: 12,
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#6B7280",
  },
});

export default ReportsScreen;
