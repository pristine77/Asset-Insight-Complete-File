"use client";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import {
  Alert,
  Button,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "@/app/components/common/ConfirmModal";
import Modal from "@/app/components/common/Modal";

type ApiKeyItem = {
  _id: string;
  name: string;
  keyId: string;
  prefix: string;
  last4: string;
  status: "active" | "revoked";
  createdBy?: {
    email?: string;
    username?: string;
    role?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

function formatDate(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export default function AdminApiKeys() {
  const [items, setItems] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [oneTimeKey, setOneTimeKey] = useState("");
  const [renameTarget, setRenameTarget] = useState<ApiKeyItem | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const keyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeCount = useMemo(
    () => items.filter((item) => item.status === "active").length,
    [items]
  );

  function pushToast(message: string, type: "success" | "error" = "success") {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 3200);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/api-keys", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load API keys");
      setItems(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createKey() {
    const name = createName.trim();
    if (!name) {
      pushToast("Enter a key name.", "error");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to create API key");
      setCreateOpen(false);
      setCreateName("");
      setOneTimeKey(String(json?.apiKey || ""));
      await load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Failed to create API key", "error");
    } finally {
      setCreating(false);
    }
  }

  function openRename(item: ApiKeyItem) {
    setRenameTarget(item);
    setRenameName(item.name);
  }

  async function renameKey() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) {
      pushToast("Enter a key name.", "error");
      return;
    }

    setRenaming(true);
    try {
      const res = await fetch(`/api/admin/api-keys/${renameTarget._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to rename API key");
      setRenameTarget(null);
      setRenameName("");
      pushToast("API key renamed.");
      await load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Failed to rename API key", "error");
    } finally {
      setRenaming(false);
    }
  }

  async function revokeKey() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/admin/api-keys/${revokeTarget._id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to revoke API key");
      setRevokeTarget(null);
      pushToast("API key revoked.");
      await load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Failed to revoke API key", "error");
    } finally {
      setRevoking(false);
    }
  }

  async function copyOneTimeKey() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(oneTimeKey);
      } else {
        keyTextareaRef.current?.select();
        document.execCommand("copy");
      }
      pushToast("API key copied.");
    } catch {
      keyTextareaRef.current?.select();
      pushToast("Select the key manually to copy it.", "error");
    }
  }

  return (
    <div className="admin-page-shell">
      <main className="mx-auto max-w-6xl space-y-6">
        <section className="admin-glass-surface rounded-3xl p-5 md:p-6">
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            alignItems={{ xs: "flex-start", md: "center" }}
            justifyContent="space-between"
          >
            <Stack spacing={0.75}>
              <Stack direction="row" spacing={1} alignItems="center">
                <KeyRoundedIcon color="primary" />
                <Typography variant="h5" fontWeight={800}>
                  API Keys
                </Typography>
              </Stack>
              <Typography color="text.secondary">
                Create and manage read-only keys for approved assets and lot listings.
              </Typography>
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} width={{ xs: "100%", sm: "auto" }}>
              <Button
                component={Link}
                href="/api-documentation"
                target="_blank"
                rel="noopener noreferrer"
                variant="outlined"
                startIcon={<LinkRoundedIcon />}
              >
                Documentation & Try API
              </Button>
              <Button
                variant="contained"
                startIcon={<AddRoundedIcon />}
                onClick={() => setCreateOpen(true)}
              >
                Create Key
              </Button>
            </Stack>
          </Stack>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="admin-glass-surface rounded-3xl p-5">
            <Typography variant="caption" color="text.secondary">
              Total keys
            </Typography>
            <Typography variant="h4" fontWeight={800}>
              {items.length}
            </Typography>
          </div>
          <div className="admin-glass-surface rounded-3xl p-5">
            <Typography variant="caption" color="text.secondary">
              Active
            </Typography>
            <Typography variant="h4" fontWeight={800} color="success.main">
              {activeCount}
            </Typography>
          </div>
          <div className="admin-glass-surface rounded-3xl p-5">
            <Typography variant="caption" color="text.secondary">
              Rate limit
            </Typography>
            <Typography variant="h4" fontWeight={800}>
              600/min
            </Typography>
          </div>
        </section>

        <section className="admin-glass-surface rounded-3xl p-4 md:p-6">
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} justifyContent="space-between" sx={{ mb: 2 }}>
            <Typography variant="h6" fontWeight={800}>
              Key inventory
            </Typography>
            <Button variant="outlined" onClick={() => void load()} disabled={loading}>
              Refresh
            </Button>
          </Stack>

          {loading ? (
            <Typography color="text.secondary">Loading...</Typography>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : items.length === 0 ? (
            <Alert severity="info">No API keys have been created yet.</Alert>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Key</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Last used</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item._id} hover>
                      <TableCell>
                        <Stack spacing={0.25}>
                          <Typography variant="body2" fontWeight={700}>
                            {item.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {item.createdBy?.email || "Unknown creator"}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography component="code" variant="body2" sx={{ fontFamily: "monospace" }}>
                          {item.prefix}_...{item.last4}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={item.status === "active" ? "success" : "default"}
                          label={item.status === "active" ? "Active" : "Revoked"}
                        />
                      </TableCell>
                      <TableCell>{formatDate(item.createdAt)}</TableCell>
                      <TableCell>{formatDate(item.lastUsedAt)}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<EditRoundedIcon />}
                            onClick={() => openRename(item)}
                          >
                            Rename
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            startIcon={<DeleteRoundedIcon />}
                            disabled={item.status !== "active"}
                            onClick={() => setRevokeTarget(item)}
                          >
                            Revoke
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </section>
      </main>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API key"
        footer={
          <>
            <Button variant="outlined" color="inherit" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button variant="contained" onClick={createKey} disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </>
        }
      >
        <Stack spacing={2}>
          <TextField
            autoFocus
            fullWidth
            label="Key name"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="Production integration"
          />
          <Alert severity="warning" variant="outlined">
            The full key is shown once. Store it in a server-side secret manager.
          </Alert>
        </Stack>
      </Modal>

      <Modal
        open={Boolean(oneTimeKey)}
        onClose={() => setOneTimeKey("")}
        title="Copy API key"
        maxWidthClass="max-w-2xl"
        footer={
          <>
            <Button variant="outlined" color="inherit" onClick={() => setOneTimeKey("")}>
              Done
            </Button>
            <Button variant="contained" startIcon={<ContentCopyRoundedIcon />} onClick={copyOneTimeKey}>
              Copy
            </Button>
          </>
        }
      >
        <Stack spacing={2}>
          <Alert severity="success" variant="outlined">
            This is the only time the full key will be displayed.
          </Alert>
          <textarea
            ref={keyTextareaRef}
            readOnly
            value={oneTimeKey}
            className="min-h-24 w-full rounded-xl border border-gray-300 bg-gray-50 p-3 font-mono text-sm text-gray-900"
          />
        </Stack>
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title="Rename API key"
        footer={
          <>
            <Button variant="outlined" color="inherit" onClick={() => setRenameTarget(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button variant="contained" onClick={renameKey} disabled={renaming}>
              {renaming ? "Saving..." : "Save"}
            </Button>
          </>
        }
      >
        <TextField
          autoFocus
          fullWidth
          label="Key name"
          value={renameName}
          onChange={(event) => setRenameName(event.target.value)}
        />
      </Modal>

      <ConfirmModal
        open={Boolean(revokeTarget)}
        title="Revoke this API key?"
        description={
          <>
            Requests using this key will stop working immediately. This action cannot be undone.
          </>
        }
        confirmText="Revoke"
        cancelText="Cancel"
        loading={revoking}
        onConfirm={revokeKey}
        onCancel={() => setRevokeTarget(null)}
      />

      {toast ? (
        <div className="fixed bottom-4 right-4 z-[90]">
          <Alert severity={toast.type} variant="filled">
            {toast.message}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
