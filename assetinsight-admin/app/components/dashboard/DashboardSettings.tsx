"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";

type SpecSearchSetting = { enabled: boolean };
type ApprovalSetting = { threshold: number; defaultThreshold: number };
type Payload = Record<string, unknown>;

function readSpecSetting(payload: Payload): SpecSearchSetting {
  if (typeof payload.enabled !== "boolean") throw new Error("The saved spec web search setting could not be read. Please retry.");
  return { enabled: payload.enabled };
}

function readApprovalSetting(payload: Payload): ApprovalSetting {
  const value = payload.threshold ?? payload.defaultThreshold;
  const threshold = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  const defaultThreshold = Number(payload.defaultThreshold ?? 500000);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000000000 || !Number.isFinite(defaultThreshold) || defaultThreshold < 0 || defaultThreshold > 1000000000) {
    throw new Error("The saved asset approval limit could not be read. Please retry.");
  }
  return { threshold, defaultThreshold };
}

function useRemoteSetting<T>(open: boolean, path: string, parse: (payload: Payload) => T, label: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const initialLoadAttempted = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const request = useCallback(async (body?: Payload) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    const isSave = body !== undefined;
    if (isSave) setSaving(true);
    else setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: isSave ? "PATCH" : "GET",
        cache: "no-store",
        signal: controller.signal,
        ...(isSave ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : `Failed to ${isSave ? "save" : "load"} ${label}.`);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`The saved ${label} could not be read. Please retry.`);
      const nextData = parse(payload);
      if (!controller.signal.aborted) {
        setData(nextData);
        if (isSave) setMessage("Changes saved.");
      }
    } catch (currentError) {
      if (!controller.signal.aborted) {
        setError(currentError instanceof Error ? currentError.message : `Failed to ${isSave ? "save" : "load"} ${label}.`);
      }
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setLoading(false);
        setSaving(false);
      }
    }
  }, [label, parse, path]);

  useEffect(() => {
    if (!open || initialLoadAttempted.current) return;
    initialLoadAttempted.current = true;
    void request();
  }, [open, request]);

  useEffect(() => () => {
    requestRef.current?.abort();
    initialLoadAttempted.current = false;
    busyRef.current = false;
  }, []);

  return { data, loading, saving, error, message, request, clearMessage: () => setMessage(null) };
}

export default function DashboardSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spec = useRemoteSetting(open, "/api/admin/spec-web-search", readSpecSetting, "spec web search setting");
  const approval = useRemoteSetting(open, "/api/admin/asset-approval-threshold", readApprovalSetting, "asset approval limit");
  const [thresholdInput, setThresholdInput] = useState("");
  const [thresholdTouched, setThresholdTouched] = useState(false);

  useEffect(() => {
    if (!approval.data) return;
    setThresholdInput(String(approval.data.threshold));
    setThresholdTouched(false);
  }, [approval.data]);

  const trimmedThreshold = thresholdInput.trim();
  const thresholdValue = /^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(trimmedThreshold) ? Number(trimmedThreshold.replace(/,/g, "")) : Number.NaN;
  const thresholdValid = Number.isFinite(thresholdValue) && thresholdValue >= 0 && thresholdValue <= 1000000000;
  const thresholdChanged = approval.data !== null && thresholdValue !== approval.data.threshold;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="dashboard-settings-title"
      slotProps={{ paper: { sx: { borderRadius: "4px", m: { xs: 2, sm: 4 }, width: { xs: "calc(100% - 32px)", sm: "calc(100% - 64px)" } } } }}
    >
      <DialogTitle id="dashboard-settings-title" sx={{ fontSize: 18, fontWeight: 650 }}>Operations settings</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box component="section" aria-labelledby="dashboard-spec-search-label" aria-busy={spec.loading || spec.saving}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
              <Box>
                <Typography id="dashboard-spec-search-label" sx={{ fontSize: 14, fontWeight: 650 }}>Spec web search</Typography>
                <Typography id="dashboard-spec-search-description" sx={{ mt: 0.5, color: "text.secondary", fontSize: 12 }}>Off uses uploaded images and provided data only.</Typography>
              </Box>
              <Switch
                checked={spec.data?.enabled === true}
                onChange={(_, enabled) => { if (spec.data && !spec.loading && !spec.saving) void spec.request({ enabled }); }}
                disabled={!spec.data || spec.loading || spec.saving}
                color="success"
                slotProps={{ input: { "aria-labelledby": "dashboard-spec-search-label", "aria-describedby": "dashboard-spec-search-description" } }}
              />
            </Stack>
            {spec.loading || spec.saving ? <Typography role="status" sx={{ mt: 1, fontSize: 12, color: "text.secondary" }}>{spec.saving ? "Saving spec web search…" : "Loading spec web search…"}</Typography> : null}
            {spec.error ? <Alert severity="error" sx={{ mt: 1.5, fontSize: 12 }} action={!spec.data ? <Button color="inherit" size="small" disabled={spec.loading} onClick={() => void spec.request()}>Retry</Button> : undefined}>{spec.error}</Alert> : null}
            {spec.message ? <Typography role="status" sx={{ mt: 1, fontSize: 12, color: (theme) => theme.palette.success[theme.palette.mode === "dark" ? "light" : "dark"] }}>{spec.message}</Typography> : null}
          </Box>
          <Divider />
          <Box component="section" aria-labelledby="dashboard-approval-label" aria-busy={approval.loading || approval.saving}>
            <Typography id="dashboard-approval-label" sx={{ fontSize: 14, fontWeight: 650 }}>Asset approval limit</Typography>
            <Typography id="dashboard-approval-description" sx={{ mt: 0.5, mb: 1.5, color: "text.secondary", fontSize: 12 }}>Asset reports above this value require manager approval.</Typography>
            <Box component="form" onSubmit={(event) => { event.preventDefault(); setThresholdTouched(true); if (approval.data && !approval.loading && !approval.saving && thresholdValid && thresholdChanged) void approval.request({ threshold: thresholdValue }); }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "flex-start" }}>
                <TextField
                  fullWidth
                  size="small"
                  label="Approval limit"
                  sx={{ "& .MuiInputLabel-root.Mui-focused:not(.Mui-error)": { color: (theme) => theme.palette.primary[theme.palette.mode === "dark" ? "light" : "main"] } }}
                  value={thresholdInput}
                  onChange={(event) => { setThresholdInput(event.target.value); setThresholdTouched(true); approval.clearMessage(); }}
                  disabled={!approval.data || approval.loading || approval.saving}
                  error={thresholdTouched && !thresholdValid}
                  helperText={thresholdTouched && !thresholdValid ? "Enter a number from 0 to 1,000,000,000." : undefined}
                  slotProps={{ htmlInput: { inputMode: "decimal", "aria-describedby": "dashboard-approval-description" } }}
                />
                <Button type="submit" variant="contained" disabled={!approval.data || approval.loading || approval.saving || !thresholdValid || !thresholdChanged} sx={(theme) => ({ minHeight: 40, ...(theme.palette.mode === "dark" ? { "&:not(.Mui-disabled)": { bgcolor: "primary.dark", color: "common.white" }, "&:hover:not(.Mui-disabled)": { bgcolor: "primary.dark" } } : {}) })}>
                  {approval.saving ? "Saving…" : "Save"}
                </Button>
              </Stack>
            </Box>
            {approval.loading ? <Typography role="status" sx={{ mt: 1, fontSize: 12, color: "text.secondary" }}>Loading asset approval limit…</Typography> : null}
            {approval.error ? <Alert severity="error" sx={{ mt: 1.5, fontSize: 12 }} action={!approval.data ? <Button color="inherit" size="small" disabled={approval.loading} onClick={() => void approval.request()}>Retry</Button> : undefined}>{approval.error}</Alert> : null}
            {approval.message ? <Typography role="status" sx={{ mt: 1, fontSize: 12, color: (theme) => theme.palette.success[theme.palette.mode === "dark" ? "light" : "dark"] }}>{approval.message}</Typography> : null}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}><Button variant="outlined" onClick={onClose} sx={(theme) => theme.palette.mode === "dark" ? { color: "primary.light", borderColor: "primary.light" } : {}}>Close</Button></DialogActions>
    </Dialog>
  );
}
