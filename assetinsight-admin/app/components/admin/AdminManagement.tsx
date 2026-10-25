"use client";

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
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
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
  AddRounded,
  AdminPanelSettingsRounded,
  BlockRounded,
  DeleteOutlineRounded,
  KeyRounded,
  LockOpenRounded,
  RefreshRounded,
  RestartAltRounded,
  SearchRounded,
  ShieldRounded,
} from "@mui/icons-material";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  blockAdminAPI,
  createAdminAPI,
  deleteAdminAPI,
  listAdminsAPI,
  updateAdminPasswordAPI,
} from "@/lib/api";

type AdminUser = {
  _id: string;
  email: string;
  username?: string;
  role: "admin" | "superadmin" | string;
  isBlocked?: boolean;
  companyName?: string;
  createdAt?: string;
};

type Feedback = { message: string; severity: "success" | "error" } | null;
type Confirmation = { user: AdminUser; action: "delete" | "block" } | null;

function displayName(admin: AdminUser): string {
  return admin.username || admin.companyName || admin.email;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

export default function AdminManagement() {
  const theme = useTheme();
  const showTable = useMediaQuery(theme.breakpoints.up("md"));
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [createForm, setCreateForm] = useState({ email: "", username: "", companyName: "", password: "" });
  const [passwordForm, setPasswordForm] = useState({ password: "", confirmation: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAdminsAPI();
      setAdmins(Array.isArray(response.admins) ? response.admins : []);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Failed to load administrators");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filteredAdmins = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return admins.filter((admin) => {
      if (normalized && ![admin.email, admin.username, admin.companyName].some((value) => String(value || "").toLowerCase().includes(normalized))) return false;
      if (roleFilter && admin.role !== roleFilter) return false;
      if (statusFilter === "active" && admin.isBlocked) return false;
      if (statusFilter === "blocked" && !admin.isBlocked) return false;
      return true;
    });
  }, [admins, query, roleFilter, statusFilter]);

  function notify(message: string, severity: "success" | "error") {
    setFeedback({ message, severity });
  }

  async function createAdmin(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!createForm.email.trim()) {
      setFormError("Email is required");
      return;
    }
    if (createForm.password && createForm.password.length < 6) {
      setFormError("Password must be at least 6 characters");
      return;
    }
    setBusyId("create");
    try {
      await createAdminAPI({
        email: createForm.email.trim(),
        username: createForm.username.trim() || undefined,
        companyName: createForm.companyName.trim() || undefined,
        password: createForm.password || undefined,
      });
      setCreateOpen(false);
      setCreateForm({ email: "", username: "", companyName: "", password: "" });
      notify("Administrator created", "success");
      await load();
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "Failed to create administrator";
      setFormError(message);
      notify(message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function updatePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!passwordTarget) return;
    setFormError(null);
    if (passwordForm.password.length < 6) {
      setFormError("Password must be at least 6 characters");
      return;
    }
    if (passwordForm.password !== passwordForm.confirmation) {
      setFormError("Passwords do not match");
      return;
    }
    setBusyId(passwordTarget._id);
    try {
      await updateAdminPasswordAPI(passwordTarget._id, passwordForm.password);
      notify(`Password updated for ${passwordTarget.email}`, "success");
      setPasswordTarget(null);
      setPasswordForm({ password: "", confirmation: "" });
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "Failed to update password";
      setFormError(message);
      notify(message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmAction() {
    if (!confirmation) return;
    const { user, action } = confirmation;
    setBusyId(user._id);
    try {
      if (action === "delete") await deleteAdminAPI(user._id);
      else await blockAdminAPI(user._id, !user.isBlocked);
      notify(action === "delete" ? "Administrator deleted" : user.isBlocked ? "Administrator unblocked" : "Administrator blocked", "success");
      setConfirmation(null);
      await load();
    } catch (cause: unknown) {
      notify(cause instanceof Error ? cause.message : "Failed to update administrator", "error");
    } finally {
      setBusyId(null);
    }
  }

  function resetFilters() {
    setQuery("");
    setRoleFilter("");
    setStatusFilter("");
  }

  const actions = (admin: AdminUser) => {
    const protectedAdmin = admin.role === "superadmin";
    return (
      <Stack direction="row" spacing={0.25} justifyContent="flex-end">
        <Tooltip title="Change password"><IconButton size="small" onClick={() => { setPasswordTarget(admin); setPasswordForm({ password: "", confirmation: "" }); setFormError(null); }}><KeyRounded fontSize="small" /></IconButton></Tooltip>
        <Tooltip title={protectedAdmin ? "Superadmins cannot be blocked" : admin.isBlocked ? "Unblock administrator" : "Block administrator"}>
          <span><IconButton size="small" disabled={protectedAdmin || busyId === admin._id} onClick={() => setConfirmation({ user: admin, action: "block" })}>{admin.isBlocked ? <LockOpenRounded fontSize="small" /> : <BlockRounded fontSize="small" />}</IconButton></span>
        </Tooltip>
        <Tooltip title={protectedAdmin ? "Superadmins cannot be deleted" : "Delete administrator"}>
          <span><IconButton size="small" color="error" disabled={protectedAdmin || busyId === admin._id} onClick={() => setConfirmation({ user: admin, action: "delete" })}><DeleteOutlineRounded fontSize="small" /></IconButton></span>
        </Tooltip>
      </Stack>
    );
  };

  return (
    <Box sx={{ width: "100%", minWidth: 0, px: { xs: 1.5, sm: 2.5, xl: 3 }, py: { xs: 2, md: 3 }, overflowX: "hidden" }}>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={2} mb={2.5}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h4" component="h1" fontWeight={750}>Administrators</Typography>
            <Chip label={admins.length} size="small" variant="outlined" />
          </Stack>
          <Typography color="text.secondary">Manage administrative access and credentials.</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<RefreshRounded />} onClick={() => void load()} disabled={loading}>Refresh</Button>
          <Button variant="contained" startIcon={<AddRounded />} onClick={() => { setCreateOpen(true); setFormError(null); }}>New administrator</Button>
        </Stack>
      </Stack>

      <Paper sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(240px, 1fr) 170px", md: "minmax(300px, 1fr) 180px 180px auto" }, gap: 1.25, alignItems: "center" }}>
          <TextField size="small" placeholder="Search name, email, or company" value={query} onChange={(event) => setQuery(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }} />
          <TextField select size="small" label="Role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <MenuItem value="">All roles</MenuItem>
            <MenuItem value="superadmin">Superadmin</MenuItem>
            <MenuItem value="admin">Admin</MenuItem>
          </TextField>
          <TextField select size="small" label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <MenuItem value="">All accounts</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="blocked">Blocked</MenuItem>
          </TextField>
          <Button color="secondary" startIcon={<RestartAltRounded />} onClick={resetFilters}>Reset</Button>
        </Box>
      </Paper>

      {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void load()}>Retry</Button>} sx={{ mb: 2 }}>{error}</Alert>}

      <Paper sx={{ overflow: "hidden" }}>
        {showTable ? (
          <TableContainer sx={{ overflowX: "hidden" }}>
            <Table size="small" sx={{ tableLayout: "fixed" }}>
              <TableHead><TableRow><TableCell sx={{ width: "30%" }}>Administrator</TableCell><TableCell sx={{ width: "22%" }}>Company</TableCell><TableCell sx={{ width: "13%" }}>Role</TableCell><TableCell sx={{ width: "14%" }}>Status</TableCell><TableCell sx={{ width: "12%" }}>Created</TableCell><TableCell sx={{ width: "9%" }} align="right">Actions</TableCell></TableRow></TableHead>
              <TableBody>
                {loading && admins.length === 0
                  ? Array.from({ length: 5 }, (_, index) => <TableRow key={index}>{Array.from({ length: 6 }, (__, cell) => <TableCell key={cell}><Skeleton height={34} /></TableCell>)}</TableRow>)
                  : filteredAdmins.map((admin) => (
                      <TableRow key={admin._id} hover>
                        <TableCell>
                          <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
                            <Avatar sx={{ width: 38, height: 38, bgcolor: admin.role === "superadmin" ? "primary.main" : "secondary.main", fontSize: 14 }}>{displayName(admin).slice(0, 2).toUpperCase()}</Avatar>
                            <Box sx={{ minWidth: 0 }}><Typography variant="body2" fontWeight={700} noWrap>{displayName(admin)}</Typography><Typography variant="caption" color="text.secondary" noWrap display="block">{admin.email}</Typography></Box>
                          </Stack>
                        </TableCell>
                        <TableCell><Typography variant="body2" noWrap>{admin.companyName || "-"}</Typography></TableCell>
                        <TableCell><Chip size="small" icon={admin.role === "superadmin" ? <ShieldRounded /> : <AdminPanelSettingsRounded />} label={admin.role === "superadmin" ? "Superadmin" : "Admin"} variant="outlined" color={admin.role === "superadmin" ? "primary" : "default"} /></TableCell>
                        <TableCell><Chip size="small" label={admin.isBlocked ? "Blocked" : "Active"} color={admin.isBlocked ? "error" : "success"} variant="outlined" /></TableCell>
                        <TableCell><Typography variant="body2">{formatDate(admin.createdAt)}</Typography></TableCell>
                        <TableCell align="right">{actions(admin)}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Stack divider={<Box sx={{ borderTop: 1, borderColor: "divider" }} />}>
            {loading && admins.length === 0
              ? Array.from({ length: 4 }, (_, index) => <Box key={index} sx={{ p: 2 }}><Skeleton height={90} /></Box>)
              : filteredAdmins.map((admin) => (
                  <Box key={admin._id} sx={{ p: 2 }}>
                    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                      <Stack direction="row" spacing={1.25} sx={{ minWidth: 0 }}><Avatar sx={{ bgcolor: admin.role === "superadmin" ? "primary.main" : "secondary.main" }}>{displayName(admin).slice(0, 2).toUpperCase()}</Avatar><Box sx={{ minWidth: 0 }}><Typography fontWeight={700} noWrap>{displayName(admin)}</Typography><Typography variant="body2" color="text.secondary" noWrap>{admin.email}</Typography><Typography variant="caption" color="text.secondary">{admin.companyName || "No company"}</Typography></Box></Stack>
                      <Chip size="small" label={admin.isBlocked ? "Blocked" : "Active"} color={admin.isBlocked ? "error" : "success"} variant="outlined" />
                    </Stack>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" mt={1.5}><Chip size="small" label={admin.role === "superadmin" ? "Superadmin" : "Admin"} variant="outlined" /><Stack direction="row">{actions(admin)}</Stack></Stack>
                  </Box>
                ))}
          </Stack>
        )}

        {!loading && filteredAdmins.length === 0 && !error && (
          <Box sx={{ py: 7, textAlign: "center" }}><AdminPanelSettingsRounded sx={{ fontSize: 42, color: "text.secondary", mb: 1 }} /><Typography fontWeight={700}>No administrators found</Typography><Typography variant="body2" color="text.secondary">Try changing the filters or create an administrator.</Typography></Box>
        )}
        <Box sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}><Typography variant="body2" color="text.secondary">Showing {filteredAdmins.length} of {admins.length} administrators</Typography></Box>
      </Paper>

      <Dialog open={createOpen} onClose={() => busyId !== "create" && setCreateOpen(false)} maxWidth="sm" fullWidth component="form" onSubmit={createAdmin}>
        <DialogTitle>Create administrator</DialogTitle>
        <DialogContent><Stack spacing={1.5} mt={0.5}>{formError && <Alert severity="error">{formError}</Alert>}<TextField label="Email" type="email" required value={createForm.email} onChange={(event) => setCreateForm((form) => ({ ...form, email: event.target.value }))} /><TextField label="Full name" value={createForm.username} onChange={(event) => setCreateForm((form) => ({ ...form, username: event.target.value }))} /><TextField label="Company" value={createForm.companyName} onChange={(event) => setCreateForm((form) => ({ ...form, companyName: event.target.value }))} /><TextField label="Temporary password" type="password" helperText="Leave blank only if the server creates a temporary password." value={createForm.password} onChange={(event) => setCreateForm((form) => ({ ...form, password: event.target.value }))} /></Stack></DialogContent>
        <DialogActions><Button onClick={() => setCreateOpen(false)} color="secondary" disabled={busyId === "create"}>Cancel</Button><Button type="submit" variant="contained" disabled={busyId === "create"} startIcon={busyId === "create" ? <CircularProgress size={16} color="inherit" /> : <AddRounded />}>Create</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(passwordTarget)} onClose={() => !busyId && setPasswordTarget(null)} maxWidth="xs" fullWidth component="form" onSubmit={updatePassword}>
        <DialogTitle>Change password</DialogTitle>
        <DialogContent><Stack spacing={1.5} mt={0.5}>{formError && <Alert severity="error">{formError}</Alert>}<DialogContentText>Set a new password for {passwordTarget?.email}.</DialogContentText><TextField label="New password" type="password" required value={passwordForm.password} onChange={(event) => setPasswordForm((form) => ({ ...form, password: event.target.value }))} /><TextField label="Confirm password" type="password" required value={passwordForm.confirmation} onChange={(event) => setPasswordForm((form) => ({ ...form, confirmation: event.target.value }))} /></Stack></DialogContent>
        <DialogActions><Button onClick={() => setPasswordTarget(null)} color="secondary" disabled={Boolean(busyId)}>Cancel</Button><Button type="submit" variant="contained" disabled={Boolean(busyId)} startIcon={busyId ? <CircularProgress size={16} color="inherit" /> : <KeyRounded />}>Update password</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(confirmation)} onClose={() => !busyId && setConfirmation(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{confirmation?.action === "delete" ? "Delete administrator" : confirmation?.user.isBlocked ? "Unblock administrator" : "Block administrator"}</DialogTitle>
        <DialogContent><DialogContentText>{confirmation?.action === "delete" ? `Delete ${confirmation ? displayName(confirmation.user) : "this administrator"}? This cannot be undone.` : `${confirmation?.user.isBlocked ? "Restore" : "Suspend"} access for ${confirmation ? displayName(confirmation.user) : "this administrator"}?`}</DialogContentText></DialogContent>
        <DialogActions><Button color="secondary" onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="contained" color={confirmation?.action === "delete" ? "error" : "primary"} onClick={() => void confirmAction()} disabled={Boolean(busyId)} startIcon={busyId ? <CircularProgress size={16} color="inherit" /> : confirmation?.action === "delete" ? <DeleteOutlineRounded /> : <BlockRounded />}>Confirm</Button></DialogActions>
      </Dialog>

      <Snackbar open={Boolean(feedback)} autoHideDuration={3500} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}><Alert severity={feedback?.severity || "success"} variant="filled" onClose={() => setFeedback(null)}>{feedback?.message}</Alert></Snackbar>
    </Box>
  );
}
