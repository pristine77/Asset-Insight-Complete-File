import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'OfflineReportsScreen.tsx'), 'utf8');

describe('Drafts submission boundary', () => {
  it('opens the canonical form for every local Asset and Lot Listing draft', () => {
    const handler = source.match(/const submitLocalDraft = useCallback\(([\s\S]*?)\}, \[onContinueDraft\]\);/)?.[1];
    expect(handler).toBeDefined();
    expect(handler).toContain('onContinueDraft(draft.id, draft.type)');
    expect(handler).toContain('backgroundUploadManager.isBusy');
    expect(source).toContain('onPress={() => submitLocalDraft(item.draft)}');
  });

  it('does not maintain a second upload payload or acceptance/cleanup workflow', () => {
    expect(source).not.toMatch(/buildAssetSubmission|buildLotListingSubmission|const asPhoto\b/);
    expect(source).not.toMatch(/from ['"]\.\.\/services\/(?:assetService|lotListingService|offlineSubmissionService)['"]/);
    expect(source).not.toMatch(/createAssetReport\(|createLotListing\(|setSubmissionState\(|removeDraftRecordOnly\(/);
  });

  it('continues to restore cloud-only drafts before opening their canonical form', () => {
    const handler = source.match(/const continueCloudDraft = useCallback\(([\s\S]*?)\}, \[onContinueDraft\]\);/)?.[1];
    expect(handler).toContain('AutoSaveService.saveCloudDraftSnapshot');
    expect(handler).toContain('onContinueDraft(local.id, local.type)');
    expect(handler).not.toContain('reportDraftService.delete');
    expect(handler).toContain('reportDraftService.get(cloudId)');
    expect(handler).toContain('hydrateCompleteCloudDraft');
    expect(source).not.toContain('deleteDraftMedia');
  });
});
