import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import api from '../services/api';
import { assetService } from '../services/assetService';
import AssetMergeSheet from '../components/AssetMergeSheet';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import salvageService from '../services/salvageService';
import { salvageDisplayText } from '../utils/salvageDisplayText';
import { downloadApprovedReportFile } from '../services/reportDownloadTransport';
import { useAuth } from '../context/AuthContext';
import { captureAuthOperation, getAuthOperationEpoch } from '../services/authSessionOperation';
import { deliveryMatchesReport } from '../services/auctioneerDeliveryService';
import AuctioneerDeliveryAction from '../components/auction/AuctioneerDeliveryAction';
import useReportDeliveries from '../components/auction/useReportDeliveries';

// Expo SDK 54 keeps downloadAsync in the legacy file-system surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FileSystem = require('expo-file-system/legacy');

type PreviewReportType = 'Asset' | 'RealEstate' | 'LotListing' | 'Salvage';
type ReportType = PreviewReportType;
type ReportTab = 'all' | 'pending' | 'approved';

type ReportFileKey = 'pdf' | 'conditionalReport' | 'crDocx' | 'docx' | 'excel' | 'images';

type ReportItem = {
  id: string;
  name: string;
  contract: string;
  type: ReportType;
  status: string;
  fmv: string;
  createdAt: string;
  lotCount: number;
  lotSummary: string;
  thumbnail?: string;
  releaseStatus?: 'pending_release' | 'released';
  downloadable: boolean;
  generationState?: 'queued' | 'processing' | 'ready' | 'error' | 'cancelled';
  workflowStage?: string;
  workflowMessage?: string;
  workflowProgressPercent?: number;
  jobError?: string;
  generationProgress?: {
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
  };
  files: Partial<Record<ReportFileKey, string>>;
  isMergedReport?: boolean;
  mergedSourceCount?: number;
};

interface ReportsScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  onOpenPreview?: (reportId: string, reportType: PreviewReportType) => void;
  onMergeCreated?: (reportId: string) => void;
}

const sanitizeFilename = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');

const summarizeLots = (lots: any[], reportId: string) => {
  const numbers = (Array.isArray(lots) ? lots : [])
    .map((lot) => String(lot?.lot_number ?? '').trim())
    .filter(Boolean);
  if (numbers.length === 0) return `#${reportId.slice(-6)}`;
  const visible = numbers.slice(0, 3).map((value) => `Lot ${value}`).join(', ');
  return numbers.length > 3 ? `${visible} +${numbers.length - 3}` : visible;
};

const firstLotImage = (lots: any[], globalUrls: string[] = []): string | undefined => {
  for (const lot of Array.isArray(lots) ? lots : []) {
    const direct = lot?.image_url || lot?.image_urls?.[0] || lot?.extra_image_urls?.[0];
    if (direct) return String(direct);
    const index = lot?.image_indexes?.[0];
    if (Number.isInteger(index) && globalUrls[index]) return globalUrls[index];
  }
  return globalUrls[0];
};

const formatMoney = (value: number, currency: string) => {
  if (!Number.isFinite(value) || value <= 0) return `${currency} -`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
};

const getStatus = (report: ReportItem, colors: AppThemeColors) => {
  const workflowStatuses: Record<string, { label: string; text: string; bg: string; icon: keyof typeof Feather.glyphMap }> = {
    preparing_preview: { label: 'Preparing preview', text: colors.info, bg: colors.infoSoft, icon: 'loader' },
    preview_ready: { label: 'Preview ready', text: colors.info, bg: colors.infoSoft, icon: 'eye' },
    generating_files: { label: 'Generating files', text: colors.info, bg: colors.infoSoft, icon: 'loader' },
    awaiting_approval: { label: 'Awaiting approval', text: colors.warning, bg: colors.warningSoft, icon: 'clock' },
    awaiting_release: { label: 'Awaiting release', text: colors.warning, bg: colors.warningSoft, icon: 'clock' },
    ready: { label: 'Ready to download', text: colors.success, bg: colors.successSoft, icon: 'check-circle' },
    error: { label: 'Generation failed', text: colors.danger, bg: colors.dangerSoft, icon: 'alert-circle' },
    stopped: { label: 'Processing stopped', text: colors.warning, bg: colors.warningSoft, icon: 'pause-circle' },
  };
  if (report.workflowStage && workflowStatuses[report.workflowStage]) {
    return workflowStatuses[report.workflowStage];
  }
  if (report.status === 'processing') {
    return { label: 'Preparing preview', text: colors.info, bg: colors.infoSoft, icon: 'loader' as const };
  }
  if (report.status === 'preview') {
    return { label: 'Preview ready', text: colors.info, bg: colors.infoSoft, icon: 'eye' as const };
  }
  if (report.status === 'declined') {
    return { label: 'Changes required', text: colors.danger, bg: colors.dangerSoft, icon: 'x-circle' as const };
  }
  if (report.generationState === 'error') {
    return { label: 'Generation failed', text: colors.danger, bg: colors.dangerSoft, icon: 'alert-circle' as const };
  }
  if (report.generationState === 'queued' || report.generationState === 'processing') {
    return { label: 'Generating files', text: colors.info, bg: colors.infoSoft, icon: 'loader' as const };
  }
  if (report.status === 'approved' && report.releaseStatus === 'pending_release') {
    return { label: 'Awaiting release', text: colors.warning, bg: colors.warningSoft, icon: 'clock' as const };
  }
  if (report.status === 'approved') {
    return { label: 'Released', text: colors.success, bg: colors.successSoft, icon: 'check-circle' as const };
  }
  return { label: 'Pending', text: colors.warning, bg: colors.warningSoft, icon: 'clock' as const };
};

const ReportsScreenModern = ({
  onOpenDrawer,
  onBack,
  unreadCount = 0,
  onOpenNotifications,
  onOpenPreview,
  onMergeCreated,
  owner,
}: ReportsScreenProps & { owner: string }) => {
  const { width } = useWindowDimensions();
  const isTablet = width >= 760;
  const { isDark, colors, toggleTheme } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, isTablet), [colors, isTablet]);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [activeTab, setActiveTab] = useState<ReportTab>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [mergeAnchorId, setMergeAnchorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    deliveries,
    error: deliveryError,
    checking: deliveryChecking,
    refresh: refreshDeliveries,
    updated: updateDelivery,
  } = useReportDeliveries(owner);
  const mounted = useRef(false);
  const reportsRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reportsRevision.current += 1; };
  }, []);

  const fetchReports = useCallback(async () => {
    if (!owner) return;
    const request = ++reportsRevision.current;
    const assertSession = captureAuthOperation();
    const current = () => {
      try { assertSession(); } catch { return false; }
      return mounted.current && request === reportsRevision.current;
    };
    try {
      setLoadError(null);
      const [assetReports, realEstateResponse, lotListingResponse, salvageReports] = await Promise.all([
        assetService.getAssetReports(),
        api.get('/real-estate').catch(() => ({ data: { data: [] } })),
        api.get('/lot-listing').catch(() => ({ data: { data: [] } })),
        salvageService.list(),
      ]);
      if (!current()) return;
      const next: ReportItem[] = [];
      const visibleStatuses = ['approved', 'pending_approval', 'preview', 'declined', 'processing', 'error'];

      for (const report of assetReports) {
        if (!visibleStatuses.includes(report.status)) continue;
        const previewData: any = report.preview_data || {};
        const lots = Array.isArray(previewData.lots) ? previewData.lots : [];
        const total = lots.reduce((sum: number, lot: any) => {
          const lotValue = Number.parseFloat(
            String(lot?.estimated_value || '').replace(/[^0-9.-]+/g, '')
          );
          const itemValue = Array.isArray(lot?.items)
            ? lot.items.reduce((itemSum: number, item: any) => {
                const parsed = Number.parseFloat(
                  String(item?.estimated_value || '').replace(/[^0-9.-]+/g, '')
                );
                return itemSum + (Number.isFinite(parsed) ? parsed : 0);
              }, 0)
            : 0;
          return sum + Math.max(Number.isFinite(lotValue) ? lotValue : 0, itemValue);
        }, 0);
        const contract = String(previewData.contract_no || (report as any).contract_no || '').trim();
        next.push({
          id: report._id,
          name: previewData.client_name || contract || 'Asset Report',
          contract,
          type: 'Asset',
          status: report.status,
          fmv: formatMoney(total, previewData.currency || 'CAD'),
          createdAt: report.createdAt,
          lotCount: lots.length,
          lotSummary: summarizeLots(lots, report._id),
          thumbnail: firstLotImage(lots, Array.isArray(previewData.image_urls) ? previewData.image_urls : []),
          releaseStatus: report.release_status,
          downloadable: report.downloadable !== false,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          jobError: report.job_error,
          generationProgress: report.generation_progress,
          files: {
            pdf: report.preview_files?.pdf,
            conditionalReport: report.preview_files?.spec_pdf,
            crDocx: report.preview_files?.cr_docx,
            docx: report.preview_files?.docx,
            excel: report.preview_files?.excel,
            images: report.preview_files?.images,
          },
          isMergedReport: report.is_merged_report === true,
          mergedSourceCount: Array.isArray(report.merged_from_report_ids)
            ? report.merged_from_report_ids.length
            : 0,
        });
      }

      for (const report of realEstateResponse.data?.data || []) {
        if (!visibleStatuses.includes(report.status)) continue;
        const previewData = report.preview_data || {};
        const address = report.property_details?.address || previewData.property_details?.address || 'Real Estate Report';
        next.push({
          id: report._id,
          name: address,
          contract: String(report.contract_no || '').trim(),
          type: 'RealEstate',
          status: report.status,
          fmv: String(previewData.valuation?.fair_market_value || 'CAD -'),
          createdAt: report.createdAt,
          lotCount: 1,
          lotSummary: 'Property',
          thumbnail: report.imageUrls?.[0] || previewData.imageUrls?.[0] || previewData.image_urls?.[0] || report.image_urls?.[0],
          releaseStatus: report.release_status,
          downloadable: report.downloadable !== false,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          jobError: report.job_error,
          generationProgress: report.generation_progress,
          files: {
            pdf: report.preview_files?.pdf,
            docx: report.preview_files?.docx,
            excel: report.preview_files?.excel,
            images: report.preview_files?.images,
          },
        });
      }

      for (const report of lotListingResponse.data?.data || []) {
        if (!visibleStatuses.includes(report.status)) continue;
        const previewData = report.preview_data || {};
        const lots = previewData.lots || report.lots || [];
        const contract = String(previewData.contract_no || report.contract_no || '').trim();
        next.push({
          id: report._id,
          name: contract || 'Lot Listing',
          contract,
          type: 'LotListing',
          status: report.status,
          fmv: `${lots.length} ${lots.length === 1 ? 'lot' : 'lots'}`,
          createdAt: report.createdAt,
          lotCount: lots.length,
          lotSummary: summarizeLots(lots, report._id),
          thumbnail: firstLotImage(lots, Array.isArray(previewData.image_urls) ? previewData.image_urls : []),
          releaseStatus: report.release_status,
          downloadable: report.downloadable !== false,
          generationState: report.generation_state,
          workflowStage: report.workflow_stage,
          workflowMessage: report.workflow_message,
          workflowProgressPercent: report.workflow_progress_percent,
          jobError: report.job_error,
          generationProgress: report.generation_progress,
          files: {
            conditionalReport: report.preview_files?.spec_pdf || report.files?.spec_pdf,
            crDocx: report.preview_files?.cr_docx || report.files?.cr_docx,
            excel: report.preview_files?.excel || report.files?.excel,
            images: report.preview_files?.images || report.files?.images,
          },
        });
      }

      for (const report of salvageReports) {
        next.push({ id: report._id, name: report.file_number || 'Salvage report', type: 'Salvage',
          status: report.status, contract: report.file_number || '', lotCount: 1, lotSummary: 'Salvage appraisal',
          createdAt: report.createdAt || '', fmv: formatMoney(Number(report.preview_data?.actual_cash_value || 0), report.currency || 'CAD'),
          thumbnail: report.imageUrls?.[0], downloadable: report.downloadable === true,
          generationState: report.generation_state, workflowStage: report.workflow_stage,
          workflowMessage: salvageDisplayText(report.workflow_message), workflowProgressPercent: report.workflow_progress_percent,
          jobError: salvageDisplayText(report.job_error),
          files: report.downloadable ? { pdf: report.files?.pdf, docx: report.files?.docx, excel: report.files?.xlsx, images: report.files?.images } : {},
        });
      }

      next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setReports(next);
    } catch {
      if (!current()) return;
      setLoadError('Reports could not be loaded. Check your connection and try again.');
    } finally {
      if (current()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [owner]);

  useEffect(() => {
    void fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    const active = reports.some(
      (report) =>
        report.workflowStage === 'preparing_preview' ||
        report.workflowStage === 'generating_files' ||
        report.status === 'processing' ||
        report.generationState === 'queued' ||
        report.generationState === 'processing'
    );
    if (!active) return;
    const timer = setInterval(() => void fetchReports(), 10_000);
    return () => clearInterval(timer);
  }, [fetchReports, reports]);

  const visibleReports = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return reports.filter((report) => {
      if (activeTab === 'pending' && ['approved'].includes(report.status)) return false;
      if (activeTab === 'approved' && report.status !== 'approved') return false;
      if (!normalizedQuery) return true;
      return [report.name, report.contract, report.lotSummary, report.id]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
    });
  }, [activeTab, query, reports]);

  const summary = useMemo(
    () => ({
      total: reports.length,
      pending: reports.filter((report) => report.status !== 'approved').length,
      approved: reports.filter((report) => report.status === 'approved').length,
    }),
    [reports]
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void fetchReports();
    void refreshDeliveries();
  }, [fetchReports, refreshDeliveries]);

  const download = useCallback(async (url: string, filename: string, reportId: string, protectedFile = false) => {
    const documentDirectory = FileSystem.documentDirectory as string | null;
    if (!documentDirectory) {
      Alert.alert('Storage unavailable', 'The app cannot access its download directory.');
      return;
    }
    setDownloadingId(reportId);
    try {
      const path = `${documentDirectory}${Date.now()}_${sanitizeFilename(filename)}`;
      const result = protectedFile
        ? await downloadApprovedReportFile(url, path)
        : await FileSystem.downloadAsync(url, path);
      if (result.status < 200 || result.status >= 300) throw new Error(`Server returned ${result.status}`);
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
      await Sharing.shareAsync(result.uri, { dialogTitle: `Save ${filename}` });
      setTimeout(() => void FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined), 10_000);
    } catch (error: any) {
      Alert.alert('Download failed', error?.message || 'Please try again.');
    } finally {
      setDownloadingId(null);
    }
  }, []);

  const renderFileButton = useCallback(
    (
      report: ReportItem,
      key: ReportFileKey,
      label: string,
      icon: keyof typeof Feather.glyphMap,
      extension: string,
      filenameLabel = label
    ) => {
      const url = report.files[key];
      if (!url) return null;
      return (
        <TouchableOpacity
          key={key}
          style={styles.fileButton}
          activeOpacity={0.72}
          disabled={downloadingId === report.id}
          onPress={() =>
            void download(
              url,
              `${report.contract || report.name}-${filenameLabel}.${extension}`,
              report.id,
              report.type === 'Salvage'
            )
          }>
          {downloadingId === report.id ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <Feather name={icon} size={15} color={colors.text} />
          )}
          <Text style={styles.fileButtonText}>{label}</Text>
        </TouchableOpacity>
      );
    },
    [colors.text, download, downloadingId, styles]
  );

  const renderReport = useCallback(
    ({ item: report }: { item: ReportItem }) => {
      const status = getStatus(report, colors);
      const isPreparingPreview = report.workflowStage === 'preparing_preview' || report.status === 'processing';
      const isActive =
        report.workflowStage === 'generating_files' ||
        isPreparingPreview ||
        report.generationState === 'queued' ||
        report.generationState === 'processing';
      const hasFiles = Object.values(report.files).some(Boolean);
      const progress = Math.max(0, Math.min(100, Number(
        report.workflowProgressPercent ?? report.generationProgress?.progressPercent ?? 0
      )));
      // Never infer destination ownership from a shared contract number/name.
      const linked = report.type === 'Asset' || report.type === 'LotListing'
        ? deliveries.filter((row) => deliveryMatchesReport(
          row, report.id, report.type === 'Asset' ? 'AssetReport' : 'LotListing'
        )) : [];
      return (
        <View style={styles.reportCard}>
          <View style={styles.reportTopRow}>
            {report.thumbnail ? (
              <Image source={{ uri: report.thumbnail }} style={styles.thumbnail} resizeMode="cover" />
            ) : (
              <View style={styles.thumbnailFallback}>
                <Feather
                  name={report.type === 'Asset' ? 'package' : report.type === 'LotListing' ? 'list' : report.type === 'Salvage' ? 'truck' : 'home'}
                  size={23}
                  color={colors.textMuted}
                />
              </View>
            )}
            <View style={styles.reportIdentity}>
              <Text style={styles.reportName} numberOfLines={2}>
                {report.type === 'LotListing' ? 'Lot Listing' : report.type === 'RealEstate' ? 'Real Estate' : report.type}
                {report.contract ? ` - ${report.contract}` : ''}
              </Text>
              <Text style={styles.reportClient} numberOfLines={1}>{report.name}</Text>
              <Text style={styles.reportLots} numberOfLines={1}>{report.lotSummary}</Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
              <Feather name={status.icon} size={12} color={status.text} />
              <Text style={[styles.statusText, { color: status.text }]}>{status.label}</Text>
            </View>
          </View>

          <View style={styles.reportMetaRow}>
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>LOTS / VALUE</Text>
              <Text style={styles.metaValue}>{report.lotCount || 1} / {report.fmv}</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>CREATED</Text>
              <Text style={styles.metaValue}>
                {new Date(report.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>TYPE</Text>
              <Text style={styles.metaValue}>{report.type === 'LotListing' ? 'Lot Listing' : report.type}</Text>
            </View>
          </View>

          {isActive ? (
            <View style={styles.progressPanel}>
              <View style={styles.progressRow}>
                <Text style={styles.progressMessage} numberOfLines={1}>
                  {report.workflowMessage || report.generationProgress?.message ||
                    (isPreparingPreview
                      ? 'Analyzing images and preparing your first preview'
                      : 'Generating report files')}
                </Text>
                <Text style={styles.progressPercent}>{Math.round(progress)}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(3, progress)}%` }]} />
              </View>
            </View>
          ) : (report.workflowStage === 'error' || report.generationState === 'error') && !hasFiles && report.status !== 'preview' ? (
            <View style={styles.errorPanel}>
              <Feather name="alert-triangle" size={16} color={colors.danger} />
              <Text style={styles.errorText}>{report.jobError || 'File generation failed.'}</Text>
            </View>
          ) : null}

          {(report.status === 'preview' || report.status === 'declined' || (report.type === 'Salvage' && !report.downloadable)) ? (
            <TouchableOpacity
              style={styles.reviewButton}
              activeOpacity={0.75}
              onPress={() => {
                onOpenPreview?.(report.id, report.type);
              }}>
              <Feather name="edit-3" size={16} color="#FFFFFF" />
              <Text style={styles.reviewButtonText}>
                {report.type === 'Salvage' ? 'Open report & progress' : report.status === 'declined' ? 'Edit & resubmit' : 'Preview & submit'}
              </Text>
            </TouchableOpacity>
          ) : report.status === 'approved' && report.downloadable && hasFiles ? (
            <View style={styles.filesSection}>
              <Text style={styles.sectionLabel}>FILES</Text>
              <View style={styles.fileButtons}>
                {renderFileButton(
                  report,
                  'pdf',
                  report.type === 'Asset' ? 'Schedule A' : 'PDF',
                  'file-text',
                  'pdf',
                  'PDF'
                )}
                {renderFileButton(report, 'conditionalReport', 'CR', 'file', 'pdf')}
                {renderFileButton(report, 'crDocx', 'CR DOCX', 'file-plus', 'docx')}
                {renderFileButton(
                  report,
                  'docx',
                  report.type === 'Asset' || report.type === 'RealEstate'
                    ? 'Appraisal report'
                    : 'DOCX',
                  'file-text',
                  'docx',
                  'DOCX'
                )}
                {renderFileButton(report, 'excel', 'Excel', 'grid', 'xlsx')}
                {renderFileButton(report, 'images', 'Images', 'image', 'zip')}
              </View>
            </View>
          ) : (
            <View style={styles.waitingPanel}>
              <Feather name="lock" size={15} color={colors.textMuted} />
              <Text style={styles.waitingText}>
                {report.type === 'Salvage' && report.status === 'declined'
                  ? 'Changes were requested. Contact your assigned approver for the required corrections.'
                  : report.type === 'Salvage' && report.status !== 'approved'
                    ? 'Your salvage report is awaiting approval.'
                    : report.status === 'approved' && !report.downloadable
                  ? 'Files are ready and awaiting release.'
                  : report.workflowStage === 'awaiting_approval'
                    ? 'Files are ready and awaiting approval.'
                    : report.workflowStage === 'preview_ready'
                      ? 'Preview ready. Open Previews to review and submit.'
                      : 'Files are being prepared.'}
              </Text>
            </View>
          )}

          {linked.length === 1 ? (
            <AuctioneerDeliveryAction
              key={linked[0].workItemId}
              delivery={linked[0]}
              onUpdated={updateDelivery}
            />
          ) : linked.length > 1 ? (
            <Text style={styles.errorText}>This report has conflicting auction delivery links. Contact your administrator before sending.</Text>
          ) : null}

          {report.type === 'Asset' && !isActive ? (
            <TouchableOpacity
              style={styles.mergeButton}
              activeOpacity={0.75}
              onPress={() => setMergeAnchorId(report.id)}>
              <Feather name="git-merge" size={15} color={colors.info} />
              <Text style={styles.mergeButtonText}>Merge same-contract Asset reports</Text>
              <Feather name="chevron-right" size={16} color={colors.info} />
            </TouchableOpacity>
          ) : null}
        </View>
      );
    },
    [colors, onOpenPreview, renderFileButton, styles, deliveries, updateDelivery]
  );

  const header = (
    <>
      <View style={styles.commandHeader}>
        <View style={styles.headerToolbar}>
          <TouchableOpacity onPress={onOpenDrawer} style={styles.headerIcon} activeOpacity={0.72}>
            <Feather name="menu" size={21} color="#FFFFFF" />
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>My Reports</Text>
            <Text style={styles.headerSubtitle}>Status, files, and report history</Text>
          </View>
          <TouchableOpacity onPress={toggleTheme} style={styles.headerIcon} activeOpacity={0.72}>
            <Feather name={isDark ? 'sun' : 'moon'} size={18} color="#FFFFFF" />
          </TouchableOpacity>
          {onOpenNotifications ? (
            <TouchableOpacity onPress={onOpenNotifications} style={styles.headerIcon} activeOpacity={0.72}>
              <Feather name="bell" size={18} color="#FFFFFF" />
              {unreadCount > 0 ? <View style={styles.notificationDot} /> : null}
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.summaryBar}>
          <View style={styles.summaryItem}><Text style={styles.summaryValue}>{summary.total}</Text><Text style={styles.summaryLabel}>Total</Text></View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}><Text style={styles.summaryValue}>{summary.pending}</Text><Text style={styles.summaryLabel}>In progress</Text></View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}><Text style={styles.summaryValue}>{summary.approved}</Text><Text style={styles.summaryLabel}>Released</Text></View>
        </View>
      </View>

      <View style={styles.utilityRow}>
        <TouchableOpacity onPress={onBack} style={styles.backButton} activeOpacity={0.72}>
          <Feather name="arrow-left" size={16} color={colors.textSecondary} />
          <Text style={styles.backText}>Dashboard</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={refresh} style={styles.refreshButton} activeOpacity={0.72}>
          {refreshing ? <ActivityIndicator size="small" color={colors.accent} /> : <Feather name="refresh-cw" size={16} color={colors.textSecondary} />}
        </TouchableOpacity>
      </View>

      <View style={styles.filterSurface}>
        <View style={styles.searchRow}>
          <Feather name="search" size={17} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search reports, contracts, or lots"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query ? (
            <TouchableOpacity onPress={() => setQuery('')} style={styles.clearSearch}>
              <Feather name="x" size={15} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.tabs}>
          {(['all', 'pending', 'approved'] as ReportTab[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              activeOpacity={0.75}
              onPress={() => setActiveTab(tab)}>
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'all' ? 'All' : tab === 'pending' ? 'In progress' : 'Released'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {loadError ? (
        <View style={styles.loadError}>
          <Feather name="wifi-off" size={16} color={colors.danger} />
          <Text style={styles.loadErrorText}>{loadError}</Text>
          <TouchableOpacity onPress={refresh}><Text style={styles.retryText}>Retry</Text></TouchableOpacity>
        </View>
      ) : null}
      {deliveryError ? (
        <View style={styles.loadError}>
          <Text style={styles.loadErrorText}>Auction delivery status could not be checked. Your reports are unchanged.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Retry auction delivery status"
            disabled={deliveryChecking}
            onPress={() => void refreshDeliveries()}>
            <Text style={styles.retryText}>{deliveryChecking ? 'Checking…' : 'Retry'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {loading ? (
        <View style={styles.loadingScreen}>
          {header}
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.loadingText}>Loading reports...</Text>
          </View>
        </View>
      ) : (
        <FlatList
          key={isTablet ? 'tablet-reports' : 'phone-reports'}
          data={visibleReports}
          renderItem={renderReport}
          keyExtractor={(item) => `${item.type}:${item.id}`}
          numColumns={isTablet ? 2 : 1}
          columnWrapperStyle={isTablet ? styles.columnWrapper : undefined}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}><Feather name="file-text" size={25} color={colors.textMuted} /></View>
              <Text style={styles.emptyTitle}>No matching reports</Text>
              <Text style={styles.emptySubtitle}>Try another search or refresh your report history.</Text>
            </View>
          }
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface} />
          }
        />
      )}

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
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors, isTablet: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    loadingScreen: { flex: 1, paddingHorizontal: 14, paddingTop: 12 },
    listContent: { paddingHorizontal: isTablet ? 24 : 14, paddingTop: 12, paddingBottom: 34, maxWidth: 1120, width: '100%', alignSelf: 'center' },
    commandHeader: { backgroundColor: colors.graphite, borderRadius: 12, padding: isTablet ? 20 : 15, marginBottom: 12, borderBottomWidth: 4, borderBottomColor: colors.accent, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.24, shadowRadius: 16, elevation: 10 },
    headerToolbar: { flexDirection: 'row', alignItems: 'center' },
    headerIcon: { width: 39, height: 39, borderRadius: 9, backgroundColor: colors.graphiteSoft, borderWidth: 1, borderColor: '#353B45', alignItems: 'center', justifyContent: 'center', marginLeft: 7 },
    headerCopy: { flex: 1, minWidth: 0, marginLeft: 12 },
    headerTitle: { color: '#FFFFFF', fontSize: 21, fontWeight: '900' },
    headerSubtitle: { color: '#AEB7C4', fontSize: 11.5, marginTop: 2 },
    notificationDot: { position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
    summaryBar: { marginTop: 18, minHeight: 62, flexDirection: 'row', alignItems: 'center', backgroundColor: '#0B0D10', borderRadius: 9, borderWidth: 1, borderColor: '#2A3038' },
    summaryItem: { flex: 1, alignItems: 'center' },
    summaryValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
    summaryLabel: { color: '#96A1B1', fontSize: 9.5, fontWeight: '700', marginTop: 2 },
    summaryDivider: { width: 1, height: 30, backgroundColor: '#303640' },
    utilityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    backButton: { height: 38, paddingHorizontal: 11, borderRadius: 9, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    backText: { color: colors.textSecondary, fontSize: 12, fontWeight: '800' },
    refreshButton: { width: 38, height: 38, borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
    filterSurface: { backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 13 },
    searchRow: { height: 43, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceRaised, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11 },
    searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 12.5, paddingHorizontal: 8, paddingVertical: 0 },
    clearSearch: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
    tabs: { flexDirection: 'row', marginTop: 9, padding: 3, borderRadius: 8, backgroundColor: colors.surfaceMuted },
    tab: { flex: 1, minHeight: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    tabActive: { backgroundColor: colors.accent },
    tabText: { color: colors.textMuted, fontSize: 11, fontWeight: '800' },
    tabTextActive: { color: '#FFFFFF' },
    loadError: { minHeight: 52, padding: 10, marginBottom: 12, borderRadius: 8, backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger, flexDirection: 'row', alignItems: 'center', gap: 8 },
    loadErrorText: { flex: 1, color: colors.danger, fontSize: 11.5, lineHeight: 16 },
    retryText: { color: colors.danger, fontSize: 11, fontWeight: '900' },
    columnWrapper: { gap: 12 },
    reportCard: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceRaised, borderRadius: 11, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 12, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 4 },
    reportTopRow: { flexDirection: 'row', alignItems: 'center' },
    thumbnail: { width: 64, height: 64, borderRadius: 8, backgroundColor: colors.surfaceMuted, marginRight: 10 },
    thumbnailFallback: { width: 64, height: 64, borderRadius: 8, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    reportIdentity: { flex: 1, minWidth: 0, paddingRight: 7 },
    reportName: { color: colors.text, fontSize: 13.5, lineHeight: 18, fontWeight: '900' },
    reportClient: { color: colors.textSecondary, fontSize: 10.5, marginTop: 3 },
    reportLots: { color: colors.textMuted, fontSize: 9.5, marginTop: 2 },
    statusBadge: { maxWidth: 104, minHeight: 28, paddingHorizontal: 7, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
    statusText: { fontSize: 9, fontWeight: '900', flexShrink: 1 },
    reportMetaRow: { flexDirection: 'row', marginTop: 12, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.surfaceMuted },
    metaBlock: { flex: 1, minWidth: 0 },
    metaLabel: { color: colors.textMuted, fontSize: 7.5, fontWeight: '900' },
    metaValue: { color: colors.textSecondary, fontSize: 9.5, fontWeight: '800', marginTop: 2 },
    metaDivider: { width: 1, height: 25, marginHorizontal: 7, backgroundColor: colors.borderStrong },
    progressPanel: { backgroundColor: colors.infoSoft, borderRadius: 8, padding: 10, marginTop: 10 },
    progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    progressMessage: { flex: 1, color: colors.info, fontSize: 10.5, fontWeight: '800' },
    progressPercent: { color: colors.info, fontSize: 10.5, fontWeight: '900' },
    progressTrack: { height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, marginTop: 8, overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.info },
    errorPanel: { flexDirection: 'row', gap: 8, padding: 10, marginTop: 10, borderRadius: 8, backgroundColor: colors.dangerSoft },
    errorText: { flex: 1, color: colors.danger, fontSize: 10.5, lineHeight: 15 },
    reviewButton: { height: 42, borderRadius: 9, marginTop: 11, backgroundColor: colors.accent, borderBottomWidth: 3, borderBottomColor: colors.accentPressed, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    reviewButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
    filesSection: { marginTop: 11 },
    sectionLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', marginBottom: 6 },
    fileButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    fileButton: { minWidth: 68, height: 38, paddingHorizontal: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
    fileButtonText: { color: colors.text, fontSize: 9.5, fontWeight: '800' },
    waitingPanel: { minHeight: 42, marginTop: 11, borderRadius: 8, backgroundColor: colors.surfaceMuted, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
    waitingText: { flex: 1, color: colors.textMuted, fontSize: 10.5 },
    mergeButton: { minHeight: 38, marginTop: 9, borderRadius: 8, backgroundColor: colors.infoSoft, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
    mergeButtonText: { flex: 1, color: colors.info, fontSize: 10.5, fontWeight: '800' },
    emptyState: { minHeight: 250, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', padding: 26 },
    emptyIcon: { width: 52, height: 52, borderRadius: 11, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 13 },
    emptySubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 5 },
    loadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 10 },
  });

// A different account/session cannot inherit another owner's list or open confirmation.
export default function OwnerReportsScreen(props: ReportsScreenProps) {
  const { user } = useAuth();
  const owner = user?._id || (user as { id?: string } | null)?.id || '';
  return <ReportsScreenModern key={`${owner}:${getAuthOperationEpoch()}`} {...props} owner={owner} />;
}
