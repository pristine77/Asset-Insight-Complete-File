"use client";

import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import { alpha } from "@mui/material/styles";
import Link from "next/link";
import { formatCount, formatDay, reportStatus, reportTypeLabel, type DashboardRecentReport } from "@/lib/dashboardData";
import styles from "./DashboardOverview.module.css";

const mobileTextStyle = { whiteSpace: "normal", overflowWrap: "anywhere", overflow: "visible", textOverflow: "clip" } as const;

function creatorLabel(owner: DashboardRecentReport["owner"]): string {
  if (!owner) return "Unknown creator";
  return typeof owner === "string" ? owner : owner.username || owner.companyName || owner.email || "Unknown creator";
}

function reportTitle(report: DashboardRecentReport): string {
  return report.title || report.contractNo || "Untitled report";
}

function ReportThumbnail({ report }: { report: DashboardRecentReport }) {
  return report.thumbnailUrl ? (
    <Box component="img" className={styles.reportThumb} src={report.thumbnailUrl} alt="" loading="lazy" />
  ) : (
    <Box component="span" className={styles.reportThumb} sx={{ display: "grid", placeItems: "center", bgcolor: "action.hover", color: "text.secondary" }}>
      <InsertDriveFileOutlined aria-hidden="true" sx={{ fontSize: 17 }} />
    </Box>
  );
}

function ReportStatus({ report }: { report: DashboardRecentReport }) {
  const { label, tone } = reportStatus(report);
  return (
    <Chip
      size="small"
      label={label}
      title={label}
      sx={{ maxWidth: "100%", height: 23, borderRadius: "4px", fontSize: 10, fontWeight: 600, color: (theme) => tone === "default" ? theme.palette.text.secondary : theme.palette[tone][theme.palette.mode === "dark" ? "light" : "dark"], bgcolor: (theme) => tone === "default" ? theme.palette.action.hover : alpha(theme.palette[tone].main, 0.11), "& .MuiChip-label": { px: 0.8 } }}
    />
  );
}

function OpenReport({ report }: { report: DashboardRecentReport }) {
  return (
    <IconButton
      component={Link}
      href={`/reports?search=${encodeURIComponent(report.contractNo || report.title)}`}
      prefetch={false}
      aria-label={`Open report: ${reportTitle(report)}`}
      size="small"
      sx={{ width: 28, height: 28, flexShrink: 0, color: "text.secondary", borderRadius: "4px", "@media (max-width: 649px)": { width: 44, height: 44 } }}
    >
      <ChevronRightRounded sx={{ fontSize: 18 }} />
    </IconButton>
  );
}

export default function DashboardRecentReports({ reports }: { reports: DashboardRecentReport[] | undefined }) {
  return (
    <section className={`${styles.panel} ${styles.recent}`} aria-labelledby="dashboard-recent-title">
      <div className={styles.panelHeader}>
        <div><h2 id="dashboard-recent-title">Recent reports</h2><p>All dates</p></div>
      </div>
      {reports?.length ? (
        <>
          <div className={styles.recentTable} role="region" aria-label="Recent reports table" tabIndex={0}>
            <table>
              <caption className={styles.srOnly}>Recent reports with creator, creation date, report type, lot count and current status.</caption>
              <colgroup><col style={{ width: "44%" }} /><col style={{ width: "17%" }} /><col style={{ width: "8%" }} /><col style={{ width: "23%" }} /><col style={{ width: "8%" }} /></colgroup>
              <thead><tr><th scope="col">Report</th><th scope="col">Type</th><th scope="col">Lots</th><th scope="col">Status</th><th scope="col">Open</th></tr></thead>
              <tbody>
                {reports.map((report) => {
                  const metadata = [report.contractNo, creatorLabel(report.owner), formatDay(report.createdAt, true)].filter(Boolean).join(" · ");
                  return (
                    <tr key={report._id}>
                      <td>
                        <div className={styles.reportName}>
                          <ReportThumbnail report={report} />
                          <div className={styles.reportText}>
                            <div className={styles.reportTitle} title={reportTitle(report)}>{reportTitle(report)}</div>
                            <div className={styles.reportMeta} title={metadata}>{metadata}</div>
                          </div>
                        </div>
                      </td>
                      <td>{reportTypeLabel(report.type) || "Unknown"}</td>
                      <td title={report.lotNumberSummary || undefined} aria-label={report.lotNumberSummary ? `${formatCount(report.lotCount)} lots: ${report.lotNumberSummary}` : undefined}>{formatCount(report.lotCount)}</td>
                      <td><ReportStatus report={report} /></td>
                      <td><OpenReport report={report} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.mobileReports}>
            {reports.map((report) => (
              <div className={styles.mobileReport} key={report._id}>
                <ReportThumbnail report={report} />
                <div className={styles.reportText}>
                  <div className={styles.reportTitle} style={mobileTextStyle}>{reportTitle(report)}</div>
                  <div className={styles.reportMeta} style={mobileTextStyle} title={report.lotNumberSummary || undefined}>{[report.contractNo, reportTypeLabel(report.type) || "Unknown type", `${formatCount(report.lotCount)} lots`].filter(Boolean).join(" · ")}</div>
                  <div className={styles.reportMeta} style={mobileTextStyle}>{creatorLabel(report.owner)} · {formatDay(report.createdAt, true)}</div>
                  <Box sx={{ mt: 0.5 }}><ReportStatus report={report} /></Box>
                </div>
                <OpenReport report={report} />
              </div>
            ))}
          </div>
        </>
      ) : <p className={styles.empty}>{reports ? "No recent reports." : "Recent reports are unavailable."}</p>}
    </section>
  );
}
