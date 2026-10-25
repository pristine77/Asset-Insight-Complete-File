"use client";

import {
  Ban,
  Check,
  Clock3,
  Filter,
  Globe2,
  Laptop,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  Menu,
  MenuItem,
  Pagination,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import DeviceDetailDrawer from "./DeviceDetailDrawer";
import ManualIpBlockDialog, { validIpAddress } from "./ManualIpBlockDialog";
import type {
  DeviceDetailResponse,
  DeviceRegistration,
  DeviceStatus,
  DeviceSummary,
  IpObservation,
  Pagination as PaginationState,
  SupportContact,
} from "./types";

type TabKey = DeviceStatus | "blocked_ips";
type ConfirmAction =
  | "approve_all"
  | "reject"
  | "revoke"
  | "restore"
  | "delete_device"
  | "disable_all"
  | "block_ip"
  | "unblock_ip";

type Confirmation = {
  action: ConfirmAction;
  device?: DeviceRegistration;
  ip?: IpObservation;
} | null;

const EMPTY_SUMMARY: DeviceSummary = {
  pending: 0,
  rerequest_pending: 0,
  approved: 0,
  rejected: 0,
  revoked: 0,
  blocked_ips: 0,
  requests: 0,
};

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "pending", label: "New requests" },
  { value: "rerequest_pending", label: "Re-requests" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "revoked", label: "Revoked" },
  { value: "blocked_ips", label: "Blocked IPs" },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueText(value: unknown, fallback = "Not reported") {
  return typeof value === "string" && value.trim()
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : fallback;
}

function formatBytes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not reported";
  const gb = value / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

function formatRelative(value?: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function userName(device: DeviceRegistration) {
  return device.user.username || device.user.companyName || device.user.email;
}

function validSupportEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validSupportPhone(value: string) {
  return /^[+()\-\s0-9]{7,30}$/.test(value.trim());
}

function initials(device: DeviceRegistration) {
  const parts = userName(device).split(/\s+|@/).filter(Boolean);
  return `${parts[0]?.[0] || "U"}${parts[1]?.[0] || parts[0]?.[1] || ""}`.toUpperCase();
}

function platformSummary(device: DeviceRegistration) {
  const metadata = record(device.metadata);
  const os = record(metadata.os);
  const browser = record(metadata.browser);
  const app = record(metadata.app);
  const primary =
    device.platform === "web"
      ? `${valueText(browser.name, "Web")} ${valueText(browser.version, "")}`.trim()
      : `${device.platform === "ios" ? "iOS app" : "Android app"} ${valueText(app.version, "")}`.trim();
  const rawOsName = valueText(os.name, "");
  const osName =
    device.platform !== "web" &&
    (!rawOsName || rawOsName.length > 30 || rawOsName.includes("/") || rawOsName.includes("release-keys"))
      ? device.platform === "android"
        ? "Android"
        : "iOS"
      : rawOsName || device.platform;
  return `${primary} · ${osName} ${valueText(os.version, "")}`.trim();
}

function cameraStorageSummary(device: DeviceRegistration) {
  const metadata = record(device.metadata);
  const camera = record(metadata.camera);
  const hardware = record(metadata.hardwareProfile);
  const hardwareCamera = record(hardware.camera);
  const cameras = Array.isArray(camera.devices) ? camera.devices : [];
  const first = record(cameras[0]);
  const storage = record(metadata.storage || metadata.disk);
  const cameraCount = valueText(hardwareCamera.lensCount ?? camera.count ?? cameras.length, "0");
  const runtimeResolution = valueText(first.maxPhotoResolution || first.maxResolution, "");
  const cameraLine =
    camera.verification === "no_camera"
      ? "No camera detected"
      : hardwareCamera.rearMaximumMegapixels
        ? `${cameraCount} cameras · rear up to ${valueText(hardwareCamera.rearMaximumMegapixels)} MP`
        : `${cameraCount} camera(s)${runtimeResolution ? ` · ${runtimeResolution}` : ""}`;
  const available = storage.availableBytes ?? storage.freeBytes;
  const storageLine = `${device.platform === "web" ? "Browser-origin quota" : "Device disk"} · ${formatBytes(available)} free`;
  return { cameraLine, storageLine };
}

function deviceIpSummary(device: DeviceRegistration) {
  const usable = device.ips
    .map((item) => item.ip)
    .filter((ip) => ip && ip !== "127.0.0.1" && ip !== "::1" && ip !== "unknown");
  if (usable.length) return usable.join(", ");
  if (device.lastIp && !["127.0.0.1", "::1", "unknown"].includes(device.lastIp)) return device.lastIp;
  return "Awaiting client IP";
}

function StatusChip({ status }: { status: DeviceStatus }) {
  const config: Record<DeviceStatus, { label: string; color: "warning" | "success" | "error" | "default" }> = {
    pending: { label: "Pending", color: "warning" },
    rerequest_pending: { label: "Re-request", color: "warning" },
    approved: { label: "Approved", color: "success" },
    rejected: { label: "Rejected", color: "error" },
    revoked: { label: "Revoked", color: "default" },
  };
  const item = config[status];
  return <Chip size="small" variant="outlined" color={item.color} label={item.label} sx={{ height: 25, borderRadius: "4px", fontSize: 11.5 }} />;
}

function DeviceGlyph({ device }: { device: DeviceRegistration }) {
  const Icon = device.formFactor === "desktop" ? Laptop : Smartphone;
  return (
    <Box sx={{ display: "grid", width: 52, height: 52, flexShrink: 0, placeItems: "center", border: "1px solid", borderColor: "divider", color: "text.secondary" }}>
      <Icon size={25} strokeWidth={1.7} />
    </Box>
  );
}

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export default function AdminDevices() {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("lg"));
  const [tab, setTab] = useState<TabKey>("pending");
  const [summary, setSummary] = useState<DeviceSummary>(EMPTY_SUMMARY);
  const [devices, setDevices] = useState<DeviceRegistration[]>([]);
  const [ips, setIps] = useState<IpObservation[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({ page: 1, limit: 10, total: 0, pages: 1 });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const [dateRange, setDateRange] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [support, setSupport] = useState<SupportContact>({ name: "", email: "", phone: "" });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [manualIpOpen, setManualIpOpen] = useState(false);
  const [manualIpBusy, setManualIpBusy] = useState(false);
  const [manualIp, setManualIp] = useState({ userEmail: "", ip: "", reason: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeviceDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ severity: "success" | "error"; message: string } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuDevice, setMenuDevice] = useState<DeviceRegistration | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => setPage(1), [tab, platform, dateRange]);

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: "10" });
    if (debouncedQuery) params.set("search", debouncedQuery);
    if (tab === "blocked_ips") {
      params.set("blocked", "true");
      return `/api/admin/device-ips?${params}`;
    }
    params.set("status", tab);
    if (platform) params.set("platform", platform);
    if (dateRange) {
      const days = Number(dateRange);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      params.set("from", from.toISOString());
    }
    return `/api/admin/devices?${params}`;
  }, [dateRange, debouncedQuery, page, platform, tab]);

  const loadSummary = useCallback(async () => {
    const response = await fetch("/api/admin/devices/summary", { cache: "no-store" });
    const body = await responseBody(response);
    if (!response.ok) throw new Error(String(body.message || "Unable to load device counts"));
    setSummary((body.summary as DeviceSummary) || EMPTY_SUMMARY);
  }, []);

  const loadList = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(listUrl, { cache: "no-store", signal });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.message || "Unable to load devices"));
      const nextPagination =
        (body.pagination as PaginationState) || { page, limit: 10, total: 0, pages: 1 };
      if (page > nextPagination.pages) {
        setPage(Math.max(1, nextPagination.pages));
        return;
      }
      if (tab === "blocked_ips") {
        setIps((body.ipObservations as IpObservation[]) || []);
        setDevices([]);
      } else {
        setDevices((body.devices as DeviceRegistration[]) || []);
        setIps([]);
      }
      setPagination(nextPagination);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setFeedback({ severity: "error", message: (error as Error).message });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [listUrl, page, tab]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([loadSummary(), loadList(controller.signal)]).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setFeedback({ severity: "error", message: (error as Error).message });
      }
    });
    return () => controller.abort();
  }, [loadList, loadSummary, refreshVersion]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void Promise.all([loadSummary(), loadList(undefined, true)]).catch(() => undefined);
      }
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadList, loadSummary]);

  const loadDetail = useCallback(async (deviceId: string) => {
    setSelectedId(deviceId);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/admin/devices/${deviceId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.message || "Unable to load device details"));
      setDetail(body as unknown as DeviceDetailResponse);
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function refresh() {
    setRefreshVersion((value) => value + 1);
    if (selectedId) void loadDetail(selectedId);
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
  }

  async function actionRequest(
    url: string,
    options: { method?: "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> },
    successMessage: string,
    refreshSelectedDetail = true
  ) {
    const response = await fetch(url, {
      method: options.method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body || {}),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      if (response.status === 409 && body.code === "DEVICE_STATE_CHANGED") {
        refresh();
      }
      throw new Error(String(body.message || "The device operation failed"));
    }
    setFeedback({ severity: "success", message: successMessage });
    setRefreshVersion((value) => value + 1);
    if (refreshSelectedDetail && selectedId) void loadDetail(selectedId);
  }

  async function approveOne(device: DeviceRegistration) {
    setBusy(true);
    try {
      await actionRequest(`/api/admin/devices/${device.id}/approve`, {
        body: { scope: "device" },
      }, `${device.displayName} approved.`);
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function requestDeviceAction(
    action: "approve" | "approve_all" | "reject" | "revoke" | "restore" | "disable_all" | "delete_device",
    device: DeviceRegistration
  ) {
    if (action === "approve") {
      void approveOne(device);
      return;
    }
    setReason(action === "reject" ? device.decisionReason || "" : "");
    setConfirmation({ action, device });
  }

  function requestIpAction(ip: IpObservation, blocked: boolean) {
    setReason("");
    setConfirmation({ action: blocked ? "block_ip" : "unblock_ip", ip });
  }

  const reasonRequired = Boolean(confirmation && confirmation.action !== "reject");

  async function confirmAction() {
    if (!confirmation || (reasonRequired && !reason.trim())) return;
    setBusy(true);
    try {
      const { action, device, ip } = confirmation;
      if (action === "approve_all" && device) {
        await actionRequest(`/api/admin/devices/${device.id}/approve`, {
          body: { scope: "all_devices", reason: reason.trim() },
        }, `All current and future devices for ${userName(device)} are approved.`);
      } else if (action === "reject" && device) {
        await actionRequest(`/api/admin/devices/${device.id}/reject`, {
          body: { reason: reason.trim() || undefined },
        }, `${device.displayName} rejected.`);
      } else if ((action === "revoke" || action === "restore") && device) {
        await actionRequest(`/api/admin/devices/${device.id}/${action}`, {
          body: { reason: reason.trim() },
        }, `${device.displayName} ${action === "revoke" ? "revoked" : "restored"}.`);
      } else if (action === "disable_all" && device) {
        await actionRequest(`/api/admin/users/${device.user._id}/device-approval-policy`, {
          method: "PATCH",
          body: { mode: "per_device", reason: reason.trim() },
        }, `Future devices for ${userName(device)} now require approval.`);
      } else if ((action === "block_ip" || action === "unblock_ip") && ip) {
        await actionRequest(`/api/admin/device-ips/${ip.id || ip._id}/${action === "block_ip" ? "block" : "unblock"}`, {
          body: { reason: reason.trim() },
        }, `${ip.ip} ${action === "block_ip" ? "blocked" : "unblocked"} for this user.`);
      } else if (action === "delete_device" && device) {
        await actionRequest(`/api/admin/devices/${device.id}`, {
          method: "DELETE",
          body: { reason: reason.trim() },
        }, `${device.displayName} was deleted. Its next sign-in will create a new device registration.`, false);
        closeDetail();
      }
      setConfirmation(null);
      setReason("");
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function openSettings() {
    setSettingsOpen(true);
    try {
      const response = await fetch("/api/admin/device-security-settings", { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.message || "Unable to load settings"));
      setSupport((body.supportContact as SupportContact) || { name: "", email: "", phone: "" });
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    }
  }

  async function saveSettings() {
    setSettingsBusy(true);
    try {
      const response = await fetch("/api/admin/device-security-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supportContact: support }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.message || "Unable to save support contact"));
      setSettingsOpen(false);
      setFeedback({ severity: "success", message: "Device security support contact saved." });
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    } finally {
      setSettingsBusy(false);
    }
  }

  async function submitManualIpBlock() {
    if (
      !validSupportEmail(manualIp.userEmail) ||
      !validIpAddress(manualIp.ip) ||
      !manualIp.reason.trim()
    ) return;
    setManualIpBusy(true);
    try {
      const response = await fetch("/api/admin/device-ips/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEmail: manualIp.userEmail.trim(),
          ip: manualIp.ip.trim(),
          reason: manualIp.reason.trim(),
        }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.message || "Unable to block this IP address"));
      setManualIpOpen(false);
      setManualIp({ userEmail: "", ip: "", reason: "" });
      setTab("blocked_ips");
      setPage(1);
      setFeedback({ severity: "success", message: "IP address blocked for this user." });
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setFeedback({ severity: "error", message: (error as Error).message });
    } finally {
      setManualIpBusy(false);
    }
  }

  function openMenu(event: React.MouseEvent<HTMLElement>, device: DeviceRegistration) {
    event.stopPropagation();
    setMenuAnchor(event.currentTarget);
    setMenuDevice(device);
  }

  function closeMenu() {
    setMenuAnchor(null);
    setMenuDevice(null);
  }

  const actionLabel: Record<ConfirmAction, string> = {
    approve_all: "Approve all devices",
    reject: "Reject device",
    revoke: "Revoke device",
    restore: "Restore device",
    delete_device: "Delete device registration",
    disable_all: "Require per-device approval",
    block_ip: "Block IP address",
    unblock_ip: "Unblock IP address",
  };

  const actionCopy: Record<ConfirmAction, string> = {
    approve_all: "This approves the user’s current requests and automatically approves future installations after metadata collection. Rejected and revoked devices stay restricted.",
    reject: "The user will see the rejection and can submit a new request. A reason is optional.",
    revoke: "Refresh tokens for this device are removed immediately and outstanding access is blocked.",
    restore: "The device is restored, but the user must authenticate again before access resumes.",
    delete_device: "This permanently removes the registration, invalidates its sessions, and makes this installation register again at its next sign-in. If the user has the all-devices policy, the new registration will follow that policy.",
    disable_all: "Existing approved devices remain approved. Only future installations will require individual review.",
    block_ip: "This exact address is blocked only for this user. Other accounts on the same network are unaffected.",
    unblock_ip: "This user can access Asset Insight from the exact address again.",
  };

  const filterControls = (
    <>
      <FormControl fullWidth size="small">
        <InputLabel>Platform</InputLabel>
        <Select label="Platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
          <MenuItem value="">All platforms</MenuItem>
          <MenuItem value="web">Web</MenuItem>
          <MenuItem value="android">Android</MenuItem>
          <MenuItem value="ios">iOS</MenuItem>
        </Select>
      </FormControl>
      <FormControl fullWidth size="small">
        <InputLabel>Date</InputLabel>
        <Select label="Date" value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
          <MenuItem value="">All dates</MenuItem>
          <MenuItem value="7">Last 7 days</MenuItem>
          <MenuItem value="30">Last 30 days</MenuItem>
          <MenuItem value="90">Last 90 days</MenuItem>
        </Select>
      </FormControl>
    </>
  );

  return (
    <Box sx={{ mx: "auto", width: "100%", maxWidth: 1380, px: { xs: 2, sm: 3, xl: 4 }, py: { xs: 3, lg: 5 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "flex-start" }} justifyContent="space-between" spacing={2.5}>
        <Box>
          <Typography component="h1" sx={{ fontSize: { xs: 34, lg: 38 }, fontWeight: 650, letterSpacing: "-0.04em", lineHeight: 1.05 }}>Devices</Typography>
          <Typography sx={{ mt: 1.15, color: "text.secondary", fontSize: { xs: 14, sm: 15 } }}>Review device access requests, trusted devices, and blocked IPs.</Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Button variant="contained" color="error" startIcon={<Ban size={16} />} onClick={() => setManualIpOpen(true)}>Block IP</Button>
          <Button variant="outlined" color="secondary" startIcon={<RefreshCw size={16} />} onClick={refresh} disabled={loading}>Refresh</Button>
          <Button sx={{ display: { xs: "none", sm: "inline-flex" } }} variant="outlined" color="secondary" startIcon={<Settings size={16} />} onClick={() => void openSettings()}>Security settings</Button>
        </Stack>
      </Stack>

      <Box sx={{ mt: { xs: 3.5, lg: 4.5 }, borderBottom: "1px solid", borderColor: "divider" }}>
        <Tabs
          value={tab}
          onChange={(_event, value: TabKey) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Device status views"
          sx={{ minHeight: 48, "& .MuiTab-root": { minHeight: 48, px: { xs: 2, sm: 2.25 }, fontSize: 13, fontWeight: 600 } }}
        >
          {TABS.map((item) => (
            <Tab
              key={item.value}
              value={item.value}
              label={
                <Stack component="span" direction="row" alignItems="center" spacing={0.75}>
                  <span>{item.label}</span>
                  <Box component="span" sx={{ display: "inline-grid", minWidth: 22, height: 22, placeItems: "center", borderRadius: "50%", bgcolor: (currentTheme) => alpha(currentTheme.palette.text.secondary, 0.1), px: 0.6, fontSize: 11 }}>
                    {summary[item.value] || 0}
                  </Box>
                </Stack>
              }
            />
          ))}
        </Tabs>
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ py: 2.75 }}>
        <TextField
          fullWidth
          size="small"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search user, device, or IP"
          inputProps={{ "aria-label": "Search devices" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><Search size={18} /></InputAdornment> }}
          sx={{ maxWidth: { lg: 470 } }}
        />
        {desktop && tab !== "blocked_ips" ? (
          <Stack direction="row" spacing={1.5} sx={{ width: 430 }}>{filterControls}</Stack>
        ) : tab !== "blocked_ips" ? (
          <Button variant="outlined" color="secondary" startIcon={<Filter size={17} />} onClick={() => setFiltersOpen(true)} sx={{ flexShrink: 0 }}>Filter</Button>
        ) : null}
        <IconButton sx={{ display: { xs: "inline-flex", sm: "none" } }} aria-label="Security settings" onClick={() => void openSettings()}><Settings size={19} /></IconButton>
      </Stack>

      {loading ? (
        <Stack spacing={1}>
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} variant="rectangular" height={desktop ? 72 : 240} />)}
        </Stack>
      ) : tab === "blocked_ips" ? (
        desktop ? (
          <TableContainer sx={{ border: "1px solid", borderColor: "divider" }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>User</TableCell><TableCell>IP address</TableCell><TableCell>Devices</TableCell><TableCell>Last seen</TableCell><TableCell>Reason</TableCell><TableCell align="right">Action</TableCell></TableRow></TableHead>
              <TableBody>
                {ips.map((ip) => (
                  <TableRow key={ip.id || ip._id} hover>
                    <TableCell><Typography sx={{ fontSize: 13, fontWeight: 650 }}>{ip.user?.username || ip.user?.companyName || ip.user?.email || "Unknown user"}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11.5 }}>{ip.user?.email}</Typography></TableCell>
                    <TableCell sx={{ fontFamily: "var(--font-geist-mono)", fontSize: 12.5 }}>{ip.ip}</TableCell>
                    <TableCell sx={{ fontSize: 12.5 }}>{ip.devices?.map((item) => item.displayName).join(", ") || "Unassigned"}</TableCell>
                    <TableCell sx={{ fontSize: 12.5 }}>{formatRelative(ip.lastSeenAt)}</TableCell>
                    <TableCell sx={{ maxWidth: 260, fontSize: 12.5 }}>{ip.blockReason || ip.reason || "—"}</TableCell>
                    <TableCell align="right"><Button color="success" size="small" variant="outlined" startIcon={<RotateCcw size={14} />} onClick={() => requestIpAction(ip, false)}>Unblock</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Stack spacing={1.5}>{ips.map((ip) => (
            <Card key={ip.id || ip._id}><CardContent><Stack direction="row" justifyContent="space-between" spacing={2}><Box><Typography sx={{ fontSize: 15, fontWeight: 700 }}>{ip.user?.username || ip.user?.companyName || "Unknown user"}</Typography><Typography sx={{ color: "text.secondary", fontSize: 12 }}>{ip.user?.email}</Typography></Box><Chip size="small" color="error" variant="outlined" label="Blocked" /></Stack><Divider sx={{ my: 2 }} /><Stack spacing={0.8}><Typography sx={{ fontFamily: "var(--font-geist-mono)", fontSize: 13 }}>{ip.ip}</Typography><Typography sx={{ color: "text.secondary", fontSize: 12 }}>{ip.devices?.map((item) => item.displayName).join(", ") || "No linked device"}</Typography><Typography sx={{ fontSize: 12 }}>Reason: {ip.blockReason || ip.reason || "Not supplied"}</Typography></Stack><Button fullWidth sx={{ mt: 2 }} color="success" variant="outlined" startIcon={<RotateCcw size={15} />} onClick={() => requestIpAction(ip, false)}>Unblock IP</Button></CardContent></Card>
          ))}</Stack>
        )
      ) : desktop ? (
        <TableContainer sx={{ borderTop: "1px solid", borderBottom: "1px solid", borderColor: "divider" }}>
          <Table size="small">
            <TableHead><TableRow><TableCell>User</TableCell><TableCell>Device</TableCell><TableCell>Camera & storage</TableCell><TableCell>IP addresses</TableCell><TableCell>Requested</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
            <TableBody>
              {devices.map((device) => {
                const details = cameraStorageSummary(device);
                return (
                  <TableRow
                    key={device.id}
                    hover
                    tabIndex={0}
                    aria-label={`View details for ${device.displayName}`}
                    onClick={() => void loadDetail(device.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void loadDetail(device.id);
                      }
                    }}
                    sx={{ cursor: "pointer", "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: -3 }, "& td:first-of-type": { borderLeft: selectedId === device.id ? "3px solid" : "3px solid transparent", borderLeftColor: selectedId === device.id ? "primary.main" : "transparent" } }}
                  >
                    <TableCell><Typography sx={{ fontSize: 13, fontWeight: 650 }}>{userName(device)}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11.5 }}>{device.user.email}</Typography></TableCell>
                    <TableCell><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{device.displayName}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11.5 }}>{platformSummary(device)}</Typography></TableCell>
                    <TableCell><Typography sx={{ fontSize: 12 }}>{details.cameraLine}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11.5 }}>{details.storageLine}</Typography></TableCell>
                    <TableCell sx={{ maxWidth: 190, fontFamily: "var(--font-geist-mono)", fontSize: 11.5 }}>{deviceIpSummary(device)}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{formatRelative(device.requestedAt)}</TableCell>
                    <TableCell><StatusChip status={device.status} /></TableCell>
                    <TableCell align="right"><IconButton aria-label={`Actions for ${device.displayName}`} size="small" onClick={(event) => openMenu(event, device)}><MoreHorizontal size={18} /></IconButton></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Stack spacing={1.5}>
          {devices.map((device) => {
            const details = cameraStorageSummary(device);
            const pending = ["pending", "rerequest_pending"].includes(device.status);
            return (
              <Card key={device.id}>
                <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ p: 2.25 }}>
                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minWidth: 0 }}><Avatar sx={{ bgcolor: (currentTheme) => alpha(currentTheme.palette.text.secondary, 0.12), color: "text.primary", fontSize: 15, fontWeight: 700 }}>{initials(device)}</Avatar><Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 15, fontWeight: 700 }}>{userName(device)}</Typography><Typography noWrap sx={{ color: "text.secondary", fontSize: 12 }}>{device.user.email}</Typography></Box></Stack><StatusChip status={device.status} />
                  </Stack>
                  <Divider />
                  <Box sx={{ p: 2.25 }}>
                    <Stack direction="row" spacing={1.75}><DeviceGlyph device={device} /><Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: 16, fontWeight: 700 }}>{device.displayName}</Typography><Typography sx={{ mt: 0.3, color: "text.secondary", fontSize: 12.5 }}>{platformSummary(device)}</Typography><Typography sx={{ mt: 0.3, color: "text.secondary", fontSize: 12.5 }}>{details.cameraLine}</Typography><Typography sx={{ mt: 0.3, color: "text.secondary", fontSize: 12.5 }}>{details.storageLine}</Typography></Box></Stack>
                    <Stack spacing={0.8} sx={{ mt: 2 }}><Stack direction="row" alignItems="center" spacing={1}><Globe2 size={16} /><Typography sx={{ color: "text.secondary", fontFamily: "var(--font-geist-mono)", fontSize: 12 }}>{deviceIpSummary(device)}</Typography></Stack><Stack direction="row" alignItems="center" spacing={1}><Clock3 size={16} /><Typography sx={{ color: "text.secondary", fontSize: 12 }}>{device.status === "rerequest_pending" ? "Requested again" : "Requested"} {formatRelative(device.requestedAt)}</Typography></Stack></Stack>
                    {pending ? <Stack spacing={0.85} sx={{ mt: 2.25 }}><Button fullWidth variant="contained" startIcon={<Check size={16} />} onClick={() => void approveOne(device)}>Approve device</Button><Button fullWidth color="secondary" variant="outlined" startIcon={<ShieldCheck size={16} />} onClick={() => requestDeviceAction("approve_all", device)}>Approve all devices</Button><Button fullWidth color="error" variant="text" startIcon={<Ban size={16} />} onClick={() => requestDeviceAction("reject", device)}>Reject</Button></Stack> : <Stack direction="row" spacing={1} sx={{ mt: 2.25 }}>{device.status === "approved" ? <Button fullWidth color="error" variant="outlined" onClick={() => requestDeviceAction("revoke", device)}>Revoke</Button> : <Button fullWidth variant="outlined" onClick={() => requestDeviceAction("restore", device)}>Restore</Button>}</Stack>}
                    <Button fullWidth color="secondary" variant="text" sx={{ mt: 1 }} onClick={() => void loadDetail(device.id)}>View details</Button>
                  </Box>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}

      {!loading && (tab === "blocked_ips" ? ips.length === 0 : devices.length === 0) ? (
        <Box sx={{ display: "grid", minHeight: 260, placeItems: "center", border: "1px solid", borderColor: "divider", p: 4, textAlign: "center" }}><Box><Typography sx={{ fontSize: 16, fontWeight: 650 }}>No matching records</Typography><Typography sx={{ mt: 0.75, color: "text.secondary", fontSize: 13 }}>Try another tab or clear the current filters.</Typography></Box></Box>
      ) : null}

      {!loading && pagination.total > 0 ? (
        <Stack direction={{ xs: "column", sm: "row" }} alignItems="center" justifyContent="space-between" spacing={2} sx={{ py: 3 }}><Typography sx={{ color: "text.secondary", fontSize: 12 }}>Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} results</Typography><Pagination page={page} count={pagination.pages} onChange={(_event, value) => setPage(value)} color="primary" shape="rounded" /></Stack>
      ) : null}

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu} onClick={(event) => event.stopPropagation()}>
        {menuDevice ? <MenuItem onClick={() => { void loadDetail(menuDevice.id); closeMenu(); }}>View details</MenuItem> : null}
        {menuDevice && ["pending", "rerequest_pending"].includes(menuDevice.status) ? [
          <MenuItem key="approve" onClick={() => { void approveOne(menuDevice); closeMenu(); }}>Approve device</MenuItem>,
          <MenuItem key="all" onClick={() => { requestDeviceAction("approve_all", menuDevice); closeMenu(); }}>Approve all devices</MenuItem>,
          <MenuItem key="reject" sx={{ color: "error.main" }} onClick={() => { requestDeviceAction("reject", menuDevice); closeMenu(); }}>Reject</MenuItem>,
        ] : null}
        {menuDevice?.status === "approved" ? <MenuItem sx={{ color: "error.main" }} onClick={() => { requestDeviceAction("revoke", menuDevice); closeMenu(); }}>Revoke</MenuItem> : null}
        {menuDevice && ["rejected", "revoked"].includes(menuDevice.status) ? <MenuItem onClick={() => { requestDeviceAction("restore", menuDevice); closeMenu(); }}>Restore</MenuItem> : null}
        {menuDevice ? <Divider /> : null}
        {menuDevice ? <MenuItem sx={{ color: "error.main" }} onClick={() => { requestDeviceAction("delete_device", menuDevice); closeMenu(); }}><Trash2 size={16} style={{ marginRight: 10 }} />Delete registration</MenuItem> : null}
      </Menu>

      <DeviceDetailDrawer open={Boolean(selectedId)} loading={detailLoading} detail={detail} onClose={closeDetail} onAction={requestDeviceAction} onIpAction={requestIpAction} />

      {confirmation ? (
        <Dialog open onClose={busy ? undefined : () => setConfirmation(null)} fullWidth maxWidth="xs">
          <DialogTitle>{actionLabel[confirmation.action]}</DialogTitle>
          <DialogContent><Typography sx={{ color: "text.secondary", fontSize: 13.5 }}>{actionCopy[confirmation.action]}</Typography><TextField autoFocus fullWidth multiline minRows={3} value={reason} onChange={(event) => setReason(event.target.value)} label={reasonRequired ? "Audit reason" : "Rejection reason (optional)"} placeholder={reasonRequired ? "Explain why this change is required" : "Optional note shown to the user"} sx={{ mt: 2.5 }} inputProps={{ maxLength: 1000 }} /></DialogContent>
          <DialogActions><Button color="secondary" onClick={() => setConfirmation(null)} disabled={busy}>Cancel</Button><Button variant="contained" color={["reject", "revoke", "block_ip", "delete_device"].includes(confirmation.action) ? "error" : "primary"} onClick={() => void confirmAction()} disabled={busy || (reasonRequired && !reason.trim())}>{busy ? <CircularProgress size={18} color="inherit" /> : actionLabel[confirmation.action]}</Button></DialogActions>
        </Dialog>
      ) : null}

      <ManualIpBlockDialog
        open={manualIpOpen}
        busy={manualIpBusy}
        value={manualIp}
        onChange={setManualIp}
        onClose={() => setManualIpOpen(false)}
        onSubmit={() => void submitManualIpBlock()}
      />

      <Dialog open={settingsOpen} onClose={settingsBusy ? undefined : () => setSettingsOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Device security settings</DialogTitle><DialogContent><Alert severity="info" sx={{ mb: 2 }}>All three support fields must be valid before device approval enforcement can be enabled.</Alert><Stack spacing={2}><TextField autoFocus label="Support name" value={support.name} onChange={(event) => setSupport((current) => ({ ...current, name: event.target.value }))} inputProps={{ maxLength: 120 }} error={Boolean(support.name) && support.name.trim().length < 2} helperText={Boolean(support.name) && support.name.trim().length < 2 ? "Enter at least 2 characters" : " "} /><TextField type="email" label="Support email" value={support.email} onChange={(event) => setSupport((current) => ({ ...current, email: event.target.value }))} inputProps={{ maxLength: 200 }} error={Boolean(support.email) && !validSupportEmail(support.email)} helperText={Boolean(support.email) && !validSupportEmail(support.email) ? "Enter a valid email address" : " "} /><TextField type="tel" label="Support phone" value={support.phone} onChange={(event) => setSupport((current) => ({ ...current, phone: event.target.value }))} inputProps={{ maxLength: 30 }} error={Boolean(support.phone) && !validSupportPhone(support.phone)} helperText={Boolean(support.phone) && !validSupportPhone(support.phone) ? "Use 7–30 digits and phone punctuation" : " "} /></Stack></DialogContent><DialogActions><Button color="secondary" onClick={() => setSettingsOpen(false)} disabled={settingsBusy}>Cancel</Button><Button variant="contained" onClick={() => void saveSettings()} disabled={settingsBusy || support.name.trim().length < 2 || !validSupportEmail(support.email) || !validSupportPhone(support.phone)}>{settingsBusy ? <CircularProgress size={18} color="inherit" /> : "Save settings"}</Button></DialogActions>
      </Dialog>

      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} fullWidth maxWidth="xs"><DialogTitle>Filter devices</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 0.5 }}>{filterControls}</Stack></DialogContent><DialogActions><Button color="secondary" onClick={() => { setPlatform(""); setDateRange(""); }}>Clear</Button><Button variant="contained" onClick={() => setFiltersOpen(false)}>Apply filters</Button></DialogActions></Dialog>

      <Snackbar open={Boolean(feedback)} autoHideDuration={5000} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>{feedback ? <Alert severity={feedback.severity} variant="filled" onClose={() => setFeedback(null)}>{feedback.message}</Alert> : undefined}</Snackbar>
    </Box>
  );
}
