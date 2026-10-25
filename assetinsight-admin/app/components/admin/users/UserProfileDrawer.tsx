"use client";

import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  BusinessRounded,
  CloseRounded,
  ContactMailRounded,
  ManageAccountsRounded,
  SaveRounded,
  VerifiedUserRounded,
} from "@mui/icons-material";
import { useEffect, useMemo, useState } from "react";
import {
  type AdminUserProfile,
  type AssignmentOption,
  assignmentId,
  assignmentLabel,
  userDisplayName,
} from "./types";

const CRM_QUADRANTS = ["NW", "NE", "SW", "SE", "NORTH", "SOUTH", "EAST", "WEST", "CENTRAL"];
const CRM_SPECIALIZATIONS = [
  { value: "industrial_construction", label: "Industrial & Construction" },
  { value: "farm_equipment_sales", label: "Farm & Farm Equipment Sales" },
  { value: "others", label: "Others" },
];

type EditableProfile = {
  username: string;
  email: string;
  companyName: string;
  contactEmail: string;
  contactPhone: string;
  companyAddress: string;
  crmAddress: string;
  crmQuadrant: string;
  crmSpecializations: string[];
  isCrmAgent: boolean;
  proposalValuationEnabled: boolean;
  reportApprover: string;
  releaseManager: string;
};

const EMPTY_PROFILE: EditableProfile = {
  username: "",
  email: "",
  companyName: "",
  contactEmail: "",
  contactPhone: "",
  companyAddress: "",
  crmAddress: "",
  crmQuadrant: "",
  crmSpecializations: [],
  isCrmAgent: false,
  proposalValuationEnabled: false,
  reportApprover: "",
  releaseManager: "",
};

function toEditable(user: AdminUserProfile): EditableProfile {
  return {
    username: user.username || "",
    email: user.email || "",
    companyName: user.companyName || "",
    contactEmail: user.contactEmail || "",
    contactPhone: user.contactPhone || "",
    companyAddress: user.companyAddress || "",
    crmAddress: user.crmAddress || "",
    crmQuadrant: user.crmQuadrant || "",
    crmSpecializations: Array.isArray(user.crmSpecializations) ? user.crmSpecializations : [],
    isCrmAgent: Boolean(user.isCrmAgent),
    proposalValuationEnabled: Boolean(user.proposalValuationEnabled),
    reportApprover: assignmentId(user.reportApprover),
    releaseManager: assignmentId(user.releaseManager),
  };
}

function formatDate(value?: string): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function SectionHeading({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <Stack direction="row" spacing={1.25} alignItems="flex-start">
      <Box sx={{ color: "primary.main", display: "grid", placeItems: "center", mt: 0.2 }}>{icon}</Box>
      <Box>
        <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
      </Box>
    </Stack>
  );
}

export default function UserProfileDrawer({
  open,
  userId,
  assignmentOptions,
  onClose,
  onSaved,
  onFeedback,
}: {
  open: boolean;
  userId: string | null;
  assignmentOptions: AssignmentOption[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onFeedback: (message: string, severity: "success" | "error") => void;
}) {
  const [profile, setProfile] = useState<AdminUserProfile | null>(null);
  const [form, setForm] = useState<EditableProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/admin/users/${userId}/profile`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "Failed to load user profile");
        return body.user as AdminUserProfile;
      })
      .then((user) => {
        setProfile(user);
        setForm(toEditable(user));
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Failed to load user profile");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, userId]);

  const title = profile ? userDisplayName(profile) : "User profile";
  const initials = useMemo(() => title.slice(0, 2).toUpperCase(), [title]);

  function update<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleSpecialization(value: string) {
    update(
      "crmSpecializations",
      form.crmSpecializations.includes(value)
        ? form.crmSpecializations.filter((item) => item !== value)
        : [...form.crmSpecializations, value],
    );
  }

  async function save() {
    if (!userId) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to save user profile");
      setProfile(body.user as AdminUserProfile);
      setForm(toEditable(body.user as AdminUserProfile));
      await onSaved();
      onFeedback("User profile saved", "success");
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "Failed to save user profile";
      setError(message);
      onFeedback(message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      PaperProps={{
        sx: {
          width: { xs: "100vw", sm: 640, md: 720 },
          maxWidth: "100vw",
          borderTop: 0,
          borderBottom: 0,
          display: "flex",
        },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ px: { xs: 2, sm: 3 }, py: 2, borderBottom: 1, borderColor: "divider" }}>
        <Avatar src={profile?.avatarUrl || undefined} sx={{ bgcolor: "primary.main", width: 44, height: 44 }}>{initials}</Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" fontWeight={750} noWrap>{title}</Typography>
          <Typography variant="body2" color="text.secondary" noWrap>{profile?.email || "Review and update safe account details"}</Typography>
        </Box>
        {profile?.isBlocked && <Chip label="Blocked" color="error" size="small" />}
        <Tooltip title="Close">
          <span><IconButton onClick={onClose} disabled={saving}><CloseRounded /></IconButton></span>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: { xs: 2, sm: 3 }, py: 2.5 }}>
        {loading ? (
          <Box sx={{ display: "grid", placeItems: "center", minHeight: 320 }}><CircularProgress size={32} /></Box>
        ) : error && !profile ? (
          <Alert severity="error">{error}</Alert>
        ) : profile ? (
          <Stack spacing={2.5}>
            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading icon={<ManageAccountsRounded />} title="Account" description="Identity and contact details visible to administrators." />
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, mt: 2 }}>
                <TextField label="Full name" value={form.username} onChange={(event) => update("username", event.target.value)} />
                <TextField label="Email" type="email" value={form.email} onChange={(event) => update("email", event.target.value)} required />
                <TextField label="Contact email" type="email" value={form.contactEmail} onChange={(event) => update("contactEmail", event.target.value)} />
                <TextField label="Contact phone" value={form.contactPhone} onChange={(event) => update("contactPhone", event.target.value)} />
              </Box>
            </Paper>

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading icon={<BusinessRounded />} title="Company" description="Organization and company contact information." />
              <Stack spacing={1.5} mt={2}>
                <TextField label="Company name" value={form.companyName} onChange={(event) => update("companyName", event.target.value)} />
                <TextField label="Company address" value={form.companyAddress} onChange={(event) => update("companyAddress", event.target.value)} multiline minRows={2} />
              </Stack>
            </Paper>

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading icon={<ContactMailRounded />} title="CRM profile" description="Territory, specializations, and CRM agent access." />
              <Stack spacing={1.5} mt={2}>
                <FormControlLabel
                  control={<Switch checked={form.isCrmAgent} onChange={(event) => update("isCrmAgent", event.target.checked)} />}
                  label="CRM agent access"
                />
                <TextField label="CRM address" value={form.crmAddress} onChange={(event) => update("crmAddress", event.target.value)} multiline minRows={2} />
                <TextField select label="CRM quadrant" value={form.crmQuadrant} onChange={(event) => update("crmQuadrant", event.target.value)}>
                  <MenuItem value="">Not assigned</MenuItem>
                  {CRM_QUADRANTS.map((quadrant) => <MenuItem key={quadrant} value={quadrant}>{quadrant}</MenuItem>)}
                </TextField>
                <Box>
                  <Typography variant="body2" fontWeight={650} mb={0.5}>Specializations</Typography>
                  <Stack>
                    {CRM_SPECIALIZATIONS.map((option) => (
                      <FormControlLabel
                        key={option.value}
                        control={<Checkbox checked={form.crmSpecializations.includes(option.value)} onChange={() => toggleSpecialization(option.value)} />}
                        label={option.label}
                      />
                    ))}
                  </Stack>
                </Box>
              </Stack>
            </Paper>

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading
                icon={<VerifiedUserRounded />}
                title="Report workflow"
                description="Assign report approval and release responsibilities."
              />
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, mt: 2 }}>
                <TextField select label="Report approver" value={form.reportApprover} onChange={(event) => update("reportApprover", event.target.value)}>
                  <MenuItem value="">Not assigned</MenuItem>
                  {assignmentOptions.map((option) => <MenuItem key={option._id} value={option._id}>{assignmentLabel(option)}</MenuItem>)}
                </TextField>
                <TextField select label="Release manager" value={form.releaseManager} onChange={(event) => update("releaseManager", event.target.value)}>
                  <MenuItem value="">Not assigned</MenuItem>
                  {assignmentOptions.map((option) => <MenuItem key={option._id} value={option._id}>{assignmentLabel(option)}</MenuItem>)}
                </TextField>
              </Box>
            </Paper>

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading
                icon={<ManageAccountsRounded />}
                title="Report capabilities"
                description="Control optional report tools available to this user."
              />
              <FormControlLabel
                sx={{ mt: 1.5, alignItems: "flex-start" }}
                control={
                  <Switch
                    checked={form.proposalValuationEnabled}
                    onChange={(event) => update("proposalValuationEnabled", event.target.checked)}
                  />
                }
                label={
                  <Box sx={{ pt: 0.25 }}>
                    <Typography fontWeight={700}>Proposal Valuation</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Allow this user to review and edit Proposal Valuation for Asset reports they own.
                    </Typography>
                  </Box>
                }
              />
            </Paper>

            <Paper sx={{ p: 2.25 }}>
              <SectionHeading icon={<VerifiedUserRounded />} title="Account metadata" description="Protected system fields are read-only." />
              <Divider sx={{ my: 2 }} />
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Role</Typography><Typography>{profile.role}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Authentication</Typography><Typography>{profile.authProvider || "Password"}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Verified</Typography><Typography>{profile.isVerified ? "Yes" : "No"}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Outlook calendar</Typography><Typography>{profile.msOutlookCalendarConnected ? profile.msOutlookConnectedEmail || "Connected" : "Not connected"}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Created</Typography><Typography>{formatDate(profile.createdAt)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Last updated</Typography><Typography>{formatDate(profile.updatedAt)}</Typography></Box>
              </Box>
            </Paper>
          </Stack>
        ) : null}
      </Box>

      <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ px: { xs: 2, sm: 3 }, py: 1.75, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Button variant="outlined" color="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />} onClick={save} disabled={loading || saving || !profile}>Save profile</Button>
      </Stack>
    </Drawer>
  );
}
