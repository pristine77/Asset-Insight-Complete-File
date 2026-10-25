import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  ImageSourcePropType,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import { FormType } from '../components/BottomSheet';
import NotificationCenterModal from '../components/NotificationCenterModal';
import AssetFormSheet from '../components/forms/AssetFormSheet';
import SalvageFormSheet from '../components/forms/SalvageFormSheet';
import RealEstateFormSheet from '../components/forms/RealEstateFormSheet';
import LotListingFormSheet from '../components/forms/LotListingFormSheet';
import LotTrendChart, { type LotTrendPoint } from '../components/dashboard/LotTrendChart';
import api from '../services/api';
import { NotificationItem } from '../services/notificationService';
import type { OfflineDraftType } from '../services/autoSaveService';
import { OfflineQueueService } from '../services/offlineQueueService';
import backgroundUploadManager from '../services/backgroundUploadManager';

interface ReportStats {
  totalReports: number;
  totalFairMarketValue: number;
  breakdown?: {
    counts: Record<string, number>;
    values: Record<string, number>;
  };
}

interface ValuationMethod {
  method: string;
  value: number;
}

interface RecentReport {
  _id: string;
  reportType?: string;
  type?: string;
  fileName?: string;
  address?: string;
  filename?: string;
  createdAt: string;
  totalValue?: number;
  fairMarketValue?: string | number;
  lot_count?: number;
  lotCount?: number;
  lotsCount?: number;
  totalAssets?: number;
  thumbnail_url?: string | null;
  thumbnailUrl?: string | null;
  lots?: unknown[];
  valuationMethods?: ValuationMethod[];
  preview_data?: {
    image_urls?: string[];
    lots?: {
      image_url?: string;
      image_urls?: string[];
      extra_image_urls?: string[];
      image_indexes?: number[];
    }[];
  };
  image_urls?: string[];
}

interface DashboardScreenProps {
  onOpenDrawer: () => void;
  savedInputToLoad?: SavedInputData | null;
  onClearSavedInput?: () => void;
  offlineDraftToLoad?: { id: string; type: OfflineDraftType } | null;
  onClearOfflineDraft?: () => void;
  onOpenSalvagePreview?: (reportId: string) => void;
}

export interface SavedInputData {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: Record<string, any>;
}

type QuickAction = {
  id: FormType | 'lotListing';
  title: string;
  subtitle: string;
  image: ImageSourcePropType;
  color: string;
};

const WorkflowImages = {
  asset: require('../../assets/workflow-asset.jpg'),
  lotListing: require('../../assets/workflow-lot-listing.jpg'),
  realEstate: require('../../assets/workflow-real-estate.jpg'),
  salvage: require('../../assets/workflow-salvage.jpg'),
} as const;

const formatCurrency = (value: number): string => {
  if (!Number.isFinite(value)) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
};

const formatDate = (dateString: string): string =>
  new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const getReportTypeIcon = (type: string): keyof typeof Feather.glyphMap => {
  switch (type?.toLowerCase()) {
    case 'asset':
      return 'package';
    case 'realestate':
    case 'real-estate':
      return 'home';
    case 'salvage':
      return 'truck';
    case 'lotlisting':
    case 'lot-listing':
      return 'list';
    default:
      return 'file-text';
  }
};

const getReportTypeColor = (type: string): string => {
  switch (type?.toLowerCase()) {
    case 'asset':
      return '#E11D48';
    case 'realestate':
    case 'real-estate':
      return '#07875F';
    case 'salvage':
      return '#2563EB';
    case 'lotlisting':
    case 'lot-listing':
      return '#7C3AED';
    default:
      return '#64748B';
  }
};

const getReportThumbnail = (report: RecentReport): string | null => {
  const suppliedThumbnail = report.thumbnail_url || report.thumbnailUrl;
  if (suppliedThumbnail) return suppliedThumbnail;

  const previewData = report.preview_data;
  const globalUrls = previewData?.image_urls || report.image_urls || [];
  for (const lot of previewData?.lots || []) {
    const direct = lot.image_url || lot.image_urls?.[0] || lot.extra_image_urls?.[0];
    if (direct) return direct;
    const index = lot.image_indexes?.[0];
    if (Number.isInteger(index) && globalUrls[index as number]) return globalUrls[index as number];
  }
  return globalUrls[0] || null;
};

const getReportLotCount = (report: RecentReport): number => {
  const explicitCount = [report.lot_count, report.lotCount, report.lotsCount, report.totalAssets]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  if (explicitCount) return Math.floor(explicitCount);

  const nestedCount = report.preview_data?.lots?.length || report.lots?.length || 0;
  return nestedCount > 0 ? nestedCount : 1;
};

const toLocalDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

const buildLotTrendData = (reports: RecentReport[], today = new Date()): LotTrendPoint[] => {
  const points = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
    return {
      date: toLocalDateKey(date),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value: 0,
    };
  });
  const pointByDate = new Map(points.map((point) => [point.date, point]));

  reports.forEach((report) => {
    const type = String(report.reportType || report.type || '').toLowerCase();
    if (!type.includes('asset') && !type.includes('lot')) return;

    const createdAt = new Date(report.createdAt);
    if (Number.isNaN(createdAt.getTime())) return;
    const point = pointByDate.get(toLocalDateKey(createdAt));
    if (point) point.value += getReportLotCount(report);
  });

  return points;
};

const DashboardScreen = ({
  onOpenDrawer,
  savedInputToLoad: externalSavedInput,
  onClearSavedInput,
  offlineDraftToLoad: externalOfflineDraft,
  onClearOfflineDraft,
  onOpenSalvagePreview,
}: DashboardScreenProps) => {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const { user } = useAuth();
  const { isDark, colors, toggleTheme } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, isTablet), [colors, isTablet]);
  const {
    notifications,
    unreadCount,
    totalCount,
    loading: notificationsLoading,
    refreshing: notificationsRefreshing,
    refreshNotifications,
    openNotification,
    markAllRead,
    deleteNotification,
  } = useNotifications();

  const [refreshing, setRefreshing] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [assetFormVisible, setAssetFormVisible] = useState(false);
  const [salvageFormVisible, setSalvageFormVisible] = useState(false);
  const [realEstateFormVisible, setRealEstateFormVisible] = useState(false);
  const [lotListingFormVisible, setLotListingFormVisible] = useState(false);
  const [savedInputToLoad, setSavedInputToLoad] = useState<SavedInputData | null>(null);
  const [offlineDraftToLoad, setOfflineDraftToLoad] = useState<{
    id: string;
    type: OfflineDraftType;
  } | null>(null);
  const [stats, setStats] = useState<ReportStats | null>(null);
  const [recentReports, setRecentReports] = useState<RecentReport[]>([]);
  const [lotTrendData, setLotTrendData] = useState<LotTrendPoint[]>(() => buildLotTrendData([]));
  const [recentLoading, setRecentLoading] = useState(true);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get('/reports/stats');
      setStats(data);
    } catch (error) {
      console.warn('Failed to fetch stats:', error);
    }
  }, []);

  const fetchRecentReports = useCallback(async () => {
    try {
      const { data } = await api.get('/reports/myreports');
      const sorted = (Array.isArray(data) ? data : []).sort(
        (a: RecentReport, b: RecentReport) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setLotTrendData(buildLotTrendData(sorted));
      setRecentReports(sorted.slice(0, 5));
    } catch (error) {
      console.warn('Failed to fetch recent reports:', error);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  const refreshConnectionStatus = useCallback(async () => {
    try {
      setIsOnline(await OfflineQueueService.isOnline());
    } catch {
      setIsOnline(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats();
    void fetchRecentReports();
    void refreshConnectionStatus();
  }, [fetchRecentReports, fetchStats, refreshConnectionStatus]);

  // A report accepted in the background (services/backgroundUploadManager.ts)
  // shows in the figures and recent reports without a pull to refresh.
  useEffect(() => backgroundUploadManager.onAccepted(() => {
    void fetchStats();
    void fetchRecentReports();
  }), [fetchRecentReports, fetchStats]);

  useEffect(() => {
    const interval = setInterval(() => void refreshConnectionStatus(), 15_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshConnectionStatus();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [refreshConnectionStatus]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!externalSavedInput) return;
    setSavedInputToLoad(externalSavedInput);
    setAssetFormVisible(true);
  }, [externalSavedInput]);

  useEffect(() => {
    if (!externalOfflineDraft) return;
    setOfflineDraftToLoad(externalOfflineDraft);
    setSavedInputToLoad(null);
    if (externalOfflineDraft.type === 'asset') setAssetFormVisible(true);
    if (externalOfflineDraft.type === 'lotListing') setLotListingFormVisible(true);
    onClearOfflineDraft?.();
  }, [externalOfflineDraft, onClearOfflineDraft]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setRecentLoading(true);
    Promise.all([fetchStats(), fetchRecentReports(), refreshConnectionStatus()]).finally(() => {
      setRefreshing(false);
    });
  }, [fetchRecentReports, fetchStats, refreshConnectionStatus]);

  const handleOpenNotification = useCallback(
    async (notification: NotificationItem) => {
      setNotifPanelOpen(false);
      await openNotification(notification);
    },
    [openNotification]
  );

  const openFormSheet = useCallback((formType: FormType | 'lotListing') => {
    if (formType === 'asset') setAssetFormVisible(true);
    if (formType === 'salvage') setSalvageFormVisible(true);
    if (formType === 'realEstate') setRealEstateFormVisible(true);
    if (formType === 'lotListing') setLotListingFormVisible(true);
  }, []);

  const greeting = useMemo(() => {
    const hour = currentTime.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, [currentTime]);

  const quickActions = useMemo<QuickAction[]>(
    () => [
      {
        id: 'asset',
        title: 'Asset report',
        subtitle: 'Equipment appraisal',
        image: WorkflowImages.asset,
        color: '#E11D48',
      },
      {
        id: 'lotListing',
        title: 'Lot listing',
        subtitle: 'Auction lot package',
        image: WorkflowImages.lotListing,
        color: '#7C3AED',
      },
      {
        id: 'realEstate',
        title: 'Real estate',
        subtitle: 'Property appraisal',
        image: WorkflowImages.realEstate,
        color: '#07875F',
      },
      {
        id: 'salvage',
        title: 'Salvage report',
        subtitle: 'Inventory report',
        image: WorkflowImages.salvage,
        color: '#2563EB',
      },
    ],
    []
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surface}
          />
        }>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onOpenDrawer} style={styles.topBarButton} activeOpacity={0.75}>
            <Feather name="menu" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.topBarCopy}>
            <Text style={styles.productName}>ASSET INSIGHT</Text>
            <Text style={styles.pageTitle}>Dashboard</Text>
          </View>
          <TouchableOpacity onPress={toggleTheme} style={styles.topBarButton} activeOpacity={0.75}>
            <Feather name={isDark ? 'sun' : 'moon'} size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setNotifPanelOpen(true)}
            style={styles.topBarButton}
            activeOpacity={0.75}>
            <Feather name="bell" size={18} color={colors.text} />
            {unreadCount > 0 ? <View style={styles.notificationDot} /> : null}
          </TouchableOpacity>
        </View>

        <View style={styles.overviewCard}>
          <View style={styles.overviewAccent} />
          <View style={styles.overviewHeader}>
            <View style={styles.overviewCopy}>
              <Text style={styles.greeting}>{greeting}</Text>
              <Text style={styles.userName} numberOfLines={1}>
                {user?.username || user?.email?.split('@')[0] || 'Appraiser'}
              </Text>
              <Text style={styles.headerDate}>
                {currentTime.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
            </View>
            <View
              style={[
                styles.connectionBadge,
                isOnline === false ? styles.connectionBadgeOffline : styles.connectionBadgeOnline,
              ]}>
              <View
                style={[
                  styles.connectionIndicator,
                  isOnline === false && styles.connectionIndicatorOffline,
                ]}
              />
              <Text style={styles.connectionText}>
                {isOnline === null ? 'Checking' : isOnline ? 'Online' : 'Offline'}
              </Text>
            </View>
          </View>

          <View style={styles.overviewMetrics}>
            <View style={styles.overviewMetric}>
              <Text style={styles.overviewMetricLabel}>REPORTS</Text>
              <Text style={styles.overviewMetricValue}>{stats?.totalReports ?? 0}</Text>
            </View>
            <View style={styles.overviewDivider} />
            <View style={styles.overviewMetric}>
              <Text style={styles.overviewMetricLabel}>PORTFOLIO VALUE</Text>
              <Text style={styles.overviewMetricValue}>
                {formatCurrency(stats?.totalFairMarketValue ?? 0)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.sectionHeadingRow}>
          <View>
            <Text style={styles.sectionTitle}>Start a report</Text>
            <Text style={styles.sectionSubtitle}>Select a workflow</Text>
          </View>
        </View>

        <View style={styles.quickActionGrid}>
          {quickActions.map((action) => (
            <Pressable
              key={action.id}
              onPress={() => openFormSheet(action.id)}
              style={({ pressed }) => [styles.quickActionCell, pressed && styles.quickActionPressed]}>
              <View style={styles.quickAction}>
                <Image source={action.image} style={styles.quickActionImage} resizeMode="cover" />
                <View style={styles.quickActionMask}>
                  <View style={styles.quickActionCopy}>
                    <Text
                      style={styles.quickActionTitle}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.8}>
                      {action.title}
                    </Text>
                    <Text style={styles.quickActionSubtitle} numberOfLines={1}>{action.subtitle}</Text>
                  </View>
                  <View style={[styles.quickActionArrow, { backgroundColor: action.color }]}>
                    <Feather name="arrow-up-right" size={14} color="#FFFFFF" />
                  </View>
                </View>
              </View>
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHeadingRow}>
          <View>
            <Text style={styles.sectionTitle}>Lot activity</Text>
            <Text style={styles.sectionSubtitle}>Lots created over the last seven days</Text>
          </View>
        </View>

        {recentLoading ? (
          <View style={styles.loadingSurface}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.loadingLabel}>Loading lot activity...</Text>
          </View>
        ) : (
          <View style={styles.trendCard}>
            <View style={styles.trendHeader}>
              <View>
                <Text style={styles.trendLabel}>TOTAL LOTS</Text>
                <Text style={styles.trendValue}>
                  {lotTrendData.reduce((total, point) => total + point.value, 0)}
                </Text>
              </View>
              <View style={styles.trendLegend}>
                <View style={styles.trendLegendDot} />
                <Text style={styles.trendLegendText}>Daily lot count</Text>
              </View>
            </View>
            <LotTrendChart data={lotTrendData} colors={colors} />
          </View>
        )}

        <View style={styles.sectionHeadingRow}>
          <View>
            <Text style={styles.sectionTitle}>Recent reports</Text>
            <Text style={styles.sectionSubtitle}>Latest activity across your account</Text>
          </View>
        </View>

        {recentLoading ? (
          <View style={styles.loadingSurface}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.loadingLabel}>Loading activity...</Text>
          </View>
        ) : recentReports.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Feather name="file-plus" size={24} color={colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>No reports yet</Text>
            <Text style={styles.emptySubtitle}>Create your first report to see recent activity here.</Text>
          </View>
        ) : (
          <View style={styles.recentList}>
            {recentReports.map((report) => {
              const reportType = report.reportType || report.type || 'asset';
              const displayName = report.address || report.filename || report.fileName || 'Report';
              const typeColor = getReportTypeColor(reportType);
              const thumbnail = getReportThumbnail(report);
              const lotCount = getReportLotCount(report);
              const reportValue = report.valuationMethods?.[0]?.value ??
                (typeof report.fairMarketValue === 'number' ? report.fairMarketValue : undefined);
              const typeLabel = reportType.toLowerCase().includes('lot')
                ? 'LOT LISTING'
                : reportType.toLowerCase().includes('real')
                  ? 'REAL ESTATE'
                  : reportType.toUpperCase();
              return (
                <View key={report._id} style={styles.recentCard}>
                  <View style={[styles.recentAccent, { backgroundColor: typeColor }]} />
                  {thumbnail ? (
                    <Image source={{ uri: thumbnail }} style={styles.recentThumbnail} resizeMode="cover" />
                  ) : (
                    <View style={[styles.recentIcon, { backgroundColor: `${typeColor}18` }]}>
                      <Feather name={getReportTypeIcon(reportType)} size={18} color={typeColor} />
                    </View>
                  )}
                  <View style={styles.recentCopy}>
                    <Text style={[styles.recentType, { color: typeColor }]}>{typeLabel}</Text>
                    <Text style={styles.recentTitle} numberOfLines={2}>{displayName}</Text>
                    <View style={styles.recentMetaRow}>
                      <Text style={styles.recentMeta}>{formatDate(report.createdAt)}</Text>
                      <View style={styles.recentLotBadge}>
                        <Feather name="layers" size={9} color={typeColor} />
                        <Text style={[styles.recentLotBadgeText, { color: typeColor }]}>
                          {lotCount} {lotCount === 1 ? 'lot' : 'lots'}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View style={styles.recentValueWrap}>
                    {reportValue != null ? (
                      <Text style={styles.recentValue}>{formatCurrency(reportValue)}</Text>
                    ) : null}
                    <View style={styles.recentReady}>
                      <View style={styles.recentReadyDot} />
                      <Text style={styles.recentReadyText}>Ready</Text>
                    </View>
                    <Feather name="chevron-right" size={17} color={colors.textMuted} />
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Submit hands the upload to the background line and closes the form;
          the upload bar shows its progress (App.tsx, UploadBar.tsx). */}
      <AssetFormSheet
        backgroundUploads
        visible={assetFormVisible}
        onClose={() => {
          setAssetFormVisible(false);
          setSavedInputToLoad(null);
          setOfflineDraftToLoad(null);
          onClearSavedInput?.();
        }}
        savedInputData={savedInputToLoad}
        draftIdToLoad={offlineDraftToLoad?.type === 'asset' ? offlineDraftToLoad.id : null}
      />
      <SalvageFormSheet
        visible={salvageFormVisible}
        onClose={() => setSalvageFormVisible(false)}
        onSuccess={(reportId) => {
          void fetchStats();
          void fetchRecentReports();
          if (reportId) onOpenSalvagePreview?.(reportId);
        }}
      />
      <RealEstateFormSheet
        visible={realEstateFormVisible}
        onClose={() => setRealEstateFormVisible(false)}
        onSuccess={() => {
          void fetchStats();
          void fetchRecentReports();
        }}
      />
      <LotListingFormSheet
        backgroundUploads
        visible={lotListingFormVisible}
        onClose={() => {
          setLotListingFormVisible(false);
          setOfflineDraftToLoad(null);
        }}
        onSuccess={() => {
          void fetchStats();
          void fetchRecentReports();
        }}
        draftIdToLoad={offlineDraftToLoad?.type === 'lotListing' ? offlineDraftToLoad.id : null}
      />
      <NotificationCenterModal
        visible={notifPanelOpen}
        notifications={notifications}
        unreadCount={unreadCount}
        totalCount={totalCount}
        loading={notificationsLoading}
        refreshing={notificationsRefreshing}
        onClose={() => setNotifPanelOpen(false)}
        onRefresh={refreshNotifications}
        onOpenNotification={handleOpenNotification}
        onMarkAllRead={markAllRead}
        onDeleteNotification={deleteNotification}
      />
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors, isTablet: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { flex: 1 },
    contentContainer: {
      paddingHorizontal: isTablet ? 24 : 14,
      paddingTop: 12,
      paddingBottom: 36,
      maxWidth: 980,
      width: '100%',
      alignSelf: 'center',
    },
    topBar: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    topBarButton: {
      width: 40,
      height: 40,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      marginLeft: 7,
    },
    topBarCopy: { flex: 1, minWidth: 0, marginLeft: 11 },
    productName: { color: colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
    pageTitle: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 1 },
    overviewCard: {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: colors.surfaceRaised,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      padding: isTablet ? 18 : 14,
      marginBottom: 20,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 5 },
      shadowOpacity: 0.11,
      shadowRadius: 10,
      elevation: 4,
    },
    overviewAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent },
    overviewHeader: { flexDirection: 'row', alignItems: 'flex-start' },
    overviewCopy: { flex: 1, minWidth: 0, paddingLeft: 3, paddingRight: 10 },
    greeting: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700' },
    userName: { color: colors.text, fontSize: isTablet ? 24 : 20, fontWeight: '900', marginTop: 1 },
    headerDate: { color: colors.textSecondary, fontSize: 10.5, fontWeight: '600', marginTop: 3 },
    connectionBadge: {
      height: 28,
      paddingHorizontal: 9,
      borderRadius: 7,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
    },
    connectionBadgeOnline: { backgroundColor: colors.successSoft, borderColor: colors.success },
    connectionBadgeOffline: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
    connectionIndicator: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#4AD3A2' },
    connectionIndicatorOffline: { backgroundColor: '#FF6B78' },
    connectionText: { color: colors.text, fontSize: 9.5, fontWeight: '800' },
    overviewMetrics: {
      marginTop: 14,
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    overviewMetric: { flex: 1, paddingHorizontal: 3 },
    overviewMetricLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
    overviewMetricValue: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 3 },
    overviewDivider: { width: 1, backgroundColor: colors.border, marginHorizontal: 12 },
    notificationDot: {
      position: 'absolute',
      top: 7,
      right: 7,
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    sectionHeadingRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 10,
      marginTop: 2,
    },
    sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '900' },
    sectionSubtitle: { color: colors.textMuted, fontSize: 10.5, marginTop: 2 },
    refreshButton: {
      width: 38,
      height: 38,
      borderRadius: 9,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    quickActionGrid: {
      width: '100%',
      alignSelf: 'stretch',
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginBottom: 20,
    },
    quickActionCell: {
      width: '50%',
      maxWidth: '50%',
      flexBasis: '50%',
      flexGrow: 0,
      flexShrink: 0,
      padding: 3,
    },
    quickAction: {
      width: '100%',
      aspectRatio: 2.90,
      position: 'relative',
      overflow: 'hidden',
      borderRadius: 14,
      backgroundColor: '#111318',
      borderWidth: 1,
      borderColor: colors.border,
    },
    quickActionPressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
    quickActionImage: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: '100%',
      height: '100%',
    },
    quickActionMask: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      minHeight: 48,
      paddingHorizontal: 9,
      paddingVertical: 6,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(7, 9, 13, 0.78)',
    },
    quickActionCopy: { flex: 1, minWidth: 0, paddingRight: 6 },
    quickActionTitle: {
      color: '#FFFFFF',
      fontSize: 12,
      lineHeight: 13,
      fontWeight: '900',
    },
    quickActionSubtitle: { color: 'rgba(255,255,255,0.72)', fontSize: 8, lineHeight: 10, marginTop: 1 },
    quickActionArrow: {
      width: 24,
      height: 24,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingSurface: {
      minHeight: 120,
      marginBottom: 26,
      borderRadius: 11,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    loadingLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
    trendCard: {
      width: '100%',
      marginBottom: 22,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 4,
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 3,
    },
    trendHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 2,
    },
    trendLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.7 },
    trendValue: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 2 },
    trendLegend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    trendLegendDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
    trendLegendText: { color: colors.textSecondary, fontSize: 9.5, fontWeight: '700' },
    recentList: { gap: 9, paddingBottom: 4 },
    recentCard: {
      position: 'relative',
      minHeight: 80,
      flexDirection: 'row',
      alignItems: 'center',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 9,
      paddingLeft: 12,
      paddingRight: 10,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 3,
    },
    recentAccent: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
    },
    recentIcon: {
      width: 58,
      height: 58,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    recentThumbnail: {
      width: 58,
      height: 58,
      borderRadius: 8,
      marginRight: 10,
      backgroundColor: colors.surfaceMuted,
    },
    recentCopy: { flex: 1, minWidth: 0, justifyContent: 'center' },
    recentType: {
      fontSize: 7.5,
      lineHeight: 10,
      fontWeight: '900',
      letterSpacing: 0.65,
      marginBottom: 2,
    },
    recentTitle: { color: colors.text, fontSize: 12.5, lineHeight: 16, fontWeight: '900' },
    recentMeta: { color: colors.textMuted, fontSize: 9.5, marginTop: 3, fontWeight: '600' },
    recentMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    recentLotBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      marginTop: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 5,
      backgroundColor: colors.surfaceMuted,
    },
    recentLotBadgeText: { fontSize: 8.5, fontWeight: '900' },
    recentValueWrap: {
      minWidth: 60,
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 5,
      marginLeft: 7,
    },
    recentValue: { color: colors.text, fontSize: 11, fontWeight: '900' },
    recentReady: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    recentReadyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
    recentReadyText: { color: colors.success, fontSize: 8.5, fontWeight: '900' },
    emptyState: {
      minHeight: 170,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    emptyIcon: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '900', marginTop: 12 },
    emptySubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 4, maxWidth: 280 },
  });

export default DashboardScreen;
