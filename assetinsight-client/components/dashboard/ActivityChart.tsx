"use client";

import { useId, useMemo, useState } from "react";
import type { DashboardSeriesPoint } from "@/services/dashboard";
import styles from "./ActivityChart.module.css";

const WIDTH = 920;
const HEIGHT = 290;
const PAD = { top: 22, right: 28, bottom: 42, left: 44 };

function shortDate(value: string, includeMonth: boolean) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: includeMonth ? "short" : undefined,
    timeZone: "UTC",
  }).format(date);
}

export default function ActivityChart({ data }: { data: DashboardSeriesPoint[] }) {
  const gradientId = useId().replace(/:/g, "");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chart = useMemo(() => {
    const usableWidth = WIDTH - PAD.left - PAD.right;
    const usableHeight = HEIGHT - PAD.top - PAD.bottom;
    const maximum = Math.max(1, ...data.flatMap((item) => [item.lots, item.reports]));
    const tickMaximum = Math.max(4, Math.ceil(maximum / 4) * 4);
    const x = (index: number) =>
      PAD.left + (data.length <= 1 ? usableWidth / 2 : (index / (data.length - 1)) * usableWidth);
    const y = (value: number) => PAD.top + usableHeight - (value / tickMaximum) * usableHeight;
    const reportPath = data
      .map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item.reports).toFixed(1)}`)
      .join(" ");
    const areaPath = data.length
      ? `${reportPath} L${x(data.length - 1).toFixed(1)},${(PAD.top + usableHeight).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + usableHeight).toFixed(1)} Z`
      : "";
    const labelEvery = Math.max(1, Math.ceil(data.length / 7));
    const barWidth = Math.max(2, Math.min(15, usableWidth / Math.max(data.length, 1) - 3));
    return { x, y, reportPath, areaPath, labelEvery, barWidth, tickMaximum, usableHeight };
  }, [data]);

  if (!data.length) {
    return <div className={styles.empty}>Activity will appear after your first report.</div>;
  }

  const active = activeIndex === null ? null : data[activeIndex];
  const activeX = activeIndex === null ? 0 : chart.x(activeIndex);

  return (
    <div className={styles.wrap}>
      <div className={styles.legend} aria-hidden>
        <span><i data-series="lots" />Lots</span>
        <span><i data-series="reports" />Reports</span>
      </div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Lots and reports created by date"
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
          const ratio = (px - PAD.left) / (WIDTH - PAD.left - PAD.right);
          setActiveIndex(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))));
        }}
        onPointerLeave={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--app-accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--app-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = (chart.tickMaximum / 4) * tick;
          const y = chart.y(value);
          return (
            <g key={tick}>
              <line className={styles.grid} x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />
              <text className={styles.axisText} x={PAD.left - 10} y={y + 4} textAnchor="end">{Math.round(value)}</text>
            </g>
          );
        })}
        {data.map((item, index) => {
          const x = chart.x(index);
          const top = chart.y(item.lots);
          return (
            <rect
              key={`${item.date}-bar`}
              className={styles.bar}
              x={x - chart.barWidth / 2}
              y={top}
              width={chart.barWidth}
              height={PAD.top + chart.usableHeight - top}
              rx="2"
            />
          );
        })}
        <path d={chart.areaPath} fill={`url(#${gradientId})`} />
        <path className={styles.line} d={chart.reportPath} />
        {data.map((item, index) =>
          index % chart.labelEvery === 0 || index === data.length - 1 ? (
            <text key={`${item.date}-label`} className={styles.axisText} x={chart.x(index)} y={HEIGHT - 14} textAnchor="middle">
              {shortDate(item.date, true)}
            </text>
          ) : null
        )}
        {active && activeIndex !== null ? (
          <g aria-hidden>
            <line className={styles.crosshair} x1={activeX} x2={activeX} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
            <circle className={styles.point} cx={activeX} cy={chart.y(active.reports)} r="5" />
          </g>
        ) : null}
      </svg>
      {active ? (
        <div
          className={styles.tooltip}
          style={{ left: `${Math.max(10, Math.min(82, (activeX / WIDTH) * 100))}%` }}
        >
          <strong>{shortDate(active.date, true)}</strong>
          <span><i data-series="lots" />{active.lots} lots</span>
          <span><i data-series="reports" />{active.reports} reports</span>
        </div>
      ) : null}
    </div>
  );
}
