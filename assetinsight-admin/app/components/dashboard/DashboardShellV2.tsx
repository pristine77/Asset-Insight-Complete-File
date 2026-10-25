"use client";

import { CalendarDays, CheckCircle2, ChevronRight, FileCheck2, Layers3, RefreshCcw, Settings2, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, TextField, Typography, useTheme } from '@mui/material';
import DashboardTabs from './DashboardTabs';
import DashboardActivity from './DashboardActivity';
import DashboardSettings from './DashboardSettings';
import DashboardRecentReports from './DashboardRecentReports';
import DashboardQueueDrawer from './DashboardQueueDrawer';
import { formatCount, formatDay, isDesktopDashboard, reportTypeLabel, validateDashboardRange, workflowLabels, type DesktopDashboard, type WorkflowStage } from '@/lib/dashboardData';
import styles from './DashboardOverview.module.css';

const TYPES = ['Asset', 'LotListing', 'RealEstate', 'Salvage'];
const STAGES = [
  { stage: 'preparing_preview', key: 'preparingPreview' },
  { stage: 'preview_ready', key: 'previewReady' },
  { stage: 'generating_files', key: 'generatingFiles' },
  { stage: 'awaiting_approval', key: 'awaitingApproval' },
  { stage: 'awaiting_release', key: 'awaitingRelease' },
] as const;
const EMPTY_QUEUE: DesktopDashboard['queue']['items'] = [];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const defaultRange = () => {
  const end = new Date(), start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { from: isoDay(start), to: isoDay(end) };
};

export default function DashboardShellV2() {
  const theme = useTheme();
  const [range, setRange] = useState(defaultRange);
  const [draftRange, setDraftRange] = useState(range);
  const [data, setData] = useState<DesktopDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queueStage, setQueueStage] = useState<WorkflowStage | null>(null);
  const request = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort('timeout'), 60_000);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/stats/desktop-dashboard?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { cache: 'no-store', signal: controller.signal });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(response.status === 403 ? 'You do not have access to dashboard statistics.' : 'Dashboard could not be refreshed. Please try again.');
      if (!isDesktopDashboard(payload)) throw new Error('Dashboard returned incomplete data. Please try again.');
      if (controller.signal.aborted || request.current !== controller) return;
      setData(payload);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (request.current !== controller || (controller.signal.aborted && controller.signal.reason !== 'timeout')) return;
      setError(controller.signal.reason === 'timeout' ? 'Dashboard request timed out. Please try again.' : cause instanceof Error ? cause.message : 'Dashboard could not be loaded.');
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) setLoading(false);
    }
  }, [range]);
  useEffect(() => { void loadDashboard(); return () => request.current?.abort(); }, [loadDashboard]);

  const typeData = useMemo(() => {
    const values = new Map(data?.byType.map(item => [item.type, item.value]));
    return TYPES.map(type => ({ type, value: values.get(type) }));
  }, [data]);
  const typeMax = Math.max(1, ...typeData.map(item => typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : 0));
  const typeTotal = typeData.reduce((total, item) => total + (item.value ?? 0), 0);
  const completeTypes = typeData.every(item => typeof item.value === 'number' && Number.isFinite(item.value) && item.value >= 0);
  const typeColors = [theme.palette.primary.main, theme.palette.mode === 'dark' ? '#a5afbd' : '#505a68', theme.palette.mode === 'dark' ? '#55bac5' : '#247d8b', theme.palette.mode === 'dark' ? '#e9b55c' : '#ba780d'];
  const queueMax = Math.max(1, ...STAGES.map(({ key }) => data?.queue[key] ?? 0));
  const visibleRange = data?.range ?? range;
  const rangeError = validateDashboardRange(draftRange);
  const pendingRange = data && (data.range.from.slice(0, 10) !== range.from || data.range.to.slice(0, 10) !== range.to);
  const kpis = [
    { label: 'Reports', value: formatCount(data?.kpis.reports.value), percent: data?.kpis.reports.percent, note: 'vs previous period', Icon: FileCheck2 },
    { label: 'Lots', value: formatCount(data?.kpis.lots?.value), percent: data?.kpis.lots?.percent, note: 'vs previous period', Icon: Layers3 },
    { label: 'Registered users', value: formatCount(data?.kpis.users.value), note: 'All time', Icon: Users },
    { label: 'Pending / Approved', value: `${formatCount(data?.kpis.pending)} / ${formatCount(data?.kpis.released)}`, note: 'All-time status totals', Icon: CheckCircle2 },
  ];

  return <div className={styles.page}>
    <header className={styles.header}>
      <h1>Dashboard</h1>
      <div className={styles.headerRight}>
        <div className={styles.tools}>
          <Button className={styles.dateButton} variant="outlined" sx={{ color: 'text.primary', borderColor: 'divider' }} startIcon={<CalendarDays size={16} />} aria-label={`Choose dashboard date range: ${formatDay(range.from, true)} to ${formatDay(range.to, true)}`} onClick={() => { setDraftRange(range); setDateDialogOpen(true); }}>{formatDay(range.from)} – {formatDay(range.to, true)}</Button>
          <Button className={styles.refreshButton} aria-label="Refresh" variant="contained" sx={{ '&:not(.Mui-disabled)': { bgcolor: theme.palette.mode === 'dark' ? 'primary.dark' : 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } } }} startIcon={<RefreshCcw size={16} />} disabled={loading} onClick={() => void loadDashboard()}><span className={styles.refreshLabel}>Refresh</span></Button>
          <IconButton aria-label="Operations settings" onClick={() => setSettingsOpen(true)} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '4px', width: { xs: 44, sm: 38 }, height: { xs: 44, sm: 38 } }}><Settings2 size={18} /></IconButton>
        </div>
        <p className={styles.updated} role="status">{loading ? data ? 'Refreshing · previous snapshot shown' : 'Loading dashboard…' : error ? 'Update failed' : updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not yet updated'}</p>
      </div>
      <div className={styles.tabs}><DashboardTabs active="overview" /></div>
    </header>
    {error ? <Alert severity="error" sx={{ mb: 1.5 }} action={<Button color="inherit" disabled={loading} onClick={() => void loadDashboard()}>Retry</Button>}>{error}{data && updatedAt ? ` Showing the last successful snapshot from ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}</Alert> : null}
    {pendingRange ? <Alert severity="info" sx={{ mb: 1.5 }}>Showing {formatDay(visibleRange.from, true)} – {formatDay(visibleRange.to, true)} until the new range loads.</Alert> : null}

    <section className={styles.metrics} aria-label="Report overview metrics">
      {kpis.map(({ label, value, percent, note, Icon }) => <div className={styles.metric} key={label}>
        <Icon size={28} strokeWidth={1.65} className={styles.metricIcon} aria-hidden />
        <div><p className={styles.metricLabel}>{label}</p><div className={styles.metricValue}>{value}</div><p className={styles.metricNote}>
          {typeof percent === 'number' && Number.isFinite(percent) ? <Box component="span" sx={{ color: theme.palette.mode === 'dark' ? percent >= 0 ? 'success.light' : 'warning.light' : percent >= 0 ? 'success.dark' : 'warning.dark', mr: .5 }}>{percent >= 0 ? '+' : ''}{percent.toFixed(1)}%</Box> : null}{note}
        </p></div>
      </div>)}
    </section>
    <div className={styles.analysisRow}>
      <DashboardActivity data={data} />
      <section className={styles.panel} aria-labelledby="types-heading">
        <div className={styles.panelHeader}><div><h2 id="types-heading">Reports by type</h2><p>Selected period</p></div></div>
        <div className={styles.typeBars}>{typeData.map(({ type, value }, index) => <div className={styles.typeRow} key={type}>
          <span>{reportTypeLabel(type)}</span><div className={styles.track} aria-hidden><div className={styles.bar} style={{ width: `${typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / typeMax * 100 : 0}%`, background: typeColors[index] }} /></div>
          <span className={styles.typeCount}>{formatCount(value)}</span><span className={styles.share}>{completeTypes ? `${typeTotal ? ((value ?? 0) / typeTotal * 100).toFixed(1) : '0.0'}%` : '—'}</span>
        </div>)}</div>
        {data && typeTotal === 0 && completeTypes ? <p className={styles.footnote}>No reports in this period.</p> : null}
      </section>
    </div>
    <div className={styles.operationsRow}>
      <section className={styles.panel} aria-labelledby="workflow-heading">
        <div className={styles.panelHeader}><div><h2 id="workflow-heading">Workflow snapshot</h2><p>Current queue · all dates</p></div></div>
        <div className={styles.workflowList}>{STAGES.map(({ stage, key }) => <button type="button" className={styles.workflowButton} key={stage} disabled={!data} onClick={() => setQueueStage(stage)} aria-label={`View ${workflowLabels[stage]}: ${formatCount(data?.queue[key])}`}>
          <span>{workflowLabels[stage]}</span><span className={styles.track} aria-hidden><span className={styles.bar} style={{ display: 'block', background: theme.palette.primary.main, width: `${(data?.queue[key] ?? 0) / queueMax * 100}%` }} /></span><strong>{formatCount(data?.queue[key])}</strong><ChevronRight size={16} />
        </button>)}</div>
        <div className={styles.readyRow}><button type="button" className={styles.workflowButton} disabled={!data} onClick={() => setQueueStage('ready')}><span>Ready today</span><strong>{formatCount(data?.queue.releasedToday)}</strong><ChevronRight size={16} /></button></div>
        <Button component={Link} href="/stats" prefetch={false} className={styles.queueLink} sx={{ color: theme.palette.mode === 'dark' ? 'primary.light' : 'primary.main' }} endIcon={<ChevronRight size={15} />}>View full queue</Button>
      </section>
      <DashboardRecentReports reports={data?.recentReports} />
    </div>
    <DashboardQueueDrawer stage={queueStage} items={data?.queue.items ?? EMPTY_QUEUE} onClose={() => setQueueStage(null)} />
    <Dialog open={dateDialogOpen} onClose={() => setDateDialogOpen(false)} fullWidth maxWidth="xs" aria-labelledby="dashboard-range-title" sx={theme => ({ '& .MuiInputLabel-root.Mui-focused:not(.Mui-error)': { color: theme.palette.mode === 'dark' ? 'primary.light' : 'primary.main' } })}>
      <DialogTitle id="dashboard-range-title">Date range</DialogTitle>
      <DialogContent><Typography sx={{ mb: 2, color: 'text.secondary', fontSize: 13 }}>Applies to reports, lots, activity and report types. Dates use UTC; queue and directory totals use all dates.</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, pt: 1 }}><TextField autoFocus type="date" label="From" value={draftRange.from} onChange={event => setDraftRange(current => ({ ...current, from: event.target.value }))} slotProps={{ inputLabel: { shrink: true } }} /><TextField type="date" label="To" value={draftRange.to} onChange={event => setDraftRange(current => ({ ...current, to: event.target.value }))} slotProps={{ inputLabel: { shrink: true } }} /></Box>
        {rangeError ? <Alert severity="warning" sx={{ mt: 1.5 }}>{rangeError}</Alert> : null}
      </DialogContent>
      <DialogActions><Button sx={{ color: theme.palette.mode === 'dark' ? 'primary.light' : 'primary.main' }} onClick={() => setDateDialogOpen(false)}>Cancel</Button><Button variant="contained" sx={{ '&:not(.Mui-disabled)': { bgcolor: theme.palette.mode === 'dark' ? 'primary.dark' : 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } } }} disabled={!!rangeError} onClick={() => { setDateDialogOpen(false); if (draftRange.from !== range.from || draftRange.to !== range.to) setRange(draftRange); }}>Apply</Button></DialogActions>
    </Dialog>
    <DashboardSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </div>;
}
