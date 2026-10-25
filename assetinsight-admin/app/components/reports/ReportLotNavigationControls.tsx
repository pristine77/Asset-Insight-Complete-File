"use client";

import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { reportLotNavigation } from "@/lib/reportLotNavigation";

type Props = {
  lots: Record<string, unknown>[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  placement: "top" | "bottom";
  includeSummary?: boolean;
};

export default function ReportLotNavigationControls({ lots, selectedIndex, onSelect, placement, includeSummary = false }: Props) {
  const navigation = reportLotNavigation(lots.length, selectedIndex, includeSummary);
  if (!navigation.total) return null;

  return (
    <Box component="nav" aria-label={`Lot navigation ${placement}`} sx={{ my: 1.5, p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }}>
      <Typography sx={{ fontSize: 13, fontWeight: 750 }}>{navigation.loaded}</Typography>
      <Typography aria-live={placement === "top" ? "polite" : undefined} sx={{ mt: 0.25, mb: 1.25, fontSize: 12.5, color: "text.secondary" }}>
        {navigation.position}. Choose a lot below; this does not change the report or its files.
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }}>
        <TextField
          select
          label="Jump to lot"
          size="small"
          value={navigation.selected}
          onChange={(event) => onSelect(Number(event.target.value))}
          SelectProps={{ native: true }}
          sx={{ minWidth: 0, flex: 1 }}
        >
          {includeSummary ? <option value={-1}>Report summary</option> : null}
          {lots.map((lot, index) => <option key={index} value={index}>Lot {String(lot.lot_number || lot.lotNumber || index + 1)} ({index + 1} of {lots.length})</option>)}
        </TextField>
        <Stack direction="row" spacing={1}>
          <Button type="button" variant="outlined" disabled={navigation.previous === null} onClick={() => { if (navigation.previous !== null) onSelect(navigation.previous); }} sx={{ flex: { xs: 1, sm: "none" }, minHeight: 40 }}>Previous lot</Button>
          <Button type="button" variant="outlined" disabled={navigation.next === null} onClick={() => { if (navigation.next !== null) onSelect(navigation.next); }} sx={{ flex: { xs: 1, sm: "none" }, minHeight: 40 }}>Next lot</Button>
        </Stack>
      </Stack>
    </Box>
  );
}
