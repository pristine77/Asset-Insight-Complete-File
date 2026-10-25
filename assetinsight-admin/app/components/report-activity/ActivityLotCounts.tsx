"use client";

import { useEffect, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { activityTime, parseActivityLotPage, type ActivityLotPage } from "@/lib/reportActivity";

const PAGE_SIZE = 10;
export default function ActivityLotCounts({ id, refresh }: { id: string; refresh: number }) {
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const [result, setData] = useState<ActivityLotPage | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState("");
  // A page change must not briefly label the previous page's rows as new rows.
  const data = result?.page === page ? result : null;
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(""); setData(null);
    async function load() {
      try {
        const response = await fetch(`/api/admin/report-activity/${id}/lots?page=${page}&limit=${PAGE_SIZE}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Per-lot counts could not be loaded. Try again.");
        const result = parseActivityLotPage(await response.json());
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
        if (page > lastPage) { setPage(lastPage); return; }
        setData(result);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Per-lot counts are unavailable."); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load(); return () => controller.abort();
  }, [id, page, refresh, retry]);
  return <Box component="section" aria-label="Photos by lot" sx={{ mb: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
    <Typography component="h2" sx={{ fontWeight: 700, fontSize: 14, mb: 0.5 }}>Photos by lot{data?.source !== "unavailable" && data ? ` · ${data.total} lots` : ""}</Typography>
    {busy || (!data && !error) ? <LinearProgress aria-label="Loading per-lot counts" /> : null}
    {error ? <Alert severity="error" action={<Button onClick={() => setRetry(value => value + 1)} sx={{ minHeight: 44 }}>Retry counts</Button>}>{error}</Alert> : null}
    {data ? <>
      <Typography sx={{ color: "text.secondary", fontSize: 12, mb: 1 }}>
        {data.source === "unavailable" ? "A complete per-lot breakdown is not recorded for this history. Recorded changes remain in the timeline below."
          : data.source === "capture" ? `Last synchronized device counts · ${activityTime(data.asOf)}. Not live while offline.`
          : `Current saved ${data.source} counts${data.asOf ? ` · ${activityTime(data.asOf)}` : ""}. Not historical counts.`}
      </Typography>
      {data.source !== "unavailable" && !data.total ? <Typography sx={{ fontSize: 13 }}>No lots in this saved record.</Typography> : null}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0,1fr))" }, columnGap: 2 }}>
        {data.items.map(lot => <Box component="li" key={lot.id} sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "divider", minWidth: 0 }}>
          <Typography sx={{ fontSize: 13, overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums" }}>Lot {lot.lotNumber} · {lot.photos.toLocaleString()} {lot.photos === 1 ? "image" : "images"}</Typography>
          {lot.extraPhotos > 0 ? <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{lot.mainPhotos} main · {lot.extraPhotos} report-only</Typography> : null}
          {lot.missingPhotos ? <Typography sx={{ fontSize: 12, color: "error.main" }}>{lot.missingPhotos} missing on device</Typography> : null}
        </Box>)}
      </Box>
      {data.total > PAGE_SIZE ? <Stack direction="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" gap={0.5} sx={{ mt: 1 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>Lots {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}</Typography>
        <Stack direction="row"><Button disabled={busy || page === 1} onClick={() => setPage(value => value - 1)} sx={{ minHeight: 44 }}>Previous lots</Button><Button disabled={busy || page * PAGE_SIZE >= data.total} onClick={() => setPage(value => value + 1)} sx={{ minHeight: 44 }}>Next lots</Button></Stack>
      </Stack> : null}
    </> : null}
  </Box>;
}
