import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CrmModalFrame, { crmTouchTarget } from '../components/crm/CrmModalFrame';
import { Feather } from '@expo/vector-icons';
import crmTaskApi, {
  CRM_OPEN_STATUSES,
  CRM_STATUS_LABELS,
  CrmOutlookCalendarStatus,
  CrmTaskItem,
  CrmTaskStatus,
} from '../services/crmService';
import { useAuth } from '../context/AuthContext';

interface CrmOutlookCalendarScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
}

const STATUS_OPTIONS: { key: 'all' | CrmTaskStatus; label: string }[] = [
  { key: 'all', label: 'All Open' },
  { key: 'new_lead', label: 'New Lead' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'inspection_required', label: 'Inspection Required' },
  { key: 'inspection_complete', label: 'Inspection Complete' },
  { key: 'proposal_submitted', label: 'Proposal Submitted' },
  { key: 'decision_pending', label: 'Decision Pending' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleDateString();
}

function statusText(status: CrmTaskStatus): string {
  return CRM_STATUS_LABELS[status] || status;
}

function getStatusBadge(status: CrmTaskStatus) {
  if (status === 'new_lead') return { bg: '#E0F2FE', text: '#075985' };
  if (status === 'contacted') return { bg: '#DBEAFE', text: '#1D4ED8' };
  if (status === 'inspection_required') return { bg: '#FEF3C7', text: '#B45309' };
  if (status === 'inspection_complete') return { bg: '#E0E7FF', text: '#4338CA' };
  if (status === 'proposal_submitted') return { bg: '#FCE7F3', text: '#BE185D' };
  if (status === 'decision_pending') return { bg: '#F3E8FF', text: '#7C3AED' };
  if (status === 'won') return { bg: '#DCFCE7', text: '#166534' };
  return { bg: '#FEE2E2', text: '#B91C1C' };
}

export default function CrmOutlookCalendarScreen({
  onOpenDrawer,
  onBack,
}: CrmOutlookCalendarScreenProps) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isCompact = width < 380;
  const isVeryCompact = width < 340;

  const [tasks, setTasks] = useState<CrmTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outlookStatus, setOutlookStatus] = useState<CrmOutlookCalendarStatus>({
    connected: false,
    configured: true,
  });
  const [outlookStatusLoading, setOutlookStatusLoading] = useState(true);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [outlookBulkSyncing, setOutlookBulkSyncing] = useState(false);
  const [calendarSyncModalVisible, setCalendarSyncModalVisible] = useState(false);
  const [calendarSyncSearchText, setCalendarSyncSearchText] = useState('');
  const [calendarSyncStatusFilter, setCalendarSyncStatusFilter] = useState<'all' | CrmTaskStatus>('all');
  const [calendarSyncSelectedTaskIds, setCalendarSyncSelectedTaskIds] = useState<string[]>([]);

  const displayName = user?.username || user?.email?.split('@')[0] || 'there';

  const fetchTasks = useCallback(async () => {
    try {
      setError(null);
      const data = await crmTaskApi.getMyTasks({ page: 1, limit: 100 });
      setTasks(data.items || []);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to load CRM tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchOutlookStatus = useCallback(async (showError = false) => {
    try {
      setOutlookStatusLoading(true);
      const status = await crmTaskApi.getOutlookCalendarStatus();
      setOutlookStatus(status);
    } catch (e: any) {
      if (showError) {
        Alert.alert(
          'Outlook Status Error',
          e?.response?.data?.message || e?.message || 'Failed to load Outlook calendar status.'
        );
      }
    } finally {
      setOutlookStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([fetchTasks(), fetchOutlookStatus()]);
  }, [fetchOutlookStatus, fetchTasks]);

  useEffect(() => {
    setCalendarSyncSelectedTaskIds((prev) =>
      prev.filter((taskId) => tasks.some((task) => task._id === taskId))
    );
  }, [tasks]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([fetchTasks(), fetchOutlookStatus(true)]);
  }, [fetchOutlookStatus, fetchTasks]);

  const openTasks = useMemo(
    () => tasks.filter((task) => CRM_OPEN_STATUSES.includes(task.status)),
    [tasks]
  );

  const calendarSyncFilteredTasks = useMemo(() => {
    const query = calendarSyncSearchText.trim().toLowerCase();
    return tasks.filter((task) => {
      if (calendarSyncStatusFilter === 'all' && !CRM_OPEN_STATUSES.includes(task.status)) {
        return false;
      }
      if (calendarSyncStatusFilter !== 'all' && task.status !== calendarSyncStatusFilter) {
        return false;
      }
      if (!query) return true;

      const haystack = [
        task.clientName,
        task.companyName,
        task.email,
        task.phoneRaw,
        task.phoneFormatted,
        ...(task.contactPhones || []),
        ...(task.companyPhones || []),
        ...(task.contactMobilePhones || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [calendarSyncSearchText, calendarSyncStatusFilter, tasks]);

  const calendarSyncSelectedCount = calendarSyncSelectedTaskIds.length;

  const connectOutlookCalendar = async () => {
    if (outlookBusy) return;
    try {
      setOutlookBusy(true);
      const authUrl = await crmTaskApi.getOutlookCalendarAuthUrl();
      if (!authUrl) {
        Alert.alert('Connection Error', 'Unable to start Outlook connection.');
        return;
      }
      await Linking.openURL(authUrl);
      Alert.alert(
        'Continue in Browser',
        'Complete Microsoft sign-in, then return here and tap Refresh to update connection status.'
      );
    } catch (e: any) {
      Alert.alert(
        'Connection Error',
        e?.response?.data?.message || e?.message || 'Failed to open Outlook connection flow.'
      );
    } finally {
      setOutlookBusy(false);
    }
  };

  const disconnectOutlookCalendar = () => {
    if (outlookBusy) return;
    Alert.alert('Disconnect Outlook', 'Disconnect your Outlook calendar from this CRM account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setOutlookBusy(true);
              await crmTaskApi.disconnectOutlookCalendar();
              await fetchOutlookStatus();
            } catch (e: any) {
              Alert.alert(
                'Disconnect Failed',
                e?.response?.data?.message || e?.message || 'Failed to disconnect Outlook calendar.'
              );
            } finally {
              setOutlookBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const openCalendarSyncModal = () => {
    if (!outlookStatus.connected) {
      Alert.alert('Outlook Not Connected', 'Connect your Outlook calendar first.');
      return;
    }
    if (openTasks.length === 0) {
      Alert.alert('No Tasks', 'There are no open tasks to sync.');
      return;
    }

    setCalendarSyncSearchText('');
    setCalendarSyncStatusFilter('all');
    setCalendarSyncSelectedTaskIds(openTasks.map((task) => task._id).filter(Boolean));
    setCalendarSyncModalVisible(true);
  };

  const closeCalendarSyncModal = useCallback(() => {
    if (outlookBulkSyncing) return;
    setCalendarSyncModalVisible(false);
  }, [outlookBulkSyncing]);

  const toggleCalendarSyncTask = useCallback((taskId: string) => {
    setCalendarSyncSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  }, []);

  const markFilteredCalendarSyncTasks = useCallback(() => {
    setCalendarSyncSelectedTaskIds((prev) => {
      const merged = new Set(prev);
      for (const task of calendarSyncFilteredTasks) {
        if (task._id) merged.add(task._id);
      }
      return Array.from(merged);
    });
  }, [calendarSyncFilteredTasks]);

  const clearFilteredCalendarSyncTasks = useCallback(() => {
    const filteredIds = new Set(calendarSyncFilteredTasks.map((task) => task._id).filter(Boolean));
    setCalendarSyncSelectedTaskIds((prev) => prev.filter((taskId) => !filteredIds.has(taskId)));
  }, [calendarSyncFilteredTasks]);

  const syncSelectedTasksToOutlookCalendar = useCallback(async () => {
    if (!outlookStatus.connected) {
      Alert.alert('Outlook Not Connected', 'Connect your Outlook calendar first.');
      return;
    }

    if (calendarSyncSelectedTaskIds.length === 0) {
      Alert.alert('No Tasks Selected', 'Select at least one task to sync to calendar.');
      return;
    }

    try {
      setOutlookBulkSyncing(true);
      const result = await crmTaskApi.addTasksToOutlookCalendarBulk(calendarSyncSelectedTaskIds);
      const failedHint =
        result.failedCount > 0
          ? `\n\n${result.failedCount} failed. ${result.failed[0]?.reason || 'Check your task dates and try again.'}`
          : '';
      const pendingHint = result.pendingCount > 0
        ? `\n\n${result.pendingCount} queued, not yet confirmed by Outlook.` : '';
      setCalendarSyncModalVisible(false);
      Alert.alert(
        result.pendingCount > 0 ? 'Outlook sync queued' : 'Outlook Sync Complete',
        `${result.createdCount} task(s) added to calendar.${pendingHint}${failedHint}`
      );
    } catch (e: any) {
      Alert.alert(
        'Bulk Sync Failed',
        e?.response?.data?.message || e?.message || 'Failed to sync tasks to Outlook calendar.'
      );
    } finally {
      setOutlookBulkSyncing(false);
    }
  }, [calendarSyncSelectedTaskIds, outlookStatus.connected]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#0284C7"
            colors={['#0284C7']}
          />
        }>
        <View style={[styles.heroCard, isCompact && styles.heroCardCompact]}>
          <View style={styles.heroGlow} />
          <View style={styles.heroTopRow}>
            <View style={styles.heroTopLeft}>
              <TouchableOpacity onPress={onOpenDrawer} style={styles.menuBtn}>
                <Feather name="menu" size={22} color="#fff" />
              </TouchableOpacity>
              <View>
                <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                  Outlook Calendar
                </Text>
                <Text style={styles.heroGreeting}>
                  {displayName}
                </Text>
              </View>
            </View>
            <View style={styles.heroActions}>
              <TouchableOpacity onPress={onBack} style={styles.backBtn}>
                <Feather name="arrow-left" size={20} color="rgba(255,255,255,0.95)" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.calendarCard}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardIconWrap}>
              <Feather name="calendar" size={22} color="#0284C7" />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Outlook Calendar</Text>
              <Text style={styles.cardSubtitle}>
                Sync selected CRM tasks when you need calendar reminders.
              </Text>
            </View>
          </View>

          {outlookStatusLoading ? (
            <View style={styles.statusLoadingRow}>
              <ActivityIndicator size="small" color="#0284C7" />
              <Text style={styles.statusText}>Checking connection...</Text>
            </View>
          ) : (
            <View style={[styles.statusPill, outlookStatus.connected ? styles.statusPillConnected : styles.statusPillOff]}>
              <Feather
                name={outlookStatus.connected ? 'check-circle' : 'alert-circle'}
                size={16}
                color={outlookStatus.connected ? '#047857' : '#B45309'}
              />
              <Text
                style={[
                  styles.statusPillText,
                  outlookStatus.connected ? styles.statusPillTextConnected : styles.statusPillTextOff,
                ]}>
                {!outlookStatus.configured
                  ? 'Server setup missing'
                  : outlookStatus.connected
                    ? `Connected${outlookStatus.email ? ` as ${outlookStatus.email}` : ''}`
                    : 'Not connected'}
              </Text>
            </View>
          )}

          <View style={styles.actionGrid}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.refreshBtn]}
              onPress={() => void fetchOutlookStatus(true)}
              disabled={outlookStatusLoading || outlookBusy}>
              <Feather name="refresh-cw" size={17} color="#7C2D12" />
              <Text style={styles.refreshBtnText}>Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                outlookStatus.connected ? styles.disconnectBtn : styles.connectBtn,
              ]}
              onPress={outlookStatus.connected ? disconnectOutlookCalendar : () => void connectOutlookCalendar()}
              disabled={outlookStatusLoading || outlookBusy || !outlookStatus.configured}>
              {outlookBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Feather name={outlookStatus.connected ? 'x-circle' : 'link'} size={17} color="#fff" />
              )}
              <Text style={styles.actionBtnText}>{outlookStatus.connected ? 'Disconnect' : 'Connect'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[
              styles.syncBtn,
              (!outlookStatus.connected || loading || openTasks.length === 0 || outlookBulkSyncing) &&
                styles.syncBtnDisabled,
            ]}
            onPress={openCalendarSyncModal}
            disabled={!outlookStatus.connected || loading || openTasks.length === 0 || outlookBulkSyncing}>
            <Feather name="check-square" size={18} color="#fff" />
            <Text style={styles.syncBtnText}>Pick Tasks to Sync</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Open tasks available</Text>
          {loading ? (
            <ActivityIndicator size="small" color="#0284C7" />
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <Text style={styles.summaryCount}>{openTasks.length}</Text>
          )}
          <Text style={styles.summaryText}>
            Calendar sync is available for tasks that are still open and have enough due-date detail.
          </Text>
        </View>
      </ScrollView>

      <Modal
        visible={calendarSyncModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeCalendarSyncModal}>
        <CrmModalFrame label="Calendar task selection" onClose={closeCalendarSyncModal}
          cardStyle={[styles.calendarSyncModalCard, isVeryCompact && styles.calendarSyncModalCardVeryCompact]}>
            <View style={styles.modalHeader}>
              <View style={styles.calendarSyncHeaderTextWrap}>
                <Text style={styles.modalTitle}>Sync Tasks to Calendar</Text>
                <Text style={styles.calendarSyncSummaryText}>
                  {calendarSyncSelectedCount} selected of {tasks.length}
                </Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close calendar sync" accessibilityState={{ disabled: outlookBulkSyncing }} style={crmTouchTarget} onPress={closeCalendarSyncModal} disabled={outlookBulkSyncing}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <View style={styles.calendarSyncSearchRow}>
              <Feather name="search" size={16} color="#92400E" />
              <TextInput
                style={styles.calendarSyncSearchInput}
                value={calendarSyncSearchText}
                accessibilityLabel="Search calendar tasks"
                onChangeText={setCalendarSyncSearchText}
                placeholder="Search client, company, email, phone"
                placeholderTextColor="#9CA3AF"
                editable={!outlookBulkSyncing}
              />
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.calendarSyncFilterRow}>
              {STATUS_OPTIONS.map((option) => {
                const active = calendarSyncStatusFilter === option.key;
                return (
                  <TouchableOpacity
                    key={`calendar-sync-${option.key}`}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: active, disabled: outlookBulkSyncing }}
                    style={[
                      styles.calendarSyncFilterChip,
                      crmTouchTarget,
                      active && styles.calendarSyncFilterChipActive,
                    ]}
                    onPress={() => setCalendarSyncStatusFilter(option.key)}
                    disabled={outlookBulkSyncing}>
                    <Text
                      style={[
                        styles.calendarSyncFilterChipText,
                        active && styles.calendarSyncFilterChipTextActive,
                      ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.calendarSyncQuickActions}>
              <TouchableOpacity
                style={styles.calendarSyncQuickBtn}
                accessibilityRole="button"
                accessibilityLabel="Mark filtered calendar tasks"
                onPress={markFilteredCalendarSyncTasks}
                disabled={outlookBulkSyncing || calendarSyncFilteredTasks.length === 0}>
                <Text style={styles.calendarSyncQuickBtnText}>Mark Filtered</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.calendarSyncQuickBtn, styles.calendarSyncQuickBtnClear]}
                accessibilityRole="button"
                accessibilityLabel="Clear filtered calendar tasks"
                onPress={clearFilteredCalendarSyncTasks}
                disabled={outlookBulkSyncing || calendarSyncFilteredTasks.length === 0}>
                <Text style={styles.calendarSyncQuickBtnText}>Clear Filtered</Text>
              </TouchableOpacity>
            </View>

            {calendarSyncFilteredTasks.length === 0 ? (
              <View style={styles.calendarSyncEmptyWrap}>
                <Feather name="calendar" size={24} color="#94A3B8" />
                <Text style={styles.emptySubtitle}>No tasks match the current search or filter.</Text>
              </View>
            ) : (
              <ScrollView style={styles.calendarSyncTaskList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {calendarSyncFilteredTasks.map((task) => {
                  const selected = calendarSyncSelectedTaskIds.includes(task._id);
                  const badge = getStatusBadge(task.status);
                  return (
                    <TouchableOpacity
                      key={`calendar-sync-row-${task._id}`}
                      accessibilityRole="checkbox"
                      accessibilityLabel={task.clientName || 'Client'}
                      accessibilityState={{ checked: selected, disabled: outlookBulkSyncing }}
                      style={[
                        styles.calendarSyncTaskRow,
                        selected && styles.calendarSyncTaskRowSelected,
                      ]}
                      onPress={() => toggleCalendarSyncTask(task._id)}
                      disabled={outlookBulkSyncing}>
                      <View
                        style={[
                          styles.calendarSyncCheckbox,
                          selected && styles.calendarSyncCheckboxSelected,
                        ]}>
                        {selected ? <Feather name="check" size={14} color="#fff" /> : null}
                      </View>
                      <View style={styles.calendarSyncTaskBody}>
                        <View style={styles.calendarSyncTaskTopRow}>
                          <Text style={styles.calendarSyncTaskTitle} numberOfLines={1}>
                            {task.clientName || 'Client'}
                          </Text>
                          <View style={[styles.calendarSyncStatusBadge, { backgroundColor: badge.bg }]}>
                            <Text style={[styles.calendarSyncStatusBadgeText, { color: badge.text }]}>
                              {statusText(task.status)}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.calendarSyncTaskMeta} numberOfLines={1}>
                          {task.companyName || task.email || 'No company or email'}
                        </Text>
                        <Text style={styles.calendarSyncTaskMeta} numberOfLines={1}>
                          Due {formatDate(task.dueDate)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel calendar sync"
                onPress={closeCalendarSyncModal}
                disabled={outlookBulkSyncing}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Sync selected tasks"
                accessibilityState={{ disabled: !outlookStatus.connected || outlookBulkSyncing || calendarSyncSelectedCount === 0, busy: outlookBulkSyncing }}
                style={[
                  styles.submitBtn,
                  (!outlookStatus.connected || calendarSyncSelectedCount === 0) &&
                    styles.submitBtnDisabled,
                ]}
                onPress={() => void syncSelectedTasksToOutlookCalendar()}
                disabled={!outlookStatus.connected || outlookBulkSyncing || calendarSyncSelectedCount === 0}>
                {outlookBulkSyncing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Sync Selected</Text>
                )}
              </TouchableOpacity>
            </View>
        </CrmModalFrame>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F0F4F8',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
    gap: 14,
  },
  scrollContentCompact: {
    paddingHorizontal: 12,
  },
  heroCard: {
    borderRadius: 28,
    padding: 22,
    backgroundColor: '#0284C7',
    overflow: 'hidden',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 12,
  },
  heroCardCompact: {
    borderRadius: 24,
    padding: 18,
  },
  heroGlow: {
    position: 'absolute',
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: 'rgba(255,255,255,0.18)',
    top: -72,
    right: -42,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroTopLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flex: 1,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: 27,
    fontWeight: '900',
    color: '#fff',
  },
  heroTitleCompact: {
    fontSize: 22,
  },
  heroGreeting: {
    color: 'rgba(255,255,255,0.84)',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3,
  },
  calendarCard: {
    borderRadius: 22,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  cardIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#E0F2FE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
  },
  cardSubtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
    color: '#64748B',
  },
  statusLoadingRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '700',
  },
  statusPill: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  statusPillConnected: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  statusPillOff: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  statusPillText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
  },
  statusPillTextConnected: {
    color: '#047857',
  },
  statusPillTextOff: {
    color: '#92400E',
  },
  actionGrid: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  refreshBtn: {
    backgroundColor: '#FBBF24',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  refreshBtnText: {
    color: '#7C2D12',
    fontSize: 14,
    fontWeight: '900',
  },
  connectBtn: {
    backgroundColor: '#059669',
  },
  disconnectBtn: {
    backgroundColor: '#B91C1C',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  syncBtn: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 15,
    backgroundColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  syncBtnDisabled: {
    backgroundColor: '#BAE6FD',
    opacity: 0.72,
  },
  syncBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  summaryCard: {
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
  },
  summaryTitle: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryCount: {
    marginTop: 8,
    fontSize: 38,
    color: '#0F172A',
    fontWeight: '900',
  },
  summaryText: {
    marginTop: 6,
    color: '#64748B',
    fontSize: 13,
    lineHeight: 19,
  },
  errorText: {
    color: '#B91C1C',
    fontSize: 13,
  },
  centerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  centerModalOverlayVeryCompact: {
    padding: 8,
  },
  calendarSyncModalCardVeryCompact: {
    borderRadius: 14,
    padding: 10,
  },
  calendarSyncModalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    maxHeight: '86%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    flexShrink: 1,
    fontSize: 18,
    fontWeight: '900',
    color: '#111827',
  },
  calendarSyncHeaderTextWrap: {
    flex: 1,
    paddingRight: 12,
  },
  calendarSyncSummaryText: {
    marginTop: 2,
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '700',
  },
  calendarSyncSearchRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    paddingHorizontal: 12,
    minHeight: 44,
  },
  calendarSyncSearchInput: {
    flex: 1,
    color: '#111827',
    fontSize: 13,
    fontWeight: '700',
  },
  calendarSyncFilterRow: {
    paddingTop: 12,
    gap: 8,
  },
  calendarSyncFilterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  calendarSyncFilterChipActive: {
    backgroundColor: '#FBBF24',
    borderColor: '#F59E0B',
  },
  calendarSyncFilterChipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
  },
  calendarSyncFilterChipTextActive: {
    color: '#7C2D12',
  },
  calendarSyncQuickActions: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  calendarSyncQuickBtn: {
    minHeight: 44,
    flex: 1,
    borderRadius: 12,
    backgroundColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarSyncQuickBtnClear: {
    backgroundColor: '#64748B',
  },
  calendarSyncQuickBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  calendarSyncEmptyWrap: {
    minHeight: 170,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  emptySubtitle: {
    color: '#64748B',
    textAlign: 'center',
    fontSize: 13,
  },
  calendarSyncTaskList: {
    marginTop: 12,
    maxHeight: 340,
  },
  calendarSyncTaskRow: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F8FAFC',
    padding: 10,
    marginBottom: 8,
  },
  calendarSyncTaskRowSelected: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
  },
  calendarSyncCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  calendarSyncCheckboxSelected: {
    backgroundColor: '#0284C7',
    borderColor: '#0284C7',
  },
  calendarSyncTaskBody: {
    flex: 1,
    minWidth: 0,
  },
  calendarSyncTaskTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  calendarSyncTaskTitle: {
    flex: 1,
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '900',
  },
  calendarSyncTaskMeta: {
    marginTop: 3,
    color: '#64748B',
    fontSize: 11,
    fontWeight: '600',
  },
  calendarSyncStatusBadge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  calendarSyncStatusBadgeText: {
    fontSize: 10,
    fontWeight: '900',
  },
  modalFooterRow: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    minHeight: 44,
    minWidth: 100,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
  },
  cancelBtnText: {
    color: '#374151',
    fontWeight: '800',
  },
  submitBtn: {
    flex: 1,
    minHeight: 44,
    minWidth: 100,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#16A34A',
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    backgroundColor: '#86EFAC',
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '900',
    textAlign: 'center',
  },
});
