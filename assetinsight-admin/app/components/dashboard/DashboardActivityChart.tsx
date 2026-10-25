"use client";

import { memo, useMemo } from 'react';
import { alpha, useTheme } from '@mui/material/styles';
import { useMediaQuery } from '@mui/material';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, type ChartOptions, type ScriptableContext } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { formatDay, type ActivityBucket } from '@/lib/dashboardData';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

/** One bounded canvas; no animation/re-creation when unrelated settings or credits change. */
export default memo(function DashboardActivityChart({ points }: { points: ActivityBucket[] }) {
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const color = theme.palette.primary.main;
  const data = useMemo(() => {
    let gradient: CanvasGradient | undefined, gradientKey = '';
    return {
    labels: points.map(point => formatDay(point.date)),
    datasets: [{
      label: 'Report groups', data: points.map(point => point.value),
      borderColor: color, backgroundColor: (context: ScriptableContext<'line'>) => {
        const { ctx, chartArea } = context.chart;
        if (!chartArea) return alpha(color, .14);
        const key = `${chartArea.top}:${chartArea.bottom}`;
        if (!gradient || gradientKey !== key) {
          gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, alpha(color, .28));
          gradient.addColorStop(1, alpha(color, .06));
          gradientKey = key;
        }
        return gradient;
      }, fill: true,
      borderWidth: 2, pointRadius: points.length > 60 ? 0 : 2.5,
      pointHoverRadius: 5, pointHitRadius: 14, pointBackgroundColor: color,
      tension: 0, spanGaps: false,
    }],
  }; }, [points, color]);
  const options = useMemo<ChartOptions<'line'>>(() => ({
    animation: false, responsive: true, maintainAspectRatio: false, normalized: true,
    devicePixelRatio: 2,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: {
      title: (items) => {
        const point = points[items[0]?.dataIndex];
        return point ? `${formatDay(point.date, true)}${point.date === point.endDate ? '' : ` – ${formatDay(point.endDate, true)}`}` : '';
      },
    } } },
    scales: {
      x: {
        afterBuildTicks: (scale) => {
          const count = Math.min(points.length, narrow ? 3 : 5);
          scale.ticks = Array.from({ length: count }, (_, index) => ({ value: count <= 1 ? 0 : Math.round(index * (points.length - 1) / (count - 1)) }));
        },
        grid: { display: false }, border: { color: theme.palette.divider }, ticks: { autoSkip: false, maxRotation: 0, minRotation: 0, color: theme.palette.text.secondary, font: { family: theme.typography.fontFamily, size: 11 } },
      },
      y: { beginAtZero: true, suggestedMax: 1, border: { display: false }, grid: { color: alpha(theme.palette.text.primary, .08) }, ticks: { precision: 0, maxTicksLimit: 6, color: theme.palette.text.secondary, font: { family: theme.typography.fontFamily, size: 11 } } },
    },
  }), [points, narrow, theme]);
  return <Line data={data} options={options} role="img" aria-label="Report activity over the selected period. Use the Data button for dates and exact counts." />;
});
