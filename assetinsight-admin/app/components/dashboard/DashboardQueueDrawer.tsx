"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import Link from "next/link";
import { formatCount, reportTypeLabel, workflowLabels, type DashboardQueueItem, type WorkflowStage } from "@/lib/dashboardData";

function elapsedMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : -1;
}

function elapsedLabel(value: number): string {
  const minutes = elapsedMinutes(value);
  if (minutes < 0) return "—";
  return minutes < 60 ? `${Math.round(minutes)}m` : `${(minutes / 60).toFixed(1)}h`;
}

export default function DashboardQueueDrawer({ stage, items, onClose }: { stage: WorkflowStage | null; items: DashboardQueueItem[]; onClose: () => void }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const matchingItems = items.filter((item) => item.workflowStage === stage).sort((left, right) => elapsedMinutes(right.elapsedMinutes) - elapsedMinutes(left.elapsedMinutes));

  return (
    <Drawer
      anchor="right"
      open={stage !== null}
      onClose={onClose}
      transitionDuration={reducedMotion ? 0 : undefined}
      sx={{ zIndex: (theme) => theme.zIndex.modal + 2 }}
      slotProps={{ paper: { role: "dialog", "aria-modal": true, "aria-labelledby": "dashboard-queue-title", "aria-describedby": "dashboard-queue-description", sx: { width: { xs: "100%", sm: 460 }, maxWidth: "100vw" } } }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ px: 2.5, py: 2, borderBottom: "1px solid", borderColor: "divider" }}>
        <Box>
          <Typography component="h2" id="dashboard-queue-title" sx={{ fontSize: 19, fontWeight: 650 }}>{stage ? workflowLabels[stage] : "Workflow queue"}</Typography>
          <Typography id="dashboard-queue-description" sx={{ mt: 0.25, color: "text.secondary", fontSize: 12 }}>Recent matching reports</Typography>
        </Box>
        <IconButton autoFocus aria-label="Close workflow queue" onClick={onClose} sx={{ width: 44, height: 44, flexShrink: 0 }}><CloseRounded sx={{ fontSize: 20 }} /></IconButton>
      </Stack>
      <Box sx={{ px: 2.5, py: 1.5, borderBottom: "1px solid", borderColor: "divider", bgcolor: "action.hover" }}>
        <Typography sx={{ color: "text.secondary", fontSize: 12, lineHeight: 1.6 }}>Matches from the latest 60 updated reports, ordered by elapsed time within that sample. Open Stats for the full queue.</Typography>
        {stage === "ready" ? <Typography sx={{ mt: 1, color: "text.secondary", fontSize: 12, lineHeight: 1.6 }}>Ready today uses the America/Regina business day and the saved release time, or last update time when a release time is missing. This recent sample may also include reports that became ready on earlier dates.</Typography> : null}
      </Box>
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {matchingItems.length ? (
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
            {matchingItems.map((item) => (
              <Box component="li" key={`${item.reportType}-${item.id}`} sx={{ display: "flex", gap: 1.5, p: 2, borderBottom: "1px solid", borderColor: "divider" }}>
                {item.thumbnailUrl ? (
                  <Box component="img" src={item.thumbnailUrl} alt="" loading="lazy" sx={{ width: 58, height: 52, flexShrink: 0, objectFit: "cover", borderRadius: "4px", border: "1px solid", borderColor: "divider" }} />
                ) : (
                  <Box sx={{ display: "grid", width: 58, height: 52, flexShrink: 0, placeItems: "center", color: "text.secondary", bgcolor: "action.hover", borderRadius: "4px" }}><InsertDriveFileOutlined sx={{ fontSize: 20 }} /></Box>
                )}
                <Box sx={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
                  <Stack direction="row" justifyContent="space-between" gap={1}>
                    <Typography sx={{ fontSize: 13, fontWeight: 650 }}>{item.title || item.contractNo || `${reportTypeLabel(item.reportType)} report`}</Typography>
                    <Typography title="Elapsed time in this stage" sx={{ flexShrink: 0, color: "text.secondary", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{elapsedLabel(item.elapsedMinutes)}</Typography>
                  </Stack>
                  <Typography sx={{ mt: 0.35, color: "text.secondary", fontSize: 11 }}>{item.creator || "Unknown creator"}{item.creatorEmail ? ` · ${item.creatorEmail}` : ""}</Typography>
                  <Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 11 }}>{[item.contractNo || "No contract", reportTypeLabel(item.reportType), `${formatCount(item.lotCount)} lot${item.lotCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</Typography>
                  <Typography sx={{ mt: 0.5, fontSize: 12 }}>{item.workflowMessage || "No workflow details available."}</Typography>
                  {item.error ? <Alert severity="error" sx={{ mt: 1, py: 0.25, fontSize: 12 }}>{item.error}</Alert> : null}
                </Box>
              </Box>
            ))}
          </Box>
        ) : <Typography sx={{ p: 3, color: "text.secondary", fontSize: 13 }}>No matching reports in this recent sample.</Typography>}
      </Box>
      <Box sx={{ p: 2, borderTop: "1px solid", borderColor: "divider" }}>
        <Button component={Link} href={stage ? `/stats?workflowStage=${stage}` : "/stats"} prefetch={false} fullWidth variant="contained" onClick={onClose} sx={(theme) => theme.palette.mode === "dark" ? { bgcolor: "primary.dark", color: "common.white", "&:hover": { bgcolor: "primary.dark" } } : {}}>Open filtered Stats</Button>
      </Box>
    </Drawer>
  );
}
