import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  TextInput,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Feather } from "@expo/vector-icons";
import Svg, { Circle, G, Path, Defs, RadialGradient, Stop } from "react-native-svg";
import crmTaskApi, {
  CRM_OPEN_STATUSES,
  CRM_SPECIALIZATION_OPTIONS,
  CRM_STATUS_LABELS,
  CrmSpecializationValue,
  CrmTaskItem,
  CrmTaskStatus,
} from "../services/crmService";
import type { CrmDashboardTaskFilter } from "../services/crmService";
import { useAuth } from "../context/AuthContext";
import { useNotifications } from "../context/NotificationContext";
import NotificationCenterModal from "../components/NotificationCenterModal";
import { NotificationItem } from "../services/notificationService";
import CrmModalFrame, { crmTouchTarget } from "../components/crm/CrmModalFrame";

interface CrmDashboardScreenProps {
  onOpenDrawer: () => void;
  onOpenTasks: (target?: { taskId?: string | null; filter?: CrmDashboardTaskFilter | null; status?: CrmTaskStatus | null }) => void;
}

type StatusMeta = {
  key: CrmTaskStatus;
  label: string;
  color: string;
};

type PieSlice = {
  key: CrmTaskStatus;
  color: string;
  startAngle: number;
  endAngle: number;
};

const STATUS_META: StatusMeta[] = [
  { key: "new_lead", label: "New Lead", color: "#0EA5E9" },
  { key: "contacted", label: "Contacted", color: "#2563EB" },
  { key: "inspection_required", label: "Inspection Required", color: "#F59E0B" },
  { key: "inspection_complete", label: "Inspection Complete", color: "#6366F1" },
  { key: "proposal_submitted", label: "Proposal Submitted", color: "#EC4899" },
  { key: "decision_pending", label: "Decision Pending", color: "#7C3AED" },
  { key: "won", label: "Won", color: "#16A34A" },
  { key: "lost", label: "Lost", color: "#EF4444" },
];

function formatDate(value?: string): string {
  if (!value) return "No due date";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "No due date";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDefaultQuickAddDueDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(17, 0, 0, 0);
  return date;
}

function formatQuickAddDueDate(value: Date): string {
  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function specializationLabel(value?: string): string {
  return CRM_SPECIALIZATION_OPTIONS.find((option) => option.value === value)?.label || "";
}

function toPolar(cx: number, cy: number, radius: number, angle: number) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = toPolar(cx, cy, radius, endAngle);
  const end = toPolar(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? "1" : "0";
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

function statusLabel(status: CrmTaskStatus): string {
  return CRM_STATUS_LABELS[status] || status;
}

const CrmDashboardScreen = ({ onOpenDrawer, onOpenTasks }: CrmDashboardScreenProps) => {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isCompact = width < 380;
  const isVeryCompact = width < 340;
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
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [tasks, setTasks] = useState<CrmTaskItem[]>([]);
  const [leadSourceCounts, setLeadSourceCounts] = useState({ total: 0, generic: 0, organic: 0 });
  const [serverStatusCounts, setServerStatusCounts] = useState<Record<CrmTaskStatus, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddName, setQuickAddName] = useState("");
  const [quickAddPhone, setQuickAddPhone] = useState("");
  const [quickAddSpecialization, setQuickAddSpecialization] = useState<CrmSpecializationValue | "">("");
  const [quickAddDueDate, setQuickAddDueDate] = useState<Date>(() => getDefaultQuickAddDueDate());
  const [showQuickAddDuePicker, setShowQuickAddDuePicker] = useState(false);
  const [quickAddNotes, setQuickAddNotes] = useState("");
  const [quickAdding, setQuickAdding] = useState(false);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const displayName = user?.username || user?.email?.split("@")[0] || "there";

  const fetchTasks = useCallback(async () => {
    try {
      setError(null);
      const response = await crmTaskApi.getMyTasks({ status: "all", page: 1, limit: 200 });
      setTasks(Array.isArray(response.items) ? response.items : []);
      const nextStatusCounts = Object.fromEntries(
        STATUS_META.map((meta) => [meta.key, 0])
      ) as Record<CrmTaskStatus, number>;
      for (const entry of response.statusCounts || []) {
        const key = String(entry?._id || entry?.status || "") as CrmTaskStatus;
        if (nextStatusCounts[key] !== undefined) {
          nextStatusCounts[key] = Number(entry?.count || 0);
        }
      }
      setServerStatusCounts(nextStatusCounts);
      setLeadSourceCounts({
        total: Number(response.leadSourceCounts?.total || response.total || 0),
        generic: Number(response.leadSourceCounts?.generic || 0),
        organic: Number(response.leadSourceCounts?.organic || 0),
      });
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || "Failed to load CRM dashboard");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchTasks();
  }, [fetchTasks]);

  const handleOpenNotification = useCallback(
    async (notification: NotificationItem) => {
      setNotifPanelOpen(false);
      await openNotification(notification);
    },
    [openNotification]
  );

  const resetQuickAdd = useCallback(() => {
    setQuickAddName("");
    setQuickAddPhone("");
    setQuickAddSpecialization("");
    setQuickAddDueDate(getDefaultQuickAddDueDate());
    setShowQuickAddDuePicker(false);
    setQuickAddNotes("");
  }, []);

  const handleQuickAddDueDateChange = useCallback((_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS !== "ios") {
      setShowQuickAddDuePicker(false);
    }
    if (!selectedDate) return;
    const nextDate = new Date(selectedDate);
    nextDate.setHours(17, 0, 0, 0);
    setQuickAddDueDate(nextDate);
  }, []);

  const submitQuickAdd = useCallback(async () => {
    if (!quickAddName.trim() || !quickAddPhone.trim() || !quickAddSpecialization) {
      Alert.alert("Missing details", "Name, phone number, and CRM specialization are required.");
      return;
    }

    try {
      setQuickAdding(true);
      await crmTaskApi.quickAddLead({
        name: quickAddName.trim(),
        phone: quickAddPhone.trim(),
        specialization: quickAddSpecialization,
        category: specializationLabel(quickAddSpecialization),
        dueDate: quickAddDueDate.toISOString(),
        notes: quickAddNotes.trim(),
      });
      resetQuickAdd();
      setQuickAddOpen(false);
      await fetchTasks();
      Alert.alert("Lead added", "Organic quick-add lead created.");
    } catch (e: any) {
      Alert.alert("Quick add failed", e?.response?.data?.message || e?.message || "Failed to create lead.");
    } finally {
      setQuickAdding(false);
    }
  }, [fetchTasks, quickAddDueDate, quickAddName, quickAddNotes, quickAddPhone, quickAddSpecialization, resetQuickAdd]);

  const now = useMemo(() => new Date(), []);

  const statusCounts = useMemo(() => {
    if (serverStatusCounts) return serverStatusCounts;

    const counts = Object.fromEntries(
      STATUS_META.map((meta) => [meta.key, 0])
    ) as Record<CrmTaskStatus, number>;

    for (const task of tasks) {
      if (counts[task.status] !== undefined) {
        counts[task.status] += 1;
      }
    }

    return counts;
  }, [serverStatusCounts, tasks]);

  const total = leadSourceCounts.total || tasks.length;

  const pieSlices = useMemo(() => {
    if (!total) return [] as PieSlice[];

    let cursor = 0;
    const slices: PieSlice[] = [];
    for (const status of STATUS_META) {
      const value = statusCounts[status.key];
      if (!value) continue;
      const angle = (value / total) * 360;
      slices.push({
        key: status.key,
        color: status.color,
        startAngle: cursor,
        endAngle: cursor + angle,
      });
      cursor += angle;
    }

    return slices;
  }, [statusCounts, total]);

  const unfinishedTasks = useMemo(
    () => tasks.filter((task) => CRM_OPEN_STATUSES.includes(task.status)),
    [tasks]
  );

  const overdueTasks = useMemo(() => {
    return unfinishedTasks
      .filter((task) => {
        if (!task.dueDate) return false;
        const due = new Date(task.dueDate);
        return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
      })
      .sort((a, b) => new Date(a.dueDate || 0).getTime() - new Date(b.dueDate || 0).getTime());
  }, [unfinishedTasks, now]);

  const upcomingTasks = useMemo(() => {
    const nextWeek = now.getTime() + 7 * 24 * 60 * 60 * 1000;
    return unfinishedTasks
      .filter((task) => {
        if (!task.dueDate) return false;
        const due = new Date(task.dueDate);
        if (!Number.isFinite(due.getTime())) return false;
        return due.getTime() >= now.getTime() && due.getTime() <= nextWeek;
      })
      .sort((a, b) => new Date(a.dueDate || 0).getTime() - new Date(b.dueDate || 0).getTime());
  }, [unfinishedTasks, now]);

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={["top"]}>
        <ActivityIndicator size="large" color="#0284C7" />
      </SafeAreaView>
    );
  }

  const PIE_SIZE = isVeryCompact ? 118 : isCompact ? 150 : 180;
  const PIE_R = isVeryCompact ? 49 : isCompact ? 64 : 76;
  const PIE_INNER = isVeryCompact ? 23 : isCompact ? 30 : 36;
  const PIE_CX = PIE_SIZE / 2;
  const PIE_CY = PIE_SIZE / 2;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact, isVeryCompact && styles.scrollContentVeryCompact]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Hero */}
        <View style={[styles.heroCard, isVeryCompact && styles.heroCardVeryCompact]}>
          <View style={styles.heroGlow} />
          <View style={styles.heroDepth} />
          <View style={styles.heroTopRow}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open menu" onPress={onOpenDrawer} style={styles.menuBtn}>
              <Feather name="menu" size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.heroTextWrap}>
              <Text style={[styles.heroTitle, isCompact && { fontSize: 20 }, isVeryCompact && { fontSize: 17 }]}>CRM Dashboard</Text>
              <Text style={[styles.heroGreeting, isCompact && { fontSize: 13 }, isVeryCompact && { fontSize: 11 }]}>
                {greeting}, <Text style={styles.heroName}>{displayName}</Text>
              </Text>
              <Text style={[styles.heroSubtitle, isCompact && { fontSize: 11 }, isVeryCompact && { fontSize: 10 }]}>Overview, alerts & upcoming tasks.</Text>
            </View>
            <View style={styles.heroActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Notifications, ${unreadCount} unread`} onPress={() => setNotifPanelOpen(true)} style={styles.notifBtn} activeOpacity={0.8}>
                <Feather name="bell" size={20} color="#fff" />
                {unreadCount > 0 ? (
                  <View style={styles.notifBadge}>
                    <Text style={styles.notifBadgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            </View>
          </View>
          <View style={[styles.heroBtnRow, isVeryCompact && styles.heroBtnRowVeryCompact]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open task page" style={[styles.taskBoardBtn, isCompact && styles.fullWidthHeroAction, isVeryCompact && styles.heroBtnVeryCompact]} onPress={() => onOpenTasks({ filter: "all" })} activeOpacity={0.85}>
              <Feather name="phone-call" size={isVeryCompact ? 13 : 15} color="#0C4A6E" />
              <Text style={[styles.taskBoardBtnText, isVeryCompact && styles.heroBtnTextVeryCompact]}>{isVeryCompact ? "Tasks" : "Open Task Page"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.refreshBtn, isVeryCompact && styles.heroBtnVeryCompact]}
              accessibilityRole="button"
              accessibilityLabel="Refresh dashboard"
              accessibilityState={{ disabled: refreshing, busy: refreshing }}
              onPress={onRefresh}
              activeOpacity={0.85}
              disabled={refreshing}
            >
              <Feather name="refresh-cw" size={isVeryCompact ? 13 : 15} color="#0C4A6E" />
              <Text style={[styles.taskBoardBtnText, isVeryCompact && styles.heroBtnTextVeryCompact]}>{refreshing ? "..." : "Refresh"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.quickAddBtn, isVeryCompact && styles.heroBtnVeryCompact]}
              accessibilityRole="button"
              accessibilityLabel="Quick Add lead"
              onPress={() => setQuickAddOpen(true)}
              activeOpacity={0.85}
            >
              <Feather name="plus-circle" size={isVeryCompact ? 13 : 15} color="#0C4A6E" />
              <Text style={[styles.taskBoardBtnText, isVeryCompact && styles.heroBtnTextVeryCompact]}>{isVeryCompact ? "Add" : "Quick Add"}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Stat Cards — tap to open task page */}
        <View style={styles.statsRow}>
          <TouchableOpacity style={[styles.statCard, styles.statCardBlue, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ filter: "all" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#0369A1" }, isVeryCompact && styles.statValueVeryCompact]}>{total}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Total Leads</Text>
            <Feather name="chevron-right" size={10} color="#93C5FD" style={styles.statChevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.statCard, styles.statCardPurple, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ filter: "generic" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#6D28D9" }, isVeryCompact && styles.statValueVeryCompact]}>{leadSourceCounts.generic}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Generic</Text>
            <Feather name="chevron-right" size={10} color="#C4B5FD" style={styles.statChevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.statCard, styles.statCardAmber, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ filter: "organic" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#B45309" }, isVeryCompact && styles.statValueVeryCompact]}>{leadSourceCounts.organic}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Organic</Text>
            <Feather name="chevron-right" size={10} color="#FCD34D" style={styles.statChevron} />
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <TouchableOpacity style={[styles.statCard, styles.statCardGreen, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ filter: "upcoming" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#047857" }, isVeryCompact && styles.statValueVeryCompact]}>{upcomingTasks.length}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Upcoming</Text>
            <Feather name="chevron-right" size={10} color="#6EE7B7" style={styles.statChevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.statCard, styles.statCardRed, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ filter: "overdue" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#B91C1C" }, isVeryCompact && styles.statValueVeryCompact]}>{overdueTasks.length}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Overdue</Text>
            <Feather name="chevron-right" size={10} color="#FCA5A5" style={styles.statChevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.statCard, styles.statCardRose, isVeryCompact && styles.statCardVeryCompact]} onPress={() => onOpenTasks({ status: "lost" })} activeOpacity={0.8}>
            <View style={styles.statGlow} />
            <Text style={[styles.statValue, { color: "#DC2626" }, isVeryCompact && styles.statValueVeryCompact]}>{statusCounts.lost}</Text>
            <Text style={[styles.statLabel, isVeryCompact && styles.statLabelVeryCompact]}>Lost</Text>
            <Feather name="chevron-right" size={10} color="#FDA4AF" style={styles.statChevron} />
          </TouchableOpacity>
        </View>

        {/* Pie Chart */}
        <View style={[styles.chartCard, isVeryCompact && styles.chartCardVeryCompact]}>
          <View style={styles.cardDepth} />
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIconWrap}>
              <Feather name="pie-chart" size={16} color="#7C3AED" />
            </View>
            <Text style={styles.sectionTitle}>Status Breakdown</Text>
          </View>
          <View style={[styles.chartRow, isCompact && styles.chartRowCompact, isVeryCompact && styles.chartRowVeryCompact]}>
            <View style={[styles.pieWrap, { width: PIE_SIZE, height: PIE_SIZE }]}>
              <View style={styles.pieShadow} />
              <Svg width={PIE_SIZE} height={PIE_SIZE}>
                <Defs>
                  <RadialGradient id="pglow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor="#E0E7FF" stopOpacity="0.6" />
                    <Stop offset="100%" stopColor="#E5E7EB" stopOpacity="1" />
                  </RadialGradient>
                </Defs>
                <G>
                  <Circle cx={PIE_CX} cy={PIE_CY} r={PIE_R} fill="url(#pglow)" />
                  {pieSlices.map((slice) => (
                    <Path key={slice.key} d={describeArc(PIE_CX, PIE_CY, PIE_R, slice.startAngle, slice.endAngle)} fill={slice.color} />
                  ))}
                  <Circle cx={PIE_CX} cy={PIE_CY} r={PIE_R + 3} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={1.5} />
                  <Circle cx={PIE_CX} cy={PIE_CY} r={PIE_INNER} fill="#fff" />
                  <Circle cx={PIE_CX} cy={PIE_CY} r={PIE_INNER} fill="none" stroke="rgba(0,0,0,0.04)" strokeWidth={1} />
                </G>
              </Svg>
              <View style={styles.pieCenterLabel}>
                <Text style={[styles.pieCenterValue, isCompact && { fontSize: 18 }, isVeryCompact && styles.pieCenterValueVeryCompact]}>{total}</Text>
                <Text style={[styles.pieCenterText, isVeryCompact && styles.pieCenterTextVeryCompact]}>Tasks</Text>
              </View>
            </View>

            <View style={[styles.legendWrap, isCompact && styles.legendWrapCompact, isVeryCompact && styles.legendWrapVeryCompact]}>
              {STATUS_META.map((meta) => {
                const legendLabel = isVeryCompact ? statusLabel(meta.key) : meta.label;

                return (
                  <TouchableOpacity
                    key={meta.key}
                    style={[styles.legendRow, isVeryCompact && styles.legendRowVeryCompact]}
                    onPress={() => onOpenTasks({ status: meta.key })}
                    activeOpacity={0.75}
                  >
                    <View style={[styles.legendLabelWrap, isVeryCompact && styles.legendLabelWrapVeryCompact]}>
                      <View style={[styles.legendDot, isVeryCompact && styles.legendDotVeryCompact, { backgroundColor: meta.color }]} />
                      <Text
                        style={[styles.legendText, isCompact && styles.legendTextCompact, isVeryCompact && styles.legendTextVeryCompact]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {legendLabel}
                      </Text>
                    </View>
                    <View style={[styles.legendBadge, isVeryCompact && styles.legendBadgeVeryCompact, { backgroundColor: meta.color + "18" }]}>
                      <Text style={[styles.legendCount, isVeryCompact && styles.legendCountVeryCompact, { color: meta.color }]}>{statusCounts[meta.key]}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* Upcoming Tasks */}
        <View style={[styles.sectionCard, isVeryCompact && styles.sectionCardVeryCompact]}>
          <View style={styles.cardDepth} />
          <View style={styles.sectionHeader}>
            <View style={[styles.sectionIconWrap, { backgroundColor: "#D1FAE5" }]}>
              <Feather name="clock" size={16} color="#059669" />
            </View>
            <Text style={[styles.sectionTitle, isVeryCompact && styles.sectionTitleVeryCompact]}>Upcoming Tasks</Text>
            {upcomingTasks.length > 0 && (
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{upcomingTasks.length}</Text>
              </View>
            )}
          </View>
          {upcomingTasks.slice(0, 5).map((task) => (
            <TouchableOpacity key={task._id} style={[styles.itemRow, isVeryCompact && styles.itemRowVeryCompact]} onPress={() => onOpenTasks({ taskId: task._id })} activeOpacity={0.75}>
              <View style={[styles.itemDot, { backgroundColor: STATUS_META.find((m) => m.key === task.status)?.color || "#94A3B8" }]} />
              <View style={styles.itemBody}>
                <Text style={[styles.itemTitle, isVeryCompact && styles.itemTitleVeryCompact]} numberOfLines={1}>{task.clientName}</Text>
                <Text style={[styles.itemMeta, isVeryCompact && styles.itemMetaVeryCompact]} numberOfLines={1}>{task.companyName || statusLabel(task.status)}</Text>
              </View>
              <View style={styles.itemRight}>
                <Text style={[styles.itemDate, isVeryCompact && styles.itemDateVeryCompact]}>{formatDate(task.dueDate)}</Text>
                <Feather name="chevron-right" size={14} color="#94A3B8" />
              </View>
            </TouchableOpacity>
          ))}
          {upcomingTasks.length === 0 && <Text style={styles.emptyText}>No upcoming tasks in the next 7 days.</Text>}
        </View>

        {/* Alerts */}
        <View style={[styles.sectionCard, isVeryCompact && styles.sectionCardVeryCompact]}>
          <View style={styles.cardDepth} />
          <View style={styles.sectionHeader}>
            <View style={[styles.sectionIconWrap, { backgroundColor: "#FEE2E2" }]}>
              <Feather name="alert-triangle" size={16} color="#DC2626" />
            </View>
            <Text style={[styles.sectionTitle, isVeryCompact && styles.sectionTitleVeryCompact]}>Overdue Alerts</Text>
            {overdueTasks.length > 0 && (
              <View style={[styles.countBadge, { backgroundColor: "#FEE2E2" }]}>
                <Text style={[styles.countBadgeText, { color: "#DC2626" }]}>{overdueTasks.length}</Text>
              </View>
            )}
          </View>
          {overdueTasks.slice(0, 5).map((task) => (
            <TouchableOpacity key={task._id} style={[styles.itemRow, styles.itemRowAlert, isVeryCompact && styles.itemRowVeryCompact]} onPress={() => onOpenTasks({ taskId: task._id })} activeOpacity={0.75}>
              <View style={[styles.itemDot, { backgroundColor: "#EF4444" }]} />
              <View style={styles.itemBody}>
                <Text style={[styles.itemTitle, isVeryCompact && styles.itemTitleVeryCompact]} numberOfLines={1}>{task.clientName}</Text>
                <Text style={[styles.itemMeta, isVeryCompact && styles.itemMetaVeryCompact]} numberOfLines={1}>{task.companyName || statusLabel(task.status)}</Text>
              </View>
              <View style={styles.itemRight}>
                <Text style={[styles.itemDate, styles.alertText, isVeryCompact && styles.itemDateVeryCompact]}>{formatDate(task.dueDate)}</Text>
                <Feather name="chevron-right" size={14} color="#FCA5A5" />
              </View>
            </TouchableOpacity>
          ))}
          {overdueTasks.length === 0 && <Text style={styles.emptyText}>No overdue alerts. Great work!</Text>}
        </View>
      </ScrollView>

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
      <Modal visible={quickAddOpen} transparent animationType="fade" onRequestClose={() => !quickAdding && setQuickAddOpen(false)}>
        <CrmModalFrame label="Quick Add lead form" onClose={() => !quickAdding && setQuickAddOpen(false)}
          cardStyle={[styles.quickAddModal, isVeryCompact && styles.quickAddModalCompact]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.modalTitle}>Quick Add</Text>
                <Text style={styles.modalSubtitle}>Organic lead</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close Quick Add" accessibilityState={{ disabled: quickAdding }} disabled={quickAdding} onPress={() => setQuickAddOpen(false)} style={[styles.modalCloseBtn, crmTouchTarget]}>
                <Feather name="x" size={18} color="#334155" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={quickAddName}
              accessibilityLabel="Lead name"
              editable={!quickAdding}
              onChangeText={setQuickAddName}
              placeholder="Name"
              placeholderTextColor="#94A3B8"
            />
            <TextInput
              style={styles.input}
              value={quickAddPhone}
              accessibilityLabel="Lead phone number"
              editable={!quickAdding}
              onChangeText={setQuickAddPhone}
              placeholder="Phone number"
              placeholderTextColor="#94A3B8"
              keyboardType="phone-pad"
            />
            <Text style={styles.fieldLabel}>CRM specialization</Text>
            <View style={styles.specializationGrid}>
              {CRM_SPECIALIZATION_OPTIONS.map((option) => {
                const selected = quickAddSpecialization === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected, disabled: quickAdding }}
                    disabled={quickAdding}
                    onPress={() => setQuickAddSpecialization(option.value)}
                    style={[styles.specializationChip, crmTouchTarget, selected && styles.specializationChipActive]}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.specializationChipText, selected && styles.specializationChipTextActive]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.fieldLabel}>Due date</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Due date: ${formatQuickAddDueDate(quickAddDueDate)}`}
              accessibilityState={{ disabled: quickAdding, expanded: showQuickAddDuePicker }}
              disabled={quickAdding}
              style={styles.dateButton}
              onPress={() => setShowQuickAddDuePicker(true)}
              activeOpacity={0.8}
            >
              <Feather name="calendar" size={16} color="#0284C7" />
              <Text style={styles.dateButtonText}>{formatQuickAddDueDate(quickAddDueDate)}</Text>
            </TouchableOpacity>
            {showQuickAddDuePicker ? (
              <DateTimePicker
                value={quickAddDueDate}
                mode="date"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                onChange={handleQuickAddDueDateChange}
              />
            ) : null}
            <TextInput
              style={[styles.input, styles.notesInput]}
              value={quickAddNotes}
              accessibilityLabel="Lead notes"
              editable={!quickAdding}
              onChangeText={setQuickAddNotes}
              placeholder="Notes"
              placeholderTextColor="#94A3B8"
              multiline
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel Quick Add" accessibilityState={{ disabled: quickAdding }} disabled={quickAdding} onPress={() => setQuickAddOpen(false)} style={[styles.cancelBtn, crmTouchTarget]}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Create lead" accessibilityState={{ disabled: quickAdding, busy: quickAdding }} disabled={quickAdding} onPress={() => { void submitQuickAdd(); }} style={[styles.createBtn, crmTouchTarget, quickAdding && styles.disabledBtn]}>
                <Text style={styles.createBtnText}>{quickAdding ? "Creating..." : "Create"}</Text>
              </TouchableOpacity>
            </View>
        </CrmModalFrame>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F0F4F8",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F0F4F8",
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
    paddingTop: 12,
    paddingBottom: 24,
    gap: 10,
  },
  scrollContentVeryCompact: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 20,
    gap: 8,
  },
  heroCardVeryCompact: {
    borderRadius: 16,
    padding: 12,
  },
  heroCard: {
    borderRadius: 24,
    backgroundColor: "#0284C7",
    padding: 18,
    overflow: "hidden",
    shadowColor: "#0369A1",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 14,
  },
  heroGlow: {
    position: "absolute",
    width: 200,
    height: 200,
    right: -60,
    top: -70,
    borderRadius: 100,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  heroDepth: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: -10,
    height: 24,
    borderRadius: 14,
    backgroundColor: "rgba(2,44,84,0.28)",
  },
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  heroTextWrap: {
    flex: 1,
  },
  heroActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  notifBtn: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  notifBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#EF4444",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
    borderWidth: 1.5,
    borderColor: "#0284C7",
  },
  notifBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    textAlign: "center",
  },
  heroTitle: {
    fontSize: 23,
    fontWeight: "800",
    color: "#fff",
  },
  heroGreeting: {
    fontSize: 15,
    fontWeight: "700",
    color: "rgba(255,255,255,0.95)",
    marginTop: 3,
  },
  heroName: {
    fontWeight: "800",
    color: "#fff",
  },
  heroSubtitle: {
    fontSize: 12,
    color: "rgba(255,255,255,0.78)",
    marginTop: 2,
  },
  heroBtnRow: {
    marginTop: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  taskBoardBtn: {
    minHeight: 44,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "#FBBF24",
    shadowColor: "#B45309",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  refreshBtn: {
    minHeight: 44,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.95)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  quickAddBtn: {
    minHeight: 44,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "#A7F3D0",
    shadowColor: "#047857",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 4,
  },
  taskBoardBtnText: {
    color: "#0C4A6E",
    fontWeight: "700",
    fontSize: 13,
  },
  errorCard: {
    borderRadius: 14,
    backgroundColor: "#FEE2E2",
    borderWidth: 1,
    borderColor: "#FECACA",
    padding: 12,
  },
  errorText: {
    color: "#991B1B",
    fontSize: 13,
    fontWeight: "600",
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
  },
  statCard: {
    flex: 1,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 10,
    alignItems: "center",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  statCardBlue: {
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  statCardGreen: {
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#A7F3D0",
  },
  statCardRed: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  statCardRose: {
    backgroundColor: "#FFF1F2",
    borderWidth: 1,
    borderColor: "#FECDD3",
  },
  statCardPurple: {
    backgroundColor: "#F5F3FF",
    borderWidth: 1,
    borderColor: "#DDD6FE",
  },
  statCardAmber: {
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  statGlow: {
    position: "absolute",
    top: -20,
    right: -20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(255,255,255,0.6)",
  },
  statValue: {
    fontSize: 26,
    fontWeight: "900",
    color: "#0F172A",
  },
  statLabel: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 3,
    textAlign: "center",
    fontWeight: "600",
  },
  statChevron: {
    position: "absolute",
    right: 8,
    top: 8,
    opacity: 0.7,
  },
  chartCardVeryCompact: {
    borderRadius: 16,
    padding: 10,
  },
  chartCard: {
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 16,
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 5,
  },
  cardDepth: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: -8,
    height: 20,
    borderRadius: 14,
    backgroundColor: "rgba(15,23,42,0.05)",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  sectionIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "#EDE9FE",
    justifyContent: "center",
    alignItems: "center",
  },
  chartRow: {
    marginTop: 10,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  chartRowCompact: {
    gap: 10,
  },
  chartRowVeryCompact: {
    gap: 8,
    alignItems: "flex-start",
    flexWrap: "nowrap",
  },
  pieWrap: {
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  pieShadow: {
    position: "absolute",
    width: "90%",
    height: "90%",
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.04)",
    bottom: -4,
  },
  pieCenterLabel: {
    position: "absolute",
    justifyContent: "center",
    alignItems: "center",
  },
  pieCenterValue: {
    fontSize: 22,
    fontWeight: "900",
    color: "#0F172A",
  },
  pieCenterValueVeryCompact: {
    fontSize: 15,
  },
  pieCenterText: {
    fontSize: 10,
    color: "#6B7280",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  pieCenterTextVeryCompact: {
    fontSize: 8,
    letterSpacing: 0.25,
  },
  legendWrap: {
    flex: 1,
    gap: 7,
    minWidth: 0,
  },
  legendWrapCompact: {
    gap: 6,
  },
  legendWrapVeryCompact: {
    flex: 1,
    width: undefined,
    paddingHorizontal: 0,
    gap: 4,
    minWidth: 0,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minWidth: 0,
  },
  legendRowVeryCompact: {
    width: "auto",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#EEF2F7",
    backgroundColor: "#F8FAFC",
    paddingHorizontal: 6,
    paddingVertical: 5,
    minHeight: 30,
  },
  legendLabelWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingRight: 8,
  },
  legendLabelWrapVeryCompact: {
    gap: 5,
    paddingRight: 4,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 4,
  },
  legendDotVeryCompact: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  legendText: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    color: "#334155",
    fontSize: 13,
    fontWeight: "600",
  },
  legendTextCompact: {
    fontSize: 12,
  },
  legendTextVeryCompact: {
    fontSize: 9,
    lineHeight: 11,
  },
  legendBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 28,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  legendBadgeVeryCompact: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
  },
  legendCount: {
    fontSize: 12,
    fontWeight: "800",
  },
  legendCountVeryCompact: {
    fontSize: 9,
  },
  sectionCardVeryCompact: {
    borderRadius: 16,
    padding: 10,
  },
  sectionCard: {
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 16,
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0F172A",
  },
  sectionTitleVeryCompact: {
    fontSize: 14,
  },
  countBadge: {
    backgroundColor: "#E0F2FE",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: "auto",
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#0369A1",
  },
  itemRow: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F8FAFC",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  itemRowAlert: {
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
  },
  itemDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  itemBody: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  itemMeta: {
    fontSize: 12,
    color: "#6B7280",
    marginTop: 2,
  },
  itemRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  itemDate: {
    fontSize: 12,
    color: "#334155",
    fontWeight: "700",
  },
  alertText: {
    color: "#B91C1C",
  },
  emptyText: {
    marginTop: 10,
    color: "#6B7280",
    fontSize: 13,
  },
  heroBtnRowVeryCompact: {
    marginTop: 10,
    gap: 6,
  },
  fullWidthHeroAction: { flexBasis: '100%', flexGrow: 0 },
  heroBtnVeryCompact: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 5,
    borderRadius: 10,
  },
  heroBtnTextVeryCompact: {
    fontSize: 11,
  },
  statCardVeryCompact: {
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  statValueVeryCompact: {
    fontSize: 20,
  },
  statLabelVeryCompact: {
    fontSize: 10,
  },
  itemRowVeryCompact: {
    padding: 9,
    gap: 7,
  },
  itemTitleVeryCompact: {
    fontSize: 12,
  },
  itemMetaVeryCompact: {
    fontSize: 10,
  },
  itemDateVeryCompact: {
    fontSize: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.45)",
    justifyContent: "center",
    padding: 18,
  },
  quickAddModal: {
    borderRadius: 22,
    backgroundColor: "#fff",
    padding: 18,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 16,
  },
  quickAddModalCompact: {
    padding: 14,
    borderRadius: 18,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#0F172A",
  },
  modalSubtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "700",
    color: "#059669",
  },
  modalCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    minHeight: 46,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    paddingHorizontal: 13,
    marginBottom: 10,
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "600",
    backgroundColor: "#F8FAFC",
  },
  fieldLabel: {
    marginBottom: 8,
    fontSize: 12,
    fontWeight: "900",
    color: "#475569",
    textTransform: "uppercase",
  },
  specializationGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  },
  specializationChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#F8FAFC",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  specializationChipActive: {
    borderColor: "#0284C7",
    backgroundColor: "#E0F2FE",
  },
  specializationChipText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800",
  },
  specializationChipTextActive: {
    color: "#075985",
  },
  dateButton: {
    minHeight: 46,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    paddingHorizontal: 13,
    marginBottom: 10,
    backgroundColor: "#F8FAFC",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dateButtonText: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "800",
  },
  notesInput: {
    minHeight: 92,
    paddingTop: 12,
  },
  modalActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    minWidth: 100,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  cancelBtnText: {
    color: "#334155",
    fontWeight: "800",
  },
  createBtn: {
    flex: 1,
    minWidth: 100,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#16A34A",
  },
  disabledBtn: {
    opacity: 0.65,
  },
  createBtnText: {
    color: "#fff",
    fontWeight: "900",
  },
});

export default CrmDashboardScreen;
