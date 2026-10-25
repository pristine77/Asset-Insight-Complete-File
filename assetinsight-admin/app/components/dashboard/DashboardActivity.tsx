"use client";

import { Component, memo, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Box, Button, ButtonGroup, Typography } from '@mui/material';
import { formatCount, formatDay, prepareActivity, type DesktopDashboard } from '@/lib/dashboardData';
import styles from './DashboardOverview.module.css';

const ActivityChart = dynamic(() => import('./DashboardActivityChart'), { ssr: false, loading: () => <Box className={styles.chartPlaceholder} role="status">Loading chart…</Box> });

class ChartBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default memo(function DashboardActivity({ data }: { data: DesktopDashboard | null }) {
  const [view, setView] = useState<'chart' | 'data'>('chart');
  const points = useMemo(() => data ? prepareActivity(data.activity, data.range) : [], [data]);
  const grouped = points.some(point => point.date !== point.endDate);
  const hasMissing = points.some(point => point.value === null);
  const peak = points.reduce<number | null>((max, point) => point.value === null ? max : Math.max(max ?? 0, point.value), null);
  const table = <Box className={styles.activityTable} tabIndex={0} role="region" aria-label="Report activity data">
    <table><caption className={styles.srOnly}>Report groups by {grouped ? 'date interval' : 'UTC day'}. Missing means unavailable, not zero.</caption>
      <thead><tr><th scope="col">{grouped ? 'Date interval (UTC)' : 'Date (UTC)'}</th><th scope="col">Reports</th></tr></thead>
      <tbody>{points.map(point => <tr key={point.date}><th scope="row">{formatDay(point.date, true)}{point.date === point.endDate ? '' : ` – ${formatDay(point.endDate, true)}`}</th><td>{point.value === null ? 'Unavailable' : formatCount(point.value)}</td></tr>)}</tbody>
    </table>
  </Box>;
  return <section className={`${styles.panel} ${styles.activity}`} aria-labelledby="activity-heading">
    <div className={styles.panelHeader}>
      <div><h2 id="activity-heading">Report activity</h2><p><span className={styles.activityCaptionDesktop}>Report groups per {grouped ? 'interval' : 'day'} · selected period</span><span className={styles.activityCaptionMobile}>Selected period · {formatCount(data?.kpis.reports.value)} reports</span></p></div>
      <div className={styles.chartControls}>
        <ButtonGroup size="small" aria-label="Report activity view" sx={theme => ({
          '& .MuiButton-contained': { bgcolor: theme.palette.mode === 'dark' ? 'primary.dark' : 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } },
          '& .MuiButton-outlined': { color: 'text.primary', bgcolor: 'action.hover', borderColor: 'divider', '&:hover': { bgcolor: 'action.selected', borderColor: 'text.secondary' } },
        })}>
          <Button variant={view === 'chart' ? 'contained' : 'outlined'} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</Button>
          <Button variant={view === 'data' ? 'contained' : 'outlined'} aria-pressed={view === 'data'} onClick={() => setView('data')}>Data</Button>
        </ButtonGroup>
        <span className={styles.peak}>{grouped ? 'Peak interval' : 'Peak'} <strong>{formatCount(peak)}</strong></span>
      </div>
    </div>
    <div className={styles.plot}>
      {!data ? <div className={styles.chartPlaceholder}>Activity will appear when dashboard data is available.</div> : view === 'data' ? table : peak === null ? <div className={styles.chartPlaceholder}>No activity data available for this period. Use Data to inspect the missing dates.</div> : <ChartBoundary fallback={<><Typography role="status" sx={{ fontSize: 12 }}>Chart unavailable. The saved counts are shown below.</Typography>{table}</>}><ActivityChart points={points} /></ChartBoundary>}
    </div>
    <p className={styles.footnote}>Salvage activity uses generated-file dates.{grouped ? ' Long ranges are grouped into contiguous date intervals.' : ''}{hasMissing ? ' Gaps indicate unavailable data.' : ''}</p>
  </section>;
});
