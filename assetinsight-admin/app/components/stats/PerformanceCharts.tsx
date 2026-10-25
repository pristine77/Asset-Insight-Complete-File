"use client";

import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { Box, Typography } from "@mui/material";
import type { PerformancePayload } from "./types";
import { STAGE_LABELS } from "./types";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, PointElement, LineElement, Tooltip, Legend);

const COLORS = {
  red: "#d71920",
  black: "#191b1e",
  gray: "#8b9097",
  lightGray: "#c8cbd0",
  green: "#15966b",
  amber: "#c77900",
};

const baseLegend = { labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, font: { size: 11 } } };

function ChartPanel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <Box className="desktop-flat-panel" sx={{ minWidth: 0, p: 2.25 }}>
      <Typography sx={{ fontSize: 16, fontWeight: 700 }}>{title}</Typography>
      <Typography sx={{ mt: 0.25, mb: 1.5, color: "text.secondary", fontSize: 12 }}>{subtitle}</Typography>
      <Box sx={{ height: 280 }}>{children}</Box>
    </Box>
  );
}

export default function PerformanceCharts({ data }: { data: PerformancePayload }) {
  const employeeRows = data.employees.slice(0, 12);
  const dailyLabels = data.daily.map((row) => row.date.slice(5));

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "repeat(2, minmax(0, 1fr))" }, gap: 1.5 }}>
      <ChartPanel title="Daily throughput" subtitle="Reports, lots, and uploaded images grouped in America/Regina.">
        <Line
          data={{
            labels: dailyLabels,
            datasets: [
              { label: "Reports", data: data.daily.map((row) => row.reports), borderColor: COLORS.red, backgroundColor: COLORS.red, yAxisID: "y", tension: 0.22 },
              { label: "Lots", data: data.daily.map((row) => row.lots), borderColor: COLORS.black, backgroundColor: COLORS.black, yAxisID: "y", tension: 0.22 },
              { label: "Images", data: data.daily.map((row) => row.images), borderColor: COLORS.gray, backgroundColor: COLORS.gray, yAxisID: "images", tension: 0.22 },
            ],
          }}
          options={{ responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: "index" }, plugins: { legend: baseLegend }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { precision: 0 } }, images: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } }}
        />
      </ChartPanel>

      <ChartPanel title="Reports and lots by employee" subtitle="Top employees by report volume; lot totals apply to Asset and Lot Listing.">
        <Bar
          data={{ labels: employeeRows.map((row) => row.name), datasets: [{ label: "Reports", data: employeeRows.map((row) => row.reports), backgroundColor: COLORS.red }, { label: "Lots", data: employeeRows.map((row) => row.lots), backgroundColor: COLORS.black }] }}
          options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: baseLegend }, scales: { x: { stacked: false, grid: { display: false }, ticks: { maxRotation: 35, minRotation: 0 } }, y: { beginAtZero: true, ticks: { precision: 0 } } } }}
        />
      </ChartPanel>

      <ChartPanel title="Workflow distribution" subtitle="Current stage of every report in the filtered period.">
        <Doughnut
          data={{ labels: data.workflow.map((row) => STAGE_LABELS[row.stage]), datasets: [{ data: data.workflow.map((row) => row.count), backgroundColor: [COLORS.gray, COLORS.lightGray, COLORS.black, COLORS.amber, "#4b6cb7", COLORS.green, COLORS.red], borderWidth: 0 }] }}
          options={{ responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", ...baseLegend } } }}
        />
      </ChartPanel>

      <ChartPanel title="Completion outcomes" subtitle="Ready, retried, and failed reports in the filtered period.">
        <Doughnut
          data={{
            labels: ["Ready", "Retried", "Failed"],
            datasets: [{
              data: [data.outcomes.ready, data.outcomes.retry, data.outcomes.failed],
              backgroundColor: [COLORS.green, COLORS.amber, COLORS.red],
              borderWidth: 0,
            }],
          }}
          options={{ responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", ...baseLegend } } }}
        />
      </ChartPanel>

      <ChartPanel title="Turnaround trend" subtitle="Median minutes; days without complete timing timestamps are omitted.">
        <Line
          data={{ labels: dailyLabels, datasets: [{ label: "Preview", data: data.daily.map((row) => row.medianPreviewMinutes), borderColor: COLORS.red, backgroundColor: COLORS.red, spanGaps: true, tension: 0.2 }, { label: "Files", data: data.daily.map((row) => row.medianFileMinutes), borderColor: COLORS.black, backgroundColor: COLORS.black, spanGaps: true, tension: 0.2 }] }}
          options={{ responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: "index" }, plugins: { legend: baseLegend }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, title: { display: true, text: "Minutes" } } } }}
        />
      </ChartPanel>
    </Box>
  );
}
