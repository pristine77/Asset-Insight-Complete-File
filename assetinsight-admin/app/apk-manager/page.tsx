"use client";

import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  LinearProgress,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import AndroidRoundedIcon from "@mui/icons-material/AndroidRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";

type ApkRelease = {
  id: string;
  latestVersionName?: string;
  latestVersionCode?: number;
  versionName: string;
  versionCode: number;
  releaseNotes?: string;
  mandatory: boolean;
  downloadUrl: string;
  apkUrl?: string;
  sizeBytes: number;
  sha256?: string;
  originalName?: string;
  isActive: boolean;
  uploadedBy?: { username?: string; email?: string } | null;
  createdAt?: string;
};

type ApkUploadGrant = {
  token: string;
  uploadUrl: string;
  method: "PUT";
  contentType: string;
};

function parseUploadResponse(value: string, fallback: string): any {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    const readable = value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { message: readable || fallback };
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export default function ApkManagerPage() {
  const [releases, setReleases] = useState<ApkRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [apkFile, setApkFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState("");

  const latest = useMemo(() => releases.find((release) => release.isActive) || releases[0], [releases]);

  async function loadReleases() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch("/api/admin/apk-releases", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to load APK releases");
      setReleases(Array.isArray(data?.data) ? data.data : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load APK releases");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReleases();
  }, []);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setApkFile(event.target.files?.[0] || null);
    setUploadProgress(0);
    setUploadPhase("");
  }

  async function requestUploadGrant(file: File): Promise<ApkUploadGrant> {
    const response = await fetch("/api/admin/apk-releases/upload-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        versionName: versionName.trim(),
        versionCode: versionCode.trim(),
        releaseNotes: releaseNotes.trim(),
        mandatory,
        originalName: file.name,
        sizeBytes: file.size,
      }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || "Unable to authorize the APK upload");
    }
    if (!payload?.token || !payload?.uploadUrl || payload?.method !== "PUT") {
      throw new Error("The server returned an invalid APK upload authorization");
    }
    const uploadUrl = String(payload.uploadUrl);
    if (!/^https?:\/\//i.test(uploadUrl)) {
      throw new Error("The server returned an invalid storage upload URL");
    }
    return {
      token: String(payload.token),
      uploadUrl,
      method: "PUT",
      contentType: String(payload.contentType || "application/vnd.android.package-archive"),
    };
  }

  function uploadApkWithProgress(file: File, grant: ApkUploadGrant): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(grant.method, grant.uploadUrl);
      xhr.responseType = "text";
      xhr.timeout = 2 * 60 * 60 * 1000;
      xhr.setRequestHeader("Content-Type", grant.contentType);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          setUploadPhase("Uploading APK...");
          return;
        }
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        setUploadProgress(percent);
        setUploadPhase(percent >= 100 ? "Upload received. Saving release..." : `Uploading APK... ${percent}%`);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(100);
          resolve();
        } else {
          const payload = parseUploadResponse(xhr.responseText, "Failed to upload APK");
          reject(new Error(payload?.message || `Failed to upload APK (${xhr.status})`));
        }
      };

      xhr.onerror = () =>
        reject(
          new Error(
            "The storage upload could not connect. Check the network and try again."
          )
        );
      xhr.ontimeout = () => reject(new Error("The APK upload timed out. Check the network and retry."));
      xhr.onabort = () => reject(new Error("APK upload was cancelled"));
      xhr.send(file);
    });
  }

  async function completeUpload(uploadToken: string): Promise<void> {
    const response = await fetch("/api/admin/apk-releases/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadToken }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || "The APK uploaded but could not be published");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apkFile) {
      setError("Choose an APK file before uploading.");
      return;
    }

    try {
      setUploading(true);
      setUploadProgress(0);
      setUploadPhase("Preparing upload...");
      setError("");
      setSuccess("");

      setUploadPhase("Authorizing secure upload...");
      const grant = await requestUploadGrant(apkFile);
      setUploadPhase("Uploading APK...");
      await uploadApkWithProgress(apkFile, grant);
      setUploadPhase("Verifying and publishing release...");
      await completeUpload(grant.token);

      setSuccess("APK uploaded and activated.");
      setVersionName("");
      setVersionCode("");
      setReleaseNotes("");
      setMandatory(false);
      setApkFile(null);
      setUploadProgress(0);
      setUploadPhase("");
      const input = document.getElementById("apk-file-input") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadReleases();
    } catch (err: any) {
      setError(err?.message || "Failed to upload APK");
    } finally {
      setUploading(false);
      setUploadPhase("");
    }
  }

  return (
    <AdminNavbarV2>
      <Box
        sx={{
          maxWidth: 1320,
          mx: "auto",
          p: { xs: 2, md: 3 },
        }}
      >
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", md: "center" }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" fontWeight={900} letterSpacing={-0.5}>
            APK Manager
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            Upload Android builds, publish the latest APK, and control optional or mandatory updates.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<RefreshRoundedIcon />}
          onClick={loadReleases}
          disabled={loading || uploading}
          sx={{ alignSelf: { xs: "flex-start", md: "center" }, borderRadius: 1.5 }}
        >
          Refresh
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "minmax(320px, 0.8fr) minmax(0, 1.6fr)" },
          gap: 2.5,
        }}
      >
        <Box>
          <Card variant="outlined" sx={{ borderRadius: 2, boxShadow: "0 14px 34px rgba(15,23,42,0.06)" }}>
            <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
              <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: 2,
                    display: "grid",
                    placeItems: "center",
                    bgcolor: "success.light",
                    color: "success.contrastText",
                  }}
                >
                  <AndroidRoundedIcon />
                </Box>
                <Box>
                  <Typography variant="h6" fontWeight={900}>
                    Latest Android APK
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Public website and app update checks use this release.
                  </Typography>
                </Box>
              </Stack>

              {latest ? (
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip color="primary" label={`v${latest.versionName}`} sx={{ fontWeight: 800 }} />
                    <Chip label={`Code ${latest.versionCode}`} />
                    <Chip
                      color={latest.mandatory ? "error" : "success"}
                      variant={latest.mandatory ? "filled" : "outlined"}
                      label={latest.mandatory ? "Mandatory" : "Optional"}
                    />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    Uploaded {formatDate(latest.createdAt)} by{" "}
                    {latest.uploadedBy?.username || latest.uploadedBy?.email || "admin"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Size: {formatBytes(latest.sizeBytes)}
                  </Typography>
                  <Button
                    component="a"
                    href={latest.downloadUrl || latest.apkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="contained"
                    startIcon={<DownloadRoundedIcon />}
                    sx={{ alignSelf: "flex-start", mt: 1, borderRadius: 1.5 }}
                  >
                    Download APK
                  </Button>
                </Stack>
              ) : (
                <Typography color="text.secondary">No APK has been uploaded yet.</Typography>
              )}
            </CardContent>
          </Card>

          <Card variant="outlined" sx={{ mt: 2.5, borderRadius: 2 }}>
            <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
              <Typography variant="h6" fontWeight={900} sx={{ mb: 2 }}>
                Upload new version
              </Typography>
              <Box component="form" onSubmit={onSubmit}>
                <Stack spacing={2}>
                  <Button
                    component="label"
                    variant="outlined"
                    startIcon={<CloudUploadRoundedIcon />}
                    disabled={uploading}
                    sx={{ borderRadius: 1.5, alignSelf: "flex-start" }}
                  >
                    Choose APK
                    <input id="apk-file-input" hidden type="file" accept=".apk,application/vnd.android.package-archive" onChange={onFileChange} />
                  </Button>
                  {apkFile && (
                    <Typography variant="body2" color="text.secondary">
                      {apkFile.name} · {formatBytes(apkFile.size)}
                    </Typography>
                  )}
                  {uploading && (
                    <Box>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.75 }}>
                        <Typography variant="body2" fontWeight={800}>
                          {uploadPhase || "Uploading APK..."}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" fontWeight={800}>
                          {uploadProgress}%
                        </Typography>
                      </Stack>
                      <LinearProgress
                        variant="determinate"
                        value={uploadProgress}
                        sx={{
                          height: 8,
                          borderRadius: 1,
                          bgcolor: "#e2e8f0",
                          "& .MuiLinearProgress-bar": {
                            borderRadius: 1,
                          },
                        }}
                      />
                    </Box>
                  )}
                  <TextField
                    label="Version name"
                    placeholder="1.0.8"
                    value={versionName}
                    onChange={(event) => setVersionName(event.target.value)}
                    required
                    fullWidth
                  />
                  <TextField
                    label="Version code"
                    placeholder="108"
                    type="number"
                    value={versionCode}
                    onChange={(event) => setVersionCode(event.target.value)}
                    required
                    fullWidth
                    inputProps={{ min: 1, step: 1 }}
                  />
                  <TextField
                    label="Release notes"
                    value={releaseNotes}
                    onChange={(event) => setReleaseNotes(event.target.value)}
                    fullWidth
                    multiline
                    minRows={4}
                  />
                  <FormControlLabel
                    control={<Switch checked={mandatory} onChange={(event) => setMandatory(event.target.checked)} />}
                    label="Mandatory update"
                  />
                  {mandatory && (
                    <Alert severity="warning">
                      Mandatory updates block old Android versions until users start the installer.
                    </Alert>
                  )}
                  <Button
                    type="submit"
                    variant="contained"
                    disabled={uploading}
                    startIcon={uploading ? <CircularProgress size={18} color="inherit" /> : <CloudUploadRoundedIcon />}
                    sx={{ borderRadius: 1.5, height: 42 }}
                  >
                    {uploading ? "Uploading..." : "Upload and activate"}
                  </Button>
                </Stack>
              </Box>
            </CardContent>
          </Card>
        </Box>

        <Box>
          <Paper variant="outlined" sx={{ borderRadius: 2, overflow: "hidden", boxShadow: "0 14px 34px rgba(15,23,42,0.05)" }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ xs: "stretch", sm: "center" }}
              spacing={1}
              sx={{ p: { xs: 2, md: 2.5 } }}
            >
              <Box>
                <Typography variant="h6" fontWeight={900}>
                  Release history
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Older entries stay available for audit; the newest upload becomes the active APK.
                </Typography>
              </Box>
              <Chip label={`${releases.length} releases`} sx={{ borderRadius: 1.25 }} />
            </Stack>
            <Divider />
            {loading ? (
              <Box sx={{ p: 6, textAlign: "center" }}>
                <CircularProgress />
              </Box>
            ) : (
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Version</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Size</TableCell>
                      <TableCell>Uploaded</TableCell>
                      <TableCell>Notes</TableCell>
                      <TableCell align="right">Download</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {releases.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
                            No APK releases yet.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      releases.map((release) => (
                        <TableRow key={release.id} hover>
                          <TableCell>
                            <Typography fontWeight={900}>v{release.versionName}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              Code {release.versionCode}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                              {release.isActive && <Chip size="small" color="primary" label="Active" />}
                              <Chip
                                size="small"
                                color={release.mandatory ? "error" : "success"}
                                variant={release.mandatory ? "filled" : "outlined"}
                                label={release.mandatory ? "Mandatory" : "Optional"}
                              />
                            </Stack>
                          </TableCell>
                          <TableCell>{formatBytes(release.sizeBytes)}</TableCell>
                          <TableCell>
                            <Typography variant="body2">{formatDate(release.createdAt)}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {release.uploadedBy?.username || release.uploadedBy?.email || "admin"}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ maxWidth: 280 }}>
                            <Typography variant="body2" color="text.secondary" noWrap>
                              {release.releaseNotes || "-"}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Button
                              component="a"
                              href={release.downloadUrl || release.apkUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              startIcon={<DownloadRoundedIcon />}
                              size="small"
                              sx={{ borderRadius: 1.25 }}
                            >
                              APK
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Box>
      </Box>
      </Box>
    </AdminNavbarV2>
  );
}
