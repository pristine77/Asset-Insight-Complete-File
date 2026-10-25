import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

it('does not expose a per-lot AI reread route or regeneration lifecycle in the mobile preview', () => {
  for (const relative of ['src/screens/PreviewScreen.tsx', 'src/services/assetService.ts', 'src/services/lotListingService.ts']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    expect(source).not.toMatch(/regenerateLot|lot_regeneration|LOT_REGENERATION_PENDING|LOT_REGENERATION_POLL_MS/);
    expect(source).not.toMatch(/lots\/[^\n]*\/regenerate/);
  }
  expect(fs.existsSync(path.join(root, 'src/services/lotRegeneration.ts'))).toBe(false);
});

it('never hides other same-contract drafts as a side effect of autosave', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/autoSaveService.ts'), 'utf8');
  expect(source).not.toContain('discardEmptyDraftsSupersededBy');
});
