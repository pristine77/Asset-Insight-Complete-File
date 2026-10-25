"use client";

import { Ban } from "lucide-react";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";

export type ManualIpBlockForm = {
  userEmail: string;
  ip: string;
  reason: string;
};

export function validIpAddress(value: string) {
  const candidate = value.trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return candidate.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  if (!candidate.includes(":")) return false;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]");
  } catch {
    return false;
  }
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function ManualIpBlockDialog({
  open,
  busy,
  value,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  value: ManualIpBlockForm;
  onChange: (value: ManualIpBlockForm) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const emailInvalid = Boolean(value.userEmail) && !validEmail(value.userEmail);
  const ipInvalid = Boolean(value.ip) && !validIpAddress(value.ip);
  const canSubmit = validEmail(value.userEmail) && validIpAddress(value.ip) && Boolean(value.reason.trim());

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Block IP address</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2.25 }}>
          This blocks one exact public IPv4 or IPv6 address only for the selected user. Other users on the same network remain unaffected.
        </Alert>
        <Stack spacing={1.5}>
          <TextField
            autoFocus
            type="email"
            label="User email"
            value={value.userEmail}
            onChange={(event) => onChange({ ...value, userEmail: event.target.value })}
            error={emailInvalid}
            helperText={emailInvalid ? "Enter the exact email of an ordinary user" : "The block applies only to this account"}
            inputProps={{ maxLength: 200, autoComplete: "off" }}
          />
          <TextField
            label="IP address"
            placeholder="203.0.113.24 or 2001:db8::1"
            value={value.ip}
            onChange={(event) => onChange({ ...value, ip: event.target.value })}
            error={ipInvalid}
            helperText={ipInvalid ? "Enter a valid IPv4 or IPv6 address" : "Use the public address shown in device IP history"}
            inputProps={{ maxLength: 64, autoCapitalize: "none", spellCheck: false }}
          />
          <TextField
            label="Audit reason"
            multiline
            minRows={3}
            value={value.reason}
            onChange={(event) => onChange({ ...value, reason: event.target.value })}
            placeholder="Explain why access from this address must be blocked"
            helperText={`${value.reason.length}/1000`}
            inputProps={{ maxLength: 1000 }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="contained"
          color="error"
          startIcon={busy ? undefined : <Ban size={16} />}
          onClick={onSubmit}
          disabled={busy || !canSubmit}
        >
          {busy ? <CircularProgress size={18} color="inherit" /> : "Block IP address"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
