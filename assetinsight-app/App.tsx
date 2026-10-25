import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import './global.css';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { NotificationProvider, useNotifications } from './src/context/NotificationContext';
import AuthScreen from './src/screens/AuthScreen';
import DeviceAccessScreen from './src/screens/DeviceAccessScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ReportsScreen from './src/screens/ReportsScreenModern';
import AssignedApprovalsScreen from './src/screens/AssignedApprovalsScreen';
import AssignedReleasesScreen from './src/screens/AssignedReleasesScreen';
import OfflineReportsScreen from './src/screens/OfflineReportsScreen';
import PreviewsScreen from './src/screens/PreviewsScreen';
import PreviewScreen from './src/screens/PreviewScreen';
import SalvagePreviewScreen from './src/screens/SalvagePreviewScreen';
import CrmEntryScreen from './src/screens/CrmEntryScreen';
import CrmDashboardScreen from './src/screens/CrmDashboardScreen';
import CrmTasksScreen from './src/screens/CrmTasksScreen';
import CrmOutlookCalendarScreen from './src/screens/CrmOutlookCalendarScreen';
import CrmCalendarScreen from './src/screens/CrmCalendarScreen';
import AuctionManagementScreen from './src/screens/AuctionManagementScreen';
import SupportScreen from './src/screens/SupportScreen';
import DrawerContent, { ScreenName as DrawerScreenName } from './src/components/DrawerContent';
import NotificationCenterModal from './src/components/NotificationCenterModal';
import PreviewReminderNotification from './src/components/PreviewReminderNotification';
import UploadBar from './src/components/UploadBar';
import { claimDraftForEditing } from './src/components/backgroundUploadDraftGuard';
import durableReportTransfer from './src/services/durableReportTransfer';
import OfflineCaptureStore from './src/services/offlineCaptureStore';
import { previewReminderDetails } from './src/utils/previewReminderNotification';
import type { NotificationItem } from './src/services/notificationService';
import offlineQueueService from './src/services/offlineQueueService';
import draftSyncService from './src/services/draftSyncService';
import OfflineCaptureSync from './src/services/offlineCaptureSync';
import { startCaptureBackups, stopCaptureBackupObservers } from './src/services/captureBackupService';
import type { OfflineDraftType } from './src/services/autoSaveService';
import type { CrmDashboardTaskFilter, CrmTaskStatus } from './src/services/crmService';
import { getNotificationNavigationTarget } from './src/utils/notificationNavigation';
import { ThemeProvider, useAppTheme } from './src/context/ThemeContext';

const DRAWER_WIDTH = 252;

// SavedInput type for passing between screens
interface SavedInputForForm {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: Record<string, any>;
}

type CrmMode = 'listing' | 'crm';
type ScreenName = DrawerScreenName;
type CrmTaskOpenTarget =
  | string
  | null
  | {
      taskId?: string | null;
      filter?: CrmDashboardTaskFilter | null;
      status?: CrmTaskStatus | null;
    };

const CRM_SCREENS: ScreenName[] = ['crmEntry', 'crmDashboard', 'crmTasks', 'crmCalendar', 'crmOutlookCalendar'];
const LISTING_SCREENS: ScreenName[] = ['dashboard', 'auctionManagement', 'savedInputs', 'offlineReports', 'reports', 'approvals', 'releases', 'preview'];

function MainApp() {
  const { isDark, colors } = useAppTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const {
    notifications,
    unreadCount,
    totalCount,
    loading: notificationsLoading,
    refreshing: notificationsRefreshing,
    lastOpenedNotification,
    refreshNotifications,
    markAllRead,
    deleteNotification,
    openNotification,
    clearLastOpenedNotification,
  } = useNotifications();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [previewReminder, setPreviewReminder] = useState<{ item: NotificationItem; ownerId: string } | null>(null);
  const [activeScreen, setActiveScreen] = useState<ScreenName>('dashboard');
  const [crmMode, setCrmMode] = useState<CrmMode>('listing');
  const [savedInputToLoad, setSavedInputToLoad] = useState<SavedInputForForm | null>(null);
  const [offlineDraftToLoad, setOfflineDraftToLoad] = useState<{
    id: string;
    type: OfflineDraftType;
  } | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [crmTaskFilter, setCrmTaskFilter] = useState<CrmDashboardTaskFilter | null>(null);
  const [crmTaskStatusFilter, setCrmTaskStatusFilter] = useState<CrmTaskStatus | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{
    reportId: string;
    reportType: 'Asset' | 'RealEstate' | 'LotListing' | 'Salvage';
    mode: 'pending' | 'submitted';
    source?: 'owner' | 'assignedApproval';
    returnScreen: ScreenName;
  } | null>(null);
  const [previewListMode, setPreviewListMode] = useState<'pending' | 'submitted'>('pending');

  useEffect(() => {
    if (user?.isCrmAgent) {
      setActiveScreen('crmEntry');
      return;
    }

    setCrmMode('listing');
    setActiveScreen((prev) => (CRM_SCREENS.includes(prev) ? 'dashboard' : prev));
  }, [user?._id, user?.isCrmAgent]);

  const openCrmTasksScreen = useCallback((target?: CrmTaskOpenTarget) => {
    if (!user?.isCrmAgent) {
      return;
    }

    const taskId = target && typeof target === 'object' ? target.taskId || null : target || null;
    const filter = target && typeof target === 'object' ? target.filter || null : null;
    const status = target && typeof target === 'object' ? target.status || null : null;

    setCrmMode('crm');
    setPreviewTarget(null);
    setDrawerOpen(false);
    setOpenTaskId(taskId);
    setCrmTaskFilter(filter);
    setCrmTaskStatusFilter(status);
    setActiveScreen('crmTasks');
  }, [user?.isCrmAgent]);

  const openReportsScreen = useCallback(() => {
    setCrmMode('listing');
    setDrawerOpen(false);
    setPreviewTarget(null);
    setActiveScreen('reports');
  }, []);

  const openPreviewScreen = useCallback((
    reportId: string,
    reportType: 'Asset' | 'RealEstate' | 'LotListing' | 'Salvage',
    mode: 'pending' | 'submitted'
  ) => {
    setCrmMode('listing');
    setDrawerOpen(false);
    setOpenTaskId(null);
    setPreviewTarget({
      reportId,
      reportType,
      mode,
      source: 'owner',
      returnScreen: 'preview',
    });
    setActiveScreen('preview');
  }, []);

  useEffect(() => {
    if (!lastOpenedNotification) {
      return;
    }

    if (previewReminderDetails(lastOpenedNotification)) {
      setNotificationCenterOpen(false);
      setPreviewReminder({ item: lastOpenedNotification, ownerId: String(user?._id || '') });
      clearLastOpenedNotification();
      return;
    }

    const target = getNotificationNavigationTarget(lastOpenedNotification.data);
    if (target?.kind === 'crmTasks' && user?.isCrmAgent) {
      openCrmTasksScreen(target.taskId);
    } else if (target?.kind === 'preview') {
      openPreviewScreen(target.reportId, target.reportType, target.mode);
    } else if (target?.kind === 'reports') {
      openReportsScreen();
    }

    clearLastOpenedNotification();
  }, [
    clearLastOpenedNotification,
    lastOpenedNotification,
    openCrmTasksScreen,
    openPreviewScreen,
    openReportsScreen,
    user?.isCrmAgent,
    user?._id,
  ]);

  const openDrawer = () => {
    if (activeScreen === 'crmEntry') return;
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
  };

  const handleOpenNotification = useCallback(async (item: typeof notifications[number]) => {
    setNotificationCenterOpen(false);
    await openNotification(item);
  }, [openNotification]);

  const showGlobalNotificationCenter =
    activeScreen !== 'dashboard' &&
    activeScreen !== 'support' &&
    activeScreen !== 'preview' &&
    activeScreen !== 'reports' &&
    activeScreen !== 'savedInputs' &&
    activeScreen !== 'offlineReports' &&
    crmMode !== 'crm' &&
    !CRM_SCREENS.includes(activeScreen);
  const canUseGlobalNotificationModal =
    showGlobalNotificationCenter ||
    activeScreen === 'preview' ||
    activeScreen === 'reports' ||
    activeScreen === 'savedInputs' ||
    activeScreen === 'offlineReports';

  useEffect(() => {
    if (!canUseGlobalNotificationModal && notificationCenterOpen) {
      setNotificationCenterOpen(false);
    }
  }, [canUseGlobalNotificationModal, notificationCenterOpen]);

  const handleNavigate = (screen: ScreenName) => {
    if (!user?.isCrmAgent && CRM_SCREENS.includes(screen)) {
      setActiveScreen('dashboard');
      setPreviewTarget(null);
      return;
    }

    if (user?.isCrmAgent && crmMode === 'crm' && LISTING_SCREENS.includes(screen)) {
      setActiveScreen('crmDashboard');
      setPreviewTarget(null);
      return;
    }

    if (user?.isCrmAgent && crmMode === 'listing' && screen !== 'crmEntry' && CRM_SCREENS.includes(screen)) {
      setActiveScreen('dashboard');
      setPreviewTarget(null);
      return;
    }

    setActiveScreen(screen);
    setPreviewTarget(null);
  };

  const switchToCrmMode = () => {
    if (!user?.isCrmAgent) return;
    setCrmMode('crm');
    setActiveScreen('crmDashboard');
    setPreviewTarget(null);
  };

  const switchToListingMode = () => {
    setCrmMode('listing');
    setActiveScreen('dashboard');
    setPreviewTarget(null);
  };

  // Handle loading a saved input into the asset form
  const handleLoadSavedInput = (savedInput: SavedInputForForm) => {
    setSavedInputToLoad(savedInput);
    setActiveScreen('dashboard'); // Navigate to dashboard which has the form
  };

  // Clear saved input after it's been loaded
  const clearSavedInput = () => {
    setSavedInputToLoad(null);
  };

  const clearOfflineDraft = useCallback(() => {
    setOfflineDraftToLoad(null);
  }, []);

  const openingOfflineDraft = useRef(false);
  const handleContinueOfflineDraft = useCallback((draftId: string, type: OfflineDraftType) => {
    // Every way into a saved draft passes here (Drafts, Offline captures, the
    // upload bar). A draft uploading in the background stays closed until it
    // is paused or finished; a paused one is handed back to its form.
    if (openingOfflineDraft.current) return;
    const owner = OfflineCaptureStore.getOwnerId();
    openingOfflineDraft.current = true;
    void (async () => {
      await durableReportTransfer.ready();
      const transfer = durableReportTransfer.statusFor(draftId);
      if (transfer && ['paused', 'attention'].includes(transfer.status)) await durableReportTransfer.releaseForEditing(draftId);
      if (owner !== OfflineCaptureStore.getOwnerId()) return;
      if (!claimDraftForEditing(draftId)) return;
      setCrmMode('listing');
      setDrawerOpen(false);
      setPreviewTarget(null);
      setSavedInputToLoad(null);
      setOfflineDraftToLoad({ id: draftId, type });
      setActiveScreen('dashboard');
    })().catch(error => {
      if (owner === OfflineCaptureStore.getOwnerId()) Alert.alert('Upload needs attention', error instanceof Error ? error.message : 'Reopen this draft to check the upload.');
    }).finally(() => { openingOfflineDraft.current = false; });
  }, []);

  const renderScreen = () => {
    if (user?.isCrmAgent && crmMode === 'crm' && LISTING_SCREENS.includes(activeScreen)) {
      return <CrmDashboardScreen onOpenDrawer={openDrawer} onOpenTasks={openCrmTasksScreen} />;
    }

    switch (activeScreen) {
      case 'crmEntry':
        if (!user?.isCrmAgent) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        return (
          <CrmEntryScreen
            onSelectListings={() => {
              setCrmMode('listing');
              setActiveScreen('dashboard');
            }}
            onSelectCrm={() => {
              setCrmMode('crm');
              setActiveScreen('crmDashboard');
            }}
          />
        );
      case 'crmDashboard':
        if (!user?.isCrmAgent) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        if (crmMode !== 'crm') {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        return <CrmDashboardScreen onOpenDrawer={openDrawer} onOpenTasks={openCrmTasksScreen} />;
      case 'crmTasks':
        if (!user?.isCrmAgent) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        if (crmMode !== 'crm') {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        return (
          <CrmTasksScreen
            onOpenDrawer={openDrawer}
            onBack={() => setActiveScreen('crmDashboard')}
            initialTaskId={openTaskId}
            initialDashboardFilter={crmTaskFilter}
            initialStatusFilter={crmTaskStatusFilter}
            onClearInitialTask={() => setOpenTaskId(null)}
            onClearInitialDashboardFilter={() => setCrmTaskFilter(null)}
            onClearInitialStatusFilter={() => setCrmTaskStatusFilter(null)}
          />
        );
      case 'crmOutlookCalendar':
        if (!user?.isCrmAgent) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        if (crmMode !== 'crm') {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        return <CrmOutlookCalendarScreen onOpenDrawer={openDrawer} onBack={() => setActiveScreen('crmTasks')} />;
      case 'crmCalendar':
        // Follow-up dates by day (2026-10-11); same CRM-agent and CRM-mode gate as the other CRM screens.
        if (!user?.isCrmAgent || crmMode !== 'crm') {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }

        return (
          <CrmCalendarScreen
            onOpenDrawer={openDrawer}
            onBack={() => setActiveScreen('crmTasks')}
            onOpenTask={(taskId) => openCrmTasksScreen({ taskId })}
          />
        );
      case 'dashboard':
        return (
          <DashboardScreen 
            onOpenDrawer={openDrawer} 
            savedInputToLoad={savedInputToLoad}
            onClearSavedInput={clearSavedInput}
            offlineDraftToLoad={offlineDraftToLoad}
            onClearOfflineDraft={clearOfflineDraft}
            onOpenSalvagePreview={(reportId) => openPreviewScreen(reportId, 'Salvage', 'pending')}
          />
        );
      case 'auctionManagement':
        return <AuctionManagementScreen onOpenDrawer={openDrawer} onOpenReport={(reportId, reportType) => openPreviewScreen(reportId, reportType === 'asset' ? 'Asset' : 'LotListing', 'pending')} />;
      case 'savedInputs':
        return (
          <OfflineReportsScreen
            onOpenDrawer={openDrawer}
            onBack={() => setActiveScreen('dashboard')}
            onContinueDraft={handleContinueOfflineDraft}
            onLoadSavedInput={handleLoadSavedInput}
            unreadCount={unreadCount}
            onOpenNotifications={() => setNotificationCenterOpen(true)}
            initialTab="saved"
          />
        );
      case 'offlineReports':
        return (
          <OfflineReportsScreen
            onOpenDrawer={openDrawer}
            onBack={() => setActiveScreen('dashboard')}
            onContinueDraft={handleContinueOfflineDraft}
            onLoadSavedInput={handleLoadSavedInput}
            unreadCount={unreadCount}
            onOpenNotifications={() => setNotificationCenterOpen(true)}
            initialTab="drafts"
          />
        );
      case 'profile':
        return (
          <ProfileScreen onOpenDrawer={openDrawer} onBack={() => setActiveScreen('dashboard')} />
        );
      case 'support':
        return (
          <SupportScreen onOpenDrawer={openDrawer} onBack={() => setActiveScreen('dashboard')} />
        );
      case 'reports':
        return (
          <ReportsScreen
            onOpenDrawer={openDrawer}
            onBack={() => setActiveScreen('dashboard')}
            unreadCount={unreadCount}
            onOpenNotifications={() => setNotificationCenterOpen(true)}
            onOpenPreview={(reportId, reportType) => {
              setPreviewTarget({ reportId, reportType, mode: 'pending', source: 'owner', returnScreen: 'reports' });
              setActiveScreen('preview');
            }}
            onMergeCreated={() => {
              setPreviewListMode('pending');
              setPreviewTarget(null);
              setActiveScreen('preview');
            }}
          />
        );
      case 'approvals':
        if (!user?.isReportApprover) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }
        return (
          <AssignedApprovalsScreen
            onOpenDrawer={openDrawer}
            onOpenPreview={(reportId, reportType, source) => {
              setPreviewTarget({
                reportId,
                reportType,
                mode: 'submitted',
                source,
                returnScreen: 'approvals',
              });
              setActiveScreen('preview');
            }}
          />
        );
      case 'releases':
        if (!user?.isReleaseManager) {
          return (
            <DashboardScreen
              onOpenDrawer={openDrawer}
              savedInputToLoad={savedInputToLoad}
              onClearSavedInput={clearSavedInput}
            />
          );
        }
        return <AssignedReleasesScreen onOpenDrawer={openDrawer} />;
      case 'preview':
        if (!previewTarget) {
          return (
            <PreviewsScreen
              onOpenDrawer={openDrawer}
              onBack={() => setActiveScreen('dashboard')}
              initialMode={previewListMode}
              unreadCount={unreadCount}
              onOpenNotifications={() => setNotificationCenterOpen(true)}
              onOpenDrafts={() => setActiveScreen('offlineReports')}
              onOpenPreview={(reportId, reportType, mode) => {
                setPreviewListMode(mode);
                setPreviewTarget({ reportId, reportType, mode, source: 'owner', returnScreen: 'preview' });
                setActiveScreen('preview');
              }}
            />
          );
        }

        if (previewTarget.reportType === 'Salvage') {
          return <SalvagePreviewScreen key={previewTarget.reportId} reportId={previewTarget.reportId} readOnly={previewTarget.source === 'assignedApproval'} onBack={() => {
            setPreviewTarget(null);
            setActiveScreen(previewTarget.returnScreen);
          }} />;
        }
        return (
          <PreviewScreen
            reportId={previewTarget.reportId}
            reportType={previewTarget.reportType}
            mode={previewTarget.mode}
            source={previewTarget.source || 'owner'}
            unreadCount={unreadCount}
            onOpenNotifications={() => setNotificationCenterOpen(true)}
            onBack={() => {
              setPreviewTarget(null);
              setActiveScreen(previewTarget.returnScreen);
            }}
            onSuccess={() => {
              setPreviewListMode('submitted');
              setPreviewTarget(null);
              setActiveScreen(previewTarget.returnScreen);
            }}
          />
        );
      default:
        return (
          <DashboardScreen 
            onOpenDrawer={openDrawer} 
            savedInputToLoad={savedInputToLoad}
            onClearSavedInput={clearSavedInput}
          />
        );
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style={isDark ? 'light' : 'dark'} backgroundColor={colors.background} />

      {/* Main Content */}
      {renderScreen()}

      {/* Background uploads: rendered here, not in a screen, so it stays
          while the person moves between screens. It follows the screen in
          this column, so the screen ends above it and keeps its own bottom
          controls in view. */}
      <UploadBar onOpenDraft={handleContinueOfflineDraft} />

      {showGlobalNotificationCenter ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open notifications"
          style={[
            styles.notificationBell,
            {
              top: Math.max(insets.top, 12) + 4,
            },
          ]}
          activeOpacity={0.88}
          onPress={() => setNotificationCenterOpen(true)}
        >
          <Feather name="bell" size={20} color="#FFFFFF" />
          {unreadCount > 0 ? (
            <View style={styles.notificationBadge}>
              <View style={styles.notificationBadgeInner} />
            </View>
          ) : null}
        </TouchableOpacity>
      ) : null}

      {canUseGlobalNotificationModal ? (
        <NotificationCenterModal
          visible={notificationCenterOpen}
          notifications={notifications}
          unreadCount={unreadCount}
          totalCount={totalCount}
          loading={notificationsLoading}
          refreshing={notificationsRefreshing}
          onClose={() => setNotificationCenterOpen(false)}
          onRefresh={refreshNotifications}
          onOpenNotification={handleOpenNotification}
          onMarkAllRead={markAllRead}
          onDeleteNotification={deleteNotification}
        />
      ) : null}

      {previewReminder && previewReminder.ownerId === String(user?._id || '') ? <PreviewReminderNotification
        key={previewReminder.item.id}
        item={previewReminder.item}
        onClose={() => setPreviewReminder(null)}
        onOpenPreview={openPreviewScreen}
        onOpenDrafts={() => { setCrmMode('listing'); setDrawerOpen(false); setPreviewTarget(null); setActiveScreen('offlineReports'); }}
      /> : null}

      {/* Drawer Modal */}
      {activeScreen !== 'crmEntry' ? (
        <Modal
          visible={drawerOpen}
          transparent
          animationType="fade"
          onRequestClose={closeDrawer}
        >
          <View style={styles.modalContainer}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={closeDrawer} />
            <View style={[styles.drawer, { backgroundColor: colors.surface }]}>
              <DrawerContent
                onClose={closeDrawer}
                onNavigate={handleNavigate}
                activeScreen={activeScreen as DrawerScreenName}
                crmMode={crmMode}
                onSwitchToCrm={switchToCrmMode}
                onSwitchToListing={switchToListingMode}
              />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function AuthGate() {
  const { colors } = useAppTheme();
  const { user, loading, deviceAccess } = useAuth();
  // Keyed by the signed-in account, not the user object (2026-10-02). A
  // profile save refreshes the user and hands over a new object for the same
  // account; re-running the cleanup then paused every upload, including the
  // background upload line.
  const accountKey = user ? `account:${String(user._id || (user as any).id || '')}` : null;

  useEffect(() => {
    if (accountKey) {
      void startCaptureBackups(accountKey.slice('account:'.length)).catch(() => undefined);
      offlineQueueService.init();
      draftSyncService.init();
      OfflineCaptureSync.init();
      return () => {
        stopCaptureBackupObservers();
        offlineQueueService.cleanup();
        draftSyncService.cleanup();
        OfflineCaptureSync.cleanup();
      };
    }

    offlineQueueService.cleanup();
    stopCaptureBackupObservers();
    draftSyncService.cleanup();
    OfflineCaptureSync.cleanup();
    return () => {
      offlineQueueService.cleanup();
      draftSyncService.cleanup();
      OfflineCaptureSync.cleanup();
    };
  }, [accountKey]);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (deviceAccess) {
    return <DeviceAccessScreen />;
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <NotificationProvider>
      <MainApp />
    </NotificationProvider>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
  },
  modalContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  drawer: {
    width: DRAWER_WIDTH,
    height: '100%',
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 10,
  },
  notificationBell: {
    position: 'absolute',
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 30,
  },
  notificationBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationBadgeInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#EF4444',
  },
});
