"use client";

/**
 * Move Leads window (owner, 2026-11-20).
 *
 * Bree's case: Tanner holds about 15,000 Winnipeg leads and has moved to
 * Edmonton. Leads are never deleted; an admin moves them in one step, either to
 * another salesperson or into a VACANT POOL ("Vacant — Winnipeg") that holds
 * them until someone takes the territory, and later hands the pool over.
 *
 * 1. Move from: any owner of leads (salesperson, pool or former employee),
 *    narrowed by open only, upload, province/state and city. The count and its
 *    breakdown are asked of the server as the filters change; nothing moves.
 * 2. Move to: an existing pool, a new pool (created first, then filled) or an
 *    active salesperson, who may get one email and one app notice for the batch.
 * The server does the move and its checks (assetinsight-backend
 * service/crmLeadMoveService.ts); this window only collects the choice,
 * confirms it and shows the result, the pools and the recent moves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputLabel,
  LinearProgress,
  ListSubheader,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";

type OwnerKind = "agent" | "pool" | "former";
type MoveOwner = { id: string; label: string; kind: OwnerKind; total: number; open: number };
type CountRow = { value: string; count: number };
type MovePreview = {
  from: { id: string; label: string; kind: OwnerKind };
  count: number;
  max: number;
  byStatus: CountRow[];
  byRegion: CountRow[];
  byCity: CountRow[];
};
type LeadMove = {
  id: string;
  from: string;
  to: string;
  count: number;
  filters?: { openOnly?: boolean; sourceBatchId?: string; region?: string; city?: string };
  movedBy: string;
  createdAt: string;
};
type ImportFile = { sourceBatchId: string; sourceFileName?: string; leadCount: number };
type Target = "pool" | "newPool" | "agent";

const PREVIEW_DELAY_MS = 400;
const number = (value: number) => value.toLocaleString("en-CA");
const statusText = (value: string) =>
  value ? value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "No status";

const PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
/** "CA-MB" → "Manitoba"; any other region code is shown as stored. */
function regionText(value: string): string {
  if (!value) return "No region";
  const [country, code] = value.split("-");
  if (country === "CA" && code && PROVINCES[code]) return PROVINCES[code];
  return value;
}

async function readJson(res: Response, fallback: string) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string })?.message || fallback);
  return json;
}

export default function AdminCrmMoveLeadsDialog({
  open,
  fullScreen,
  onClose,
  onMoved,
  notify,
}: {
  open: boolean;
  fullScreen?: boolean;
  onClose: () => void;
  /** Called after a move so the page can reload its leads and counts. */
  onMoved?: () => void;
  notify: (message: string, type?: "success" | "error" | "info") => void;
}) {
  const [owners, setOwners] = useState<MoveOwner[]>([]);
  const [moves, setMoves] = useState<LeadMove[]>([]);
  const [importFiles, setImportFiles] = useState<ImportFile[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);

  const [fromId, setFromId] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [sourceBatchId, setSourceBatchId] = useState("");
  const [regionChoices, setRegionChoices] = useState<CountRow[]>([]);

  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const [target, setTarget] = useState<Target>("pool");
  const [poolId, setPoolId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [newPoolName, setNewPoolName] = useState("");
  const [tellAgent, setTellAgent] = useState(true);

  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [lastResult, setLastResult] = useState("");

  // The page passes a new toast function on every render; read it through a
  // ref so the lists are not reloaded each time the page redraws.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  const say = useCallback((message: string, type?: "success" | "error" | "info") => notifyRef.current(message, type), []);

  const loadLists = useCallback(async () => {
    setLoadingLists(true);
    try {
      const [ownersJson, movesJson, filesJson] = await Promise.all([
        fetch(`/api/admin/crm/leads/move/owners`, { cache: "no-store" }).then((r) => readJson(r, "Failed to load lead owners")),
        fetch(`/api/admin/crm/leads/moves?limit=20`, { cache: "no-store" }).then((r) => readJson(r, "Failed to load recent moves")),
        fetch(`/api/admin/crm/import-files?page=1&limit=100`, { cache: "no-store" }).then((r) => readJson(r, "Failed to load uploads")),
      ]);
      setOwners(((ownersJson as { items?: MoveOwner[] }).items || []));
      setMoves(((movesJson as { items?: LeadMove[] }).items || []));
      setImportFiles(((filesJson as { items?: ImportFile[] }).items || []));
    } catch (e: unknown) {
      say(e instanceof Error ? e.message : "Failed to load the Move Leads window", "error");
    } finally {
      setLoadingLists(false);
    }
  }, [say]);

  useEffect(() => {
    if (open) void loadLists();
  }, [open, loadLists]);

  const filters = useMemo(() => ({
    openOnly,
    city: city.trim() || undefined,
    region: region || undefined,
    sourceBatchId: sourceBatchId || undefined,
  }), [openOnly, city, region, sourceBatchId]);

  // Counts the owner's matching leads (nothing moves). The newest answer wins;
  // an answer to an older question is dropped.
  const previewSeq = useRef(0);
  const countLeads = useCallback(async (owner: string, f: typeof filters) => {
    const seq = ++previewSeq.current;
    setPreviewing(true);
    try {
      const res = await fetch(`/api/admin/crm/leads/move/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromUserId: owner, filters: f }),
      });
      const json = (await readJson(res, "Failed to count the leads")) as MovePreview;
      if (seq !== previewSeq.current) return;
      setPreview(json);
      setPreviewError("");
      // The province list is the owner's own, taken while no province is chosen.
      if (!f.region) setRegionChoices(json.byRegion.filter((row) => row.value));
    } catch (e: unknown) {
      if (seq !== previewSeq.current) return;
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : "Failed to count the leads");
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }, []);

  // Count again a moment after the owner or a filter changes (typing a city
  // asks once, not on every key).
  useEffect(() => {
    if (!open || !fromId) {
      previewSeq.current += 1;
      setPreview(null);
      setPreviewError("");
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const timer = setTimeout(() => void countLeads(fromId, filters), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, fromId, filters, countLeads]);

  const pools = owners.filter((o) => o.kind === "pool");
  const agents = owners.filter((o) => o.kind === "agent");
  const formers = owners.filter((o) => o.kind === "former" && o.total > 0);
  const fromOwner = owners.find((o) => o.id === fromId) || null;
  const poolChoices = pools.filter((p) => p.id !== fromId);
  const agentChoices = agents.filter((a) => a.id !== fromId);

  const toLabel = target === "pool"
    ? pools.find((p) => p.id === poolId)?.label || ""
    : target === "agent"
      ? agents.find((a) => a.id === agentId)?.label || ""
      : newPoolName.trim() ? `Vacant — ${newPoolName.trim()}` : "";
  const count = preview?.count ?? 0;
  const tooMany = !!preview && count > preview.max;
  const targetReady = target === "pool" ? !!poolId : target === "agent" ? !!agentId : newPoolName.trim().length >= 2;
  const canMove = !!fromId && !!preview && count > 0 && !tooMany && targetReady && !previewing && !moving;

  function pickFrom(id: string) {
    setFromId(id);
    setRegion("");
    setRegionChoices([]);
    setLastResult("");
    if (poolId === id) setPoolId("");
    if (agentId === id) setAgentId("");
  }

  /** Fills the window to hand a pool's leads to the person taking the territory. */
  function handOver(pool: MoveOwner) {
    pickFrom(pool.id);
    setOpenOnly(false);
    setCity("");
    setSourceBatchId("");
    setTarget("agent");
  }

  async function doMove() {
    setMoving(true);
    try {
      let toUserId = target === "pool" ? poolId : agentId;
      if (target === "newPool") {
        const res = await fetch(`/api/admin/crm/vacant-pools`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newPoolName.trim() }),
        });
        const created = (await readJson(res, "Failed to create the vacant pool")) as { id: string };
        toUserId = created.id;
      }
      const res = await fetch(`/api/admin/crm/leads/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromUserId: fromId, toUserId, filters, notify: target === "agent" ? tellAgent : false }),
      });
      const result = (await readJson(res, "Failed to move the leads")) as { movedCount: number; from: string; to: string };
      const message = `Moved ${number(result.movedCount)} leads from ${result.from} to ${result.to}.`;
      setLastResult(message);
      say(message, "success");
      setConfirming(false);
      if (target === "newPool") {
        setNewPoolName("");
        setTarget("pool");
        setPoolId(toUserId);
      }
      onMoved?.();
      // The owner's counts, the pools and the history all changed; the same
      // filters now count what is left (normally none).
      await Promise.all([loadLists(), countLeads(fromId, filters)]);
    } catch (e: unknown) {
      setConfirming(false);
      say(e instanceof Error ? e.message : "Failed to move the leads", "error");
      // A new pool may have been created before the move failed; show it.
      if (target === "newPool") void loadLists();
    } finally {
      setMoving(false);
    }
  }

  const filterSummary = (f?: LeadMove["filters"]) => [
    f?.openOnly ? "Open only" : "All statuses",
    f?.region ? regionText(f.region) : "",
    f?.city || "",
    f?.sourceBatchId ? importFiles.find((file) => file.sourceBatchId === f.sourceBatchId)?.sourceFileName || "One upload" : "",
  ].filter(Boolean).join(" · ");

  const ownerOption = (o: MoveOwner) => (
    <MenuItem key={o.id} value={o.id} disabled={o.total === 0}>
      {o.label} · {number(o.total)} leads · {number(o.open)} open
    </MenuItem>
  );

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth fullScreen={fullScreen} scroll="paper">
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, pb: 1 }}>
          <Box>
            <Typography variant="h6" fontWeight={800}>Move Leads</Typography>
            <Typography variant="body2" color="text.secondary">
              Move a salesperson&apos;s leads to someone else, or park them in a vacant pool until the territory is filled. Nothing is deleted.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" startIcon={<RefreshRoundedIcon />} onClick={() => void loadLists()} disabled={loadingLists}>
              {loadingLists ? "…" : "Refresh"}
            </Button>
            <IconButton size="small" onClick={onClose} aria-label="Close"><CloseRoundedIcon /></IconButton>
          </Stack>
        </DialogTitle>
        {loadingLists && <LinearProgress />}
        <DialogContent dividers sx={{ p: 0 }}>
          <Grid container>
            <Grid size={{ xs: 12, lg: 7 }} sx={{ p: 2, borderRight: { lg: "1px solid" }, borderColor: { lg: "divider" } }}>
              <Typography variant="overline" color="text.secondary" fontWeight={700}>1 · Move from</Typography>
              <Stack spacing={1.5} sx={{ mb: 2 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel>Current owner</InputLabel>
                  <Select value={fromId} label="Current owner" onChange={(e) => pickFrom(String(e.target.value))}>
                    {agents.length > 0 && <ListSubheader>Salespeople</ListSubheader>}
                    {agents.map(ownerOption)}
                    {pools.length > 0 && <ListSubheader>Vacant pools</ListSubheader>}
                    {pools.map(ownerOption)}
                    {formers.length > 0 && <ListSubheader>Former owners (blocked or no longer CRM)</ListSubheader>}
                    {formers.map(ownerOption)}
                  </Select>
                </FormControl>
                <Grid container spacing={1.5}>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <TextField size="small" fullWidth label="City" placeholder="e.g. Winnipeg" value={city} onChange={(e) => setCity(e.target.value)} disabled={!fromId} />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <FormControl size="small" fullWidth disabled={!fromId}>
                      <InputLabel>Province / State</InputLabel>
                      <Select value={region} label="Province / State" onChange={(e) => setRegion(String(e.target.value))}>
                        <MenuItem value="">Any</MenuItem>
                        {regionChoices.map((row) => (
                          <MenuItem key={row.value} value={row.value}>{regionText(row.value)} · {number(row.count)}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <FormControl size="small" fullWidth disabled={!fromId}>
                      <InputLabel>Upload</InputLabel>
                      <Select value={sourceBatchId} label="Upload" onChange={(e) => setSourceBatchId(String(e.target.value))}>
                        <MenuItem value="">Any upload</MenuItem>
                        {importFiles.map((file) => (
                          <MenuItem key={file.sourceBatchId} value={file.sourceBatchId}>{file.sourceFileName || file.sourceBatchId}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                </Grid>
                <FormControlLabel
                  control={<Checkbox size="small" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} disabled={!fromId} />}
                  label={<Typography variant="body2">Only open leads (leave Won and Lost with the current owner)</Typography>}
                />
              </Stack>

              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, mb: 2 }}>
                {!fromId ? (
                  <Typography variant="body2" color="text.secondary">Choose whose leads to move.</Typography>
                ) : previewError ? (
                  <Alert severity="error">{previewError}</Alert>
                ) : (
                  <>
                    <Stack direction="row" spacing={1} alignItems="baseline">
                      <Typography variant="h4" fontWeight={800} color="primary.main">{preview ? number(count) : "…"}</Typography>
                      <Typography variant="body2">leads will move</Typography>
                    </Stack>
                    {previewing && <LinearProgress sx={{ my: 0.5 }} />}
                    {preview && preview.byStatus.length > 0 && (
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                        {preview.byStatus.map((row) => <Chip key={row.value} size="small" label={`${statusText(row.value)} ${number(row.count)}`} />)}
                      </Stack>
                    )}
                    {preview && !city.trim() && preview.byCity.filter((row) => row.value).length > 1 && (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" color="text.secondary">Cities (click one to move only that city):</Typography>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                          {preview.byCity.filter((row) => row.value).slice(0, 12).map((row) => (
                            <Chip key={row.value} size="small" variant="outlined" label={`${row.value} ${number(row.count)}`} onClick={() => setCity(row.value)} />
                          ))}
                        </Stack>
                      </Box>
                    )}
                    {tooMany && preview && (
                      <Alert severity="warning" sx={{ mt: 1 }}>
                        One move takes at most {number(preview.max)} leads. Narrow it by province, city or upload and move it in parts.
                      </Alert>
                    )}
                    {preview && count === 0 && !previewing && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>No leads match these filters.</Typography>
                    )}
                  </>
                )}
              </Box>

              <Typography variant="overline" color="text.secondary" fontWeight={700}>2 · Move to</Typography>
              <RadioGroup row value={target} onChange={(e) => setTarget(e.target.value as Target)} sx={{ mb: 1 }}>
                <FormControlLabel value="pool" control={<Radio size="small" />} label="Vacant pool" />
                <FormControlLabel value="newPool" control={<Radio size="small" />} label="New vacant pool" />
                <FormControlLabel value="agent" control={<Radio size="small" />} label="Another salesperson" />
              </RadioGroup>
              {target === "pool" && (
                <FormControl size="small" fullWidth>
                  <InputLabel>Pool</InputLabel>
                  <Select value={poolId} label="Pool" onChange={(e) => setPoolId(String(e.target.value))}>
                    {poolChoices.length === 0 && <MenuItem value="" disabled>No vacant pools yet: choose New vacant pool</MenuItem>}
                    {poolChoices.map((p) => <MenuItem key={p.id} value={p.id}>{p.label} · {number(p.total)} leads</MenuItem>)}
                  </Select>
                </FormControl>
              )}
              {target === "newPool" && (
                <TextField
                  size="small"
                  fullWidth
                  label="Territory name"
                  placeholder="e.g. Winnipeg"
                  value={newPoolName}
                  onChange={(e) => setNewPoolName(e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 60 } }}
                  helperText={newPoolName.trim() ? `Will be called “Vacant — ${newPoolName.trim()}”` : "Will be called “Vacant — …”"}
                />
              )}
              {target === "agent" && (
                <Stack spacing={1}>
                  <FormControl size="small" fullWidth>
                    <InputLabel>Salesperson</InputLabel>
                    <Select value={agentId} label="Salesperson" onChange={(e) => setAgentId(String(e.target.value))}>
                      {agentChoices.map((a) => <MenuItem key={a.id} value={a.id}>{a.label} · {number(a.total)} leads now</MenuItem>)}
                    </Select>
                  </FormControl>
                  <FormControlLabel
                    control={<Checkbox size="small" checked={tellAgent} onChange={(e) => setTellAgent(e.target.checked)} />}
                    label={<Typography variant="body2">Tell them (one email and one app notice for the whole batch)</Typography>}
                  />
                </Stack>
              )}
              <Alert icon={<LockRoundedIcon fontSize="small" />} severity="success" sx={{ mt: 1.5 }}>
                Notes, comments, status, follow-up dates and history stay with each lead. A vacant pool is not a person: it cannot sign in, gets no emails and is left out of agent lists.
              </Alert>
              {lastResult && <Alert severity="success" sx={{ mt: 1.5 }}>{lastResult}</Alert>}
            </Grid>

            <Grid size={{ xs: 12, lg: 5 }} sx={{ p: 2, bgcolor: "action.hover" }}>
              <Typography variant="overline" color="text.secondary" fontWeight={700}>Vacant pools</Typography>
              <Box sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: 2, mb: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Pool</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Open</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Total</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pools.length === 0 && (
                      <TableRow><TableCell colSpan={4} sx={{ color: "text.secondary" }}>No vacant pools yet.</TableCell></TableRow>
                    )}
                    {pools.map((p) => (
                      <TableRow key={p.id} hover>
                        <TableCell sx={{ fontWeight: 700, color: "secondary.main" }}>{p.label}</TableCell>
                        <TableCell align="right">{number(p.open)}</TableCell>
                        <TableCell align="right">{number(p.total)}</TableCell>
                        <TableCell align="right">
                          <Button size="small" disabled={p.total === 0} onClick={() => handOver(p)}>Hand over…</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 1.5, py: 1 }}>
                  Hand over fills in this window to move a pool&apos;s leads to the new salesperson for that territory.
                </Typography>
              </Box>

              <Typography variant="overline" color="text.secondary" fontWeight={700}>Recent moves</Typography>
              <Box sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>When</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>From → To</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Leads</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>By</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {moves.length === 0 && (
                      <TableRow><TableCell colSpan={4} sx={{ color: "text.secondary" }}>No moves yet.</TableCell></TableRow>
                    )}
                    {moves.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell sx={{ whiteSpace: "nowrap" }}>
                          {new Date(m.createdAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </TableCell>
                        <TableCell>
                          {m.from} → {m.to}
                          <Typography variant="caption" color="text.secondary" display="block">{filterSummary(m.filters)}</Typography>
                        </TableCell>
                        <TableCell align="right">{number(m.count)}</TableCell>
                        <TableCell>{m.movedBy || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, py: 1.5 }}>
          <Button onClick={onClose}>Close</Button>
          <Button variant="contained" color="secondary" disabled={!canMove} onClick={() => setConfirming(true)}>
            {preview && count > 0 ? `Move ${number(count)} leads` : "Move leads"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirming} onClose={() => !moving && setConfirming(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Move {number(count)} leads?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            From <b>{fromOwner?.label || preview?.from.label}</b> to <b>{toLabel}</b>
            {target === "newPool" ? " (a new vacant pool)" : ""}. Each lead keeps its notes, status and history.
            {target === "agent" ? (tellAgent ? " They get one email and one app notice." : " Nobody is notified.") : " Nobody is notified."}
            {" "}The move is logged under Recent moves.
          </Typography>
          {moving && <LinearProgress sx={{ mt: 2 }} />}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)} disabled={moving}>Go back</Button>
          <Button variant="contained" color="secondary" onClick={() => void doMove()} disabled={moving}>
            {moving ? "Moving…" : "Yes, move them"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
