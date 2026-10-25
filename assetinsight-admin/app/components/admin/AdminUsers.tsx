"use client";

import dynamic from "next/dynamic";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  BlockRounded,
  CheckCircleOutlineRounded,
  ChevronRightRounded,
  DeleteOutlineRounded,
  EditRounded,
  GroupRounded,
  LockOpenRounded,
  RefreshRounded,
  RestartAltRounded,
  SaveRounded,
  SearchRounded,
  SupervisorAccountRounded,
} from "@mui/icons-material";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AdminUserListItem,
  type AdminUsersResponse,
  type AssignmentOption,
  type PreviewSupervisorSettingResponse,
  assignmentId,
  assignmentLabel,
  userDisplayName,
} from "./users/types";

const UserProfileDrawer = dynamic(() => import("./users/UserProfileDrawer"), {
  ssr: false,
  loading: () => null,
});

type Feedback = { message: string; severity: "success" | "error" } | null;
type Confirmation = { user: AdminUserListItem; action: "delete" | "block" } | null;

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

function initials(user: AdminUserListItem): string {
  return userDisplayName(user).slice(0, 2).toUpperCase();
}

function AssignmentSelect({
  value,
  options,
  label,
  disabled,
  onChange,
}: {
  value: string;
  options: AssignmentOption[];
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FormControl size="small" fullWidth>
      <Select
        value={value}
        displayEmpty
        disabled={disabled}
        inputProps={{ "aria-label": label }}
        onChange={(event) => onChange(String(event.target.value))}
        renderValue={(selected) => {
          if (!selected) return <Typography variant="body2" color="text.secondary">Not assigned</Typography>;
          const option = options.find((item) => item._id === selected);
          return <Typography variant="body2" noWrap>{option ? assignmentLabel(option) : "Assigned user"}</Typography>;
        }}
        sx={{ minWidth: 0, "& .MuiSelect-select": { py: 0.85 } }}
      >
        <MenuItem value="">Not assigned</MenuItem>
        {options.map((option) => (
          <MenuItem key={option._id} value={option._id}>{assignmentLabel(option)}</MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function UserIdentity({ user }: { user: AdminUserListItem }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
      <Avatar src={user.avatarUrl || undefined} sx={{ width: 38, height: 38, bgcolor: user.isBlocked ? "grey.500" : "primary.main", fontSize: 14 }}>
        {initials(user)}
      </Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" fontWeight={700} noWrap>{userDisplayName(user)}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">{user.email}</Typography>
        {user.companyName && user.companyName !== userDisplayName(user) && (
          <Typography variant="caption" color="text.secondary" noWrap display="block">{user.companyName}</Typography>
        )}
      </Box>
    </Stack>
  );
}

export default function AdminUsers() {
  const theme = useTheme();
  const showTable = useMediaQuery(theme.breakpoints.up("lg"));
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [accountStatus, setAccountStatus] = useState("");
  const [crmStatus, setCrmStatus] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [assignmentOptions, setAssignmentOptions] = useState<AssignmentOption[]>([]);
  const [previewSupervisorOptions, setPreviewSupervisorOptions] = useState<AssignmentOption[]>([]);
  const [previewSupervisor, setPreviewSupervisor] = useState("");
  const [savedPreviewSupervisor, setSavedPreviewSupervisor] = useState("");
  const [previewSupervisorLoading, setPreviewSupervisorLoading] = useState(true);
  const [previewSupervisorSaving, setPreviewSupervisorSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (accountStatus === "active") params.set("isBlocked", "false");
    if (accountStatus === "blocked") params.set("isBlocked", "true");
    if (crmStatus === "crm") params.set("isCrmAgent", "true");
    if (crmStatus === "noncrm") params.set("isCrmAgent", "false");
    return params.toString();
  }, [accountStatus, crmStatus, debouncedQuery, limit, page]);

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users?${queryString}`, { cache: "no-store", signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to load users");
      const next = body as AdminUsersResponse;
      setData(next);
      if (Array.isArray(next.assignmentOptions)) setAssignmentOptions(next.assignmentOptions);
    } catch (cause: unknown) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Failed to load users");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, [loadUsers, refreshVersion]);

  const loadPreviewSupervisor = useCallback(async (signal?: AbortSignal) => {
    setPreviewSupervisorLoading(true);
    try {
      const response = await fetch("/api/admin/preview-supervisor", {
        cache: "no-store",
        signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to load preview supervisor");
      const setting = body as PreviewSupervisorSettingResponse;
      const selectedId = assignmentId(setting.previewSupervisor);
      setPreviewSupervisorOptions(Array.isArray(setting.options) ? setting.options : []);
      setPreviewSupervisor(selectedId);
      setSavedPreviewSupervisor(selectedId);
    } catch (cause: unknown) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      notify(cause instanceof Error ? cause.message : "Failed to load preview supervisor", "error");
    } finally {
      if (!signal?.aborted) setPreviewSupervisorLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreviewSupervisor(controller.signal);
    return () => controller.abort();
  }, [loadPreviewSupervisor, refreshVersion]);

  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / limit));
  const rows = data?.items || [];

  function notify(message: string, severity: "success" | "error") {
    setFeedback({ message, severity });
  }

  async function savePreviewSupervisor() {
    setPreviewSupervisorSaving(true);
    try {
      const response = await fetch("/api/admin/preview-supervisor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewSupervisor: previewSupervisor || null }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to save preview supervisor");
      const setting = body as PreviewSupervisorSettingResponse;
      const selectedId = assignmentId(setting.previewSupervisor);
      setPreviewSupervisorOptions(Array.isArray(setting.options) ? setting.options : []);
      setPreviewSupervisor(selectedId);
      setSavedPreviewSupervisor(selectedId);
      notify(selectedId ? "Preview supervisor saved" : "Preview supervisor cleared", "success");
    } catch (cause: unknown) {
      notify(cause instanceof Error ? cause.message : "Failed to save preview supervisor", "error");
    } finally {
      setPreviewSupervisorSaving(false);
    }
  }

  async function patchProfile(userId: string, payload: Record<string, unknown>, successMessage: string) {
    setBusyUserId(userId);
    try {
      const response = await fetch(`/api/admin/users/${userId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to update user");
      notify(successMessage, "success");
      await loadUsers();
    } catch (cause: unknown) {
      notify(cause instanceof Error ? cause.message : "Failed to update user", "error");
    } finally {
      setBusyUserId(null);
    }
  }

  async function confirmAction() {
    if (!confirmation) return;
    const { user, action } = confirmation;
    setBusyUserId(user._id);
    try {
      const response = await fetch(
        action === "delete" ? `/api/admin/users/${user._id}` : `/api/admin/users/${user._id}/block`,
        action === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ blocked: !user.isBlocked }),
            },
      );
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to update user");
      notify(action === "delete" ? "User deleted" : user.isBlocked ? "User unblocked" : "User blocked", "success");
      setConfirmation(null);
      await loadUsers();
    } catch (cause: unknown) {
      notify(cause instanceof Error ? cause.message : "Failed to update user", "error");
    } finally {
      setBusyUserId(null);
    }
  }

  function resetFilters() {
    setQuery("");
    setDebouncedQuery("");
    setAccountStatus("");
    setCrmStatus("");
    setPage(1);
  }

  const userActions = (user: AdminUserListItem) => (
    <Stack direction="row" spacing={0.25} alignItems="center" justifyContent="flex-end">
      <Tooltip title="View and edit profile"><IconButton size="small" onClick={() => setProfileUserId(user._id)}><EditRounded fontSize="small" /></IconButton></Tooltip>
      <Tooltip title={user.isBlocked ? "Unblock user" : "Block user"}>
        <span>
          <IconButton size="small" disabled={busyUserId === user._id} onClick={() => setConfirmation({ user, action: "block" })}>
            {user.isBlocked ? <LockOpenRounded fontSize="small" /> : <BlockRounded fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Delete user"><span><IconButton size="small" color="error" disabled={busyUserId === user._id} onClick={() => setConfirmation({ user, action: "delete" })}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
    </Stack>
  );

  return (
    <Box sx={{ width: "100%", minWidth: 0, px: { xs: 1.5, sm: 2.5, xl: 3 }, py: { xs: 2, md: 3 }, overflowX: "hidden" }}>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={2} mb={2.5}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h4" component="h1" fontWeight={750}>Users</Typography>
            <Chip label={data?.total ?? 0} size="small" variant="outlined" />
          </Stack>
          <Typography color="text.secondary">Manage account access, CRM roles, report approvers, and release managers.</Typography>
        </Box>
        <Button variant="outlined" startIcon={<RefreshRounded />} onClick={() => setRefreshVersion((value) => value + 1)} disabled={loading}>Refresh</Button>
      </Stack>

      <Paper sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
          spacing={2}
        >
          <Stack direction="row" spacing={1.25} alignItems="flex-start" sx={{ minWidth: 0 }}>
            <Box
              sx={{
                width: 40,
                height: 40,
                flex: "0 0 auto",
                display: "grid",
                placeItems: "center",
                color: "primary.main",
                bgcolor: "action.hover",
                borderRadius: 1,
              }}
            >
              <SupervisorAccountRounded />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography fontWeight={750}>Preview Supervisor</Typography>
              <Typography variant="body2" color="text.secondary">
                Select one person to receive 12-hour draft and preview reminders for all users. Report owners still receive their own reminder.
              </Typography>
            </Box>
          </Stack>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            alignItems="stretch"
            sx={{ width: { xs: "100%", md: 500 }, flex: "0 0 auto" }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {previewSupervisorLoading ? (
                <Skeleton variant="rounded" height={40} />
              ) : (
                <AssignmentSelect
                  label="Preview Supervisor"
                  value={previewSupervisor}
                  options={previewSupervisorOptions}
                  disabled={previewSupervisorSaving}
                  onChange={setPreviewSupervisor}
                />
              )}
            </Box>
            <Button
              variant="contained"
              startIcon={previewSupervisorSaving ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
              disabled={
                previewSupervisorLoading ||
                previewSupervisorSaving ||
                previewSupervisor === savedPreviewSupervisor
              }
              onClick={() => void savePreviewSupervisor()}
              sx={{ minWidth: 112 }}
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(260px, 1fr) 170px", md: "minmax(300px, 1fr) 180px 180px auto" }, gap: 1.25, alignItems: "center" }}>
          <TextField
            size="small"
            placeholder="Search name, email, or company"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
          />
          <TextField select size="small" label="Account status" value={accountStatus} onChange={(event) => { setAccountStatus(event.target.value); setPage(1); }}>
            <MenuItem value="">All accounts</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="blocked">Blocked</MenuItem>
          </TextField>
          <TextField select size="small" label="CRM access" value={crmStatus} onChange={(event) => { setCrmStatus(event.target.value); setPage(1); }}>
            <MenuItem value="">All CRM states</MenuItem>
            <MenuItem value="crm">CRM agents</MenuItem>
            <MenuItem value="noncrm">No CRM access</MenuItem>
          </TextField>
          <Button variant="text" color="secondary" startIcon={<RestartAltRounded />} onClick={resetFilters}>Reset</Button>
        </Box>
      </Paper>

      {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setRefreshVersion((value) => value + 1)}>Retry</Button>} sx={{ mb: 2 }}>{error}</Alert>}

      <Paper sx={{ overflow: "hidden" }}>
        {showTable ? (
          <TableContainer sx={{ overflowX: "hidden" }}>
            <Table size="small" sx={{ tableLayout: "fixed" }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: "22%" }}>User</TableCell>
                  <TableCell sx={{ width: "12%" }}>Access</TableCell>
                  <TableCell sx={{ width: "20%" }}>Report approver</TableCell>
                  <TableCell sx={{ width: "20%" }}>Release manager</TableCell>
                  <TableCell sx={{ width: "15%" }}>Status</TableCell>
                  <TableCell align="right" sx={{ width: "11%" }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading && rows.length === 0
                  ? Array.from({ length: 6 }, (_, index) => (
                      <TableRow key={index}>{Array.from({ length: 6 }, (__, cell) => <TableCell key={cell}><Skeleton height={34} /></TableCell>)}</TableRow>
                    ))
                  : rows.map((user) => (
                      <TableRow key={user._id} hover>
                        <TableCell><UserIdentity user={user} /></TableCell>
                        <TableCell>
                          <Stack spacing={0.25}>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Switch size="small" checked={Boolean(user.isCrmAgent)} disabled={busyUserId === user._id} onChange={() => void patchProfile(user._id, { isCrmAgent: !user.isCrmAgent }, user.isCrmAgent ? "CRM access removed" : "CRM access enabled")} />
                              <Typography variant="caption">CRM</Typography>
                            </Stack>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Switch size="small" checked={Boolean(user.proposalValuationEnabled)} disabled={busyUserId === user._id} onChange={() => void patchProfile(user._id, { proposalValuationEnabled: !user.proposalValuationEnabled }, user.proposalValuationEnabled ? "Proposal Valuation disabled" : "Proposal Valuation enabled")} />
                              <Typography variant="caption">PV</Typography>
                            </Stack>
                          </Stack>
                        </TableCell>
                        <TableCell><AssignmentSelect label="Report approver" value={assignmentId(user.reportApprover)} options={assignmentOptions} disabled={busyUserId === user._id} onChange={(value) => void patchProfile(user._id, { reportApprover: value || null }, "Report approver updated")} /></TableCell>
                        <TableCell><AssignmentSelect label="Release manager" value={assignmentId(user.releaseManager)} options={assignmentOptions} disabled={busyUserId === user._id} onChange={(value) => void patchProfile(user._id, { releaseManager: value || null }, "Release manager updated")} /></TableCell>
                        <TableCell>
                          <Stack spacing={0.25} alignItems="flex-start">
                            <Chip size="small" label={user.isBlocked ? "Blocked" : "Active"} color={user.isBlocked ? "error" : "success"} variant="outlined" icon={user.isBlocked ? <BlockRounded /> : <CheckCircleOutlineRounded />} />
                            <Typography variant="caption" color="text.secondary">Joined {formatDate(user.createdAt)}</Typography>
                          </Stack>
                        </TableCell>
                        <TableCell align="right">{userActions(user)}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Stack divider={<Box sx={{ borderTop: 1, borderColor: "divider" }} />}>
            {loading && rows.length === 0
              ? Array.from({ length: 5 }, (_, index) => <Box key={index} sx={{ p: 2 }}><Skeleton height={90} /></Box>)
              : rows.map((user) => (
                  <Box key={user._id} sx={{ p: { xs: 1.5, sm: 2 } }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                      <UserIdentity user={user} />
                      <Chip size="small" label={user.isBlocked ? "Blocked" : "Active"} color={user.isBlocked ? "error" : "success"} variant="outlined" />
                    </Stack>
                    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.25, mt: 2 }}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Report approver</Typography>
                        <AssignmentSelect label="Report approver" value={assignmentId(user.reportApprover)} options={assignmentOptions} disabled={busyUserId === user._id} onChange={(value) => void patchProfile(user._id, { reportApprover: value || null }, "Report approver updated")} />
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Release manager</Typography>
                        <AssignmentSelect label="Release manager" value={assignmentId(user.releaseManager)} options={assignmentOptions} disabled={busyUserId === user._id} onChange={(value) => void patchProfile(user._id, { releaseManager: value || null }, "Release manager updated")} />
                      </Box>
                    </Box>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" mt={1.25} gap={1}>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 1.5 }}>
                        <FormControl size="small">
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Switch size="small" checked={Boolean(user.isCrmAgent)} disabled={busyUserId === user._id} onChange={() => void patchProfile(user._id, { isCrmAgent: !user.isCrmAgent }, user.isCrmAgent ? "CRM access removed" : "CRM access enabled")} />
                            <Typography variant="body2">CRM</Typography>
                          </Stack>
                        </FormControl>
                        <FormControl size="small">
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Switch size="small" checked={Boolean(user.proposalValuationEnabled)} disabled={busyUserId === user._id} onChange={() => void patchProfile(user._id, { proposalValuationEnabled: !user.proposalValuationEnabled }, user.proposalValuationEnabled ? "Proposal Valuation disabled" : "Proposal Valuation enabled")} />
                            <Typography variant="body2">Proposal Valuation</Typography>
                          </Stack>
                        </FormControl>
                      </Stack>
                      {userActions(user)}
                    </Stack>
                  </Box>
                ))}
          </Stack>
        )}

        {!loading && rows.length === 0 && !error && (
          <Box sx={{ py: 7, px: 2, textAlign: "center" }}>
            <GroupRounded sx={{ fontSize: 42, color: "text.secondary", mb: 1 }} />
            <Typography fontWeight={700}>No users found</Typography>
            <Typography variant="body2" color="text.secondary">Try changing the current filters.</Typography>
          </Box>
        )}

        <Stack direction={{ xs: "column", sm: "row" }} alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">{data?.total || 0} users</Typography>
            <Select size="small" value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }} sx={{ minWidth: 92 }}>
              {[10, 20, 50].map((value) => <MenuItem key={value} value={value}>{value} rows</MenuItem>)}
            </Select>
          </Stack>
          <Pagination count={totalPages} page={Math.min(page, totalPages)} onChange={(_, value) => setPage(value)} color="primary" size="small" siblingCount={showTable ? 1 : 0} />
        </Stack>
      </Paper>

      <Dialog open={Boolean(confirmation)} onClose={() => !busyUserId && setConfirmation(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{confirmation?.action === "delete" ? "Delete user" : confirmation?.user.isBlocked ? "Unblock user" : "Block user"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmation?.action === "delete"
              ? `Delete ${confirmation ? userDisplayName(confirmation.user) : "this user"}? This cannot be undone.`
              : `${confirmation?.user.isBlocked ? "Restore" : "Suspend"} account access for ${confirmation ? userDisplayName(confirmation.user) : "this user"}?`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmation(null)} color="secondary">Cancel</Button>
          <Button variant="contained" color={confirmation?.action === "delete" ? "error" : "primary"} onClick={() => void confirmAction()} disabled={Boolean(busyUserId)} startIcon={busyUserId ? <CircularProgress size={16} color="inherit" /> : confirmation?.action === "delete" ? <DeleteOutlineRounded /> : <ChevronRightRounded />}>Confirm</Button>
        </DialogActions>
      </Dialog>

      <UserProfileDrawer
        open={Boolean(profileUserId)}
        userId={profileUserId}
        assignmentOptions={assignmentOptions}
        onClose={() => setProfileUserId(null)}
        onSaved={loadUsers}
        onFeedback={notify}
      />

      <Snackbar open={Boolean(feedback)} autoHideDuration={3500} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity={feedback?.severity || "success"} variant="filled" onClose={() => setFeedback(null)}>{feedback?.message}</Alert>
      </Snackbar>
    </Box>
  );
}
