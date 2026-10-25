/**
 * CRM Calendar (owner decision 2026-10-11): every lead on the follow-up date
 * the agent picked in Task Update, so a planned visit ("Curtis Metz, Oct 20")
 * sits on its day instead of in a stream of automatic reminders. A month view
 * with a dot per day that has follow-ups, the chosen day's list, and every
 * follow-up that has already passed. Tapping a lead opens its Task Update.
 * Reads GET /crm/tasks/follow-ups; CRM works online only (owner, 2026-10-11).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import crmTaskApi, { CRM_STATUS_LABELS, type CrmFollowUpCalendar, type CrmTaskItem } from '../services/crmService';
import { crmTouchTarget } from '../components/crm/CrmModalFrame';
import {
  buildMonthGrid,
  deviceTimeZone,
  formatFollowUp,
  formatFollowUpDate,
  formatFollowUpTime,
  groupFollowUpsByDate,
  localDate,
  localDateString,
} from '../services/crmFollowUp';

interface CrmCalendarScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  /** Opens CRM Tasks with this lead's Task Update. */
  onOpenTask: (taskId: string) => void;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function CrmCalendarScreen({ onOpenDrawer, onBack, onOpenTask }: CrmCalendarScreenProps) {
  const { width } = useWindowDimensions();
  const isCompact = width < 380;
  const today = localDateString(new Date());
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [calendar, setCalendar] = useState<CrmFollowUpCalendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest month's answer is shown when months are flipped quickly.
  const requestRef = useRef(0);

  const grid = useMemo(() => buildMonthGrid(month.year, month.month), [month]);
  const byDate = useMemo(() => groupFollowUpsByDate(calendar?.items || []), [calendar]);
  const monthTitle = useMemo(
    () => new Date(month.year, month.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    [month]
  );

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    const request = ++requestRef.current;
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);
    try {
      const next = await crmTaskApi.getFollowUps({ from: grid[0], to: grid[grid.length - 1], timeZone: deviceTimeZone() });
      if (request !== requestRef.current) return;
      setCalendar(next);
      setError(null);
    } catch (e: any) {
      if (request !== requestRef.current) return;
      setError(e?.response?.data?.message || 'Could not load your follow-ups. Check the connection and try again.');
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [grid]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const moveMonth = (delta: number) => {
    setMonth((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const goToToday = () => {
    const now = new Date();
    setMonth({ year: now.getFullYear(), month: now.getMonth() });
    setSelectedDate(localDateString(now));
  };

  const dayItems = byDate.get(selectedDate) || [];
  const overdue = calendar?.overdue || [];

  const renderRow = (item: CrmTaskItem, showDate: boolean) => {
    const when = showDate
      ? formatFollowUp(item.followUpDate || '', item.followUpTime)
      : item.followUpTime && item.followUpDate
        ? formatFollowUpTime(item.followUpDate, item.followUpTime)
        : 'All day';
    const name = item.clientName || item.title || 'CRM lead';
    return (
      <TouchableOpacity
        key={item._id}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${when}. Open Task Update`}
        onPress={() => onOpenTask(item._id)}
        activeOpacity={0.8}>
        <Text style={[styles.rowWhen, showDate && styles.rowWhenOverdue]}>{when}</Text>
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
          {item.companyName ? <Text style={styles.rowMeta} numberOfLines={1}>{item.companyName}</Text> : null}
          <Text style={styles.rowStatus}>{CRM_STATUS_LABELS[item.status] || item.status}</Text>
        </View>
        <Feather name="chevron-right" size={18} color="#94A3B8" />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor="#0284C7" colors={['#0284C7']} />}>
        <View style={[styles.heroCard, isCompact && styles.heroCardCompact]}>
          <View style={styles.heroGlow} />
          <View style={styles.heroTopRow}>
            <TouchableOpacity onPress={onOpenDrawer} style={styles.heroButton} accessibilityRole="button" accessibilityLabel="Open menu">
              <Feather name="menu" size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.heroTitles}>
              <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>CRM Calendar</Text>
              <Text style={styles.heroSubtitle}>Your follow-up dates</Text>
            </View>
            <TouchableOpacity onPress={onBack} style={styles.heroButton} accessibilityRole="button" accessibilityLabel="Back to CRM Tasks">
              <Feather name="arrow-left" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {error ? (
          <View style={styles.errorCard} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} accessibilityRole="button" onPress={() => void load('initial')}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {overdue.length > 0 ? (
          <View style={[styles.card, styles.overdueCard]} testID="crm-calendar-overdue">
            <View style={styles.cardHeader}>
              <Feather name="alert-circle" size={16} color="#B91C1C" />
              <Text style={[styles.cardTitle, styles.overdueTitle]}>Overdue follow-ups ({overdue.length})</Text>
            </View>
            <Text style={styles.cardHint}>Update the lead or pick a new date to stop the daily reminder.</Text>
            {overdue.map((item) => renderRow(item, true))}
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.monthHeader}>
            <TouchableOpacity style={styles.monthButton} accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => moveMonth(-1)}>
              <Feather name="chevron-left" size={20} color="#0F172A" />
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${monthTitle}. Go to today`} onPress={goToToday} style={styles.monthTitleButton}>
              <Text style={styles.monthTitle}>{monthTitle}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.monthButton} accessibilityRole="button" accessibilityLabel="Next month" onPress={() => moveMonth(1)}>
              <Feather name="chevron-right" size={20} color="#0F172A" />
            </TouchableOpacity>
          </View>
          <View style={styles.weekRow}>
            {WEEKDAYS.map((day, index) => (
              <Text key={`${day}-${index}`} style={styles.weekday} accessibilityLabel={WEEKDAY_NAMES[index]}>{day}</Text>
            ))}
          </View>
          <View style={styles.grid}>
            {grid.map((date) => {
              const count = byDate.get(date)?.length || 0;
              const inMonth = localDate(date).getMonth() === month.month;
              const selected = date === selectedDate;
              const isToday = date === today;
              return (
                <TouchableOpacity
                  key={date}
                  style={styles.cell}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${formatFollowUpDate(date)}${count ? `, ${count} follow-up${count === 1 ? '' : 's'}` : ''}`}
                  onPress={() => setSelectedDate(date)}>
                  <View style={[styles.dayCircle, isToday && styles.dayToday, selected && styles.daySelected]}>
                    <Text style={[styles.dayText, !inMonth && styles.dayTextOutside, selected && styles.dayTextSelected]}>
                      {localDate(date).getDate()}
                    </Text>
                  </View>
                  {count > 0 ? (
                    <View style={[styles.dot, selected && styles.dotSelected]}>
                      {count > 1 ? <Text style={styles.dotText}>{count}</Text> : null}
                    </View>
                  ) : <View style={styles.dotSpacer} />}
                </TouchableOpacity>
              );
            })}
          </View>
          {loading ? <ActivityIndicator style={styles.loading} color="#0284C7" /> : null}
        </View>

        <View style={styles.card} testID="crm-calendar-day">
          <View style={styles.cardHeader}>
            <Feather name="flag" size={16} color="#0369A1" />
            <Text style={styles.cardTitle}>{formatFollowUpDate(selectedDate)}</Text>
          </View>
          {dayItems.length > 0
            ? dayItems.map((item) => renderRow(item, false))
            : <Text style={styles.empty}>{loading ? 'Loading…' : 'No follow-ups on this day.'}</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F0F4F8' },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 36, gap: 14 },
  scrollContentCompact: { paddingHorizontal: 12 },
  heroCard: { borderRadius: 28, padding: 20, backgroundColor: '#0284C7', overflow: 'hidden' },
  heroCardCompact: { borderRadius: 24, padding: 16 },
  heroGlow: {
    position: 'absolute', width: 210, height: 210, borderRadius: 105,
    backgroundColor: 'rgba(255,255,255,0.18)', top: -72, right: -42,
  },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroButton: {
    width: 46, height: 46, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.18)',
    justifyContent: 'center', alignItems: 'center',
  },
  heroTitles: { flex: 1 },
  heroTitle: { fontSize: 24, fontWeight: '900', color: '#fff' },
  heroTitleCompact: { fontSize: 20 },
  heroSubtitle: { color: 'rgba(255,255,255,0.86)', fontSize: 13, fontWeight: '700', marginTop: 2 },
  card: {
    borderRadius: 20, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', padding: 14,
  },
  overdueCard: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  overdueTitle: { color: '#991B1B' },
  cardHint: { fontSize: 12, color: '#7F1D1D', marginBottom: 6 },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  monthButton: { ...crmTouchTarget, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F5F9' },
  monthTitleButton: { ...crmTouchTarget, justifyContent: 'center', paddingHorizontal: 8 },
  monthTitle: { fontSize: 17, fontWeight: '800', color: '#0F172A' },
  weekRow: { flexDirection: 'row' },
  weekday: { flexBasis: `${100 / 7}%`, textAlign: 'center', fontSize: 12, fontWeight: '700', color: '#64748B', paddingVertical: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { flexBasis: `${100 / 7}%`, alignItems: 'center', paddingVertical: 3, minHeight: 50 },
  dayCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dayToday: { borderWidth: 2, borderColor: '#0284C7' },
  daySelected: { backgroundColor: '#0284C7', borderColor: '#0284C7' },
  dayText: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  dayTextOutside: { color: '#CBD5E1' },
  dayTextSelected: { color: '#fff' },
  dot: {
    marginTop: 2, minWidth: 8, height: 8, borderRadius: 4, backgroundColor: '#F59E0B',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2,
  },
  dotSelected: { backgroundColor: '#0369A1' },
  dotText: { fontSize: 7, lineHeight: 8, color: '#fff', fontWeight: '800' },
  dotSpacer: { height: 10 },
  loading: { marginTop: 8 },
  row: {
    ...crmTouchTarget, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: '#F1F5F9',
  },
  rowWhen: { width: 78, fontSize: 12, fontWeight: '800', color: '#0369A1' },
  rowWhenOverdue: { color: '#B91C1C', width: 104 },
  rowBody: { flex: 1 },
  rowName: { fontSize: 14, fontWeight: '800', color: '#0F172A' },
  rowMeta: { fontSize: 12, color: '#475569', marginTop: 1 },
  rowStatus: { fontSize: 11, color: '#64748B', marginTop: 2, fontWeight: '700' },
  empty: { fontSize: 13, color: '#64748B', paddingVertical: 8 },
  errorCard: { borderRadius: 16, backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA', padding: 14, gap: 8 },
  errorText: { fontSize: 13, color: '#991B1B', fontWeight: '600' },
  retryButton: { ...crmTouchTarget, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#B91C1C' },
  retryText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
