import api from './api';
import salvageService, {
  isSalvageGenerating,
  salvageSubmissionAction,
  type SalvageReport,
  type SalvageAssessmentV2,
} from './salvageService';

jest.mock('./api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() },
}));
const report: SalvageReport = {
  _id: 'report-1',
  status: 'preview',
  revision: 3,
  preview_data: { vin: 'EDITED', imageUrls: ['https://assetinsight.pro/photo.jpg'] },
};
beforeEach(() => {
  jest.clearAllMocks();
});

it('loads canonical reports and editable previews, not file-only rows', async () => {
  jest
    .mocked(api.get)
    .mockResolvedValueOnce({ data: { data: [report] } })
    .mockResolvedValueOnce({ data: { data: report } });
  expect(await salvageService.list()).toEqual([report]);
  expect(await salvageService.getPreview(report._id)).toEqual(report);
  expect(api.get).toHaveBeenNthCalledWith(1, '/salvage');
  expect(api.get).toHaveBeenNthCalledWith(2, '/salvage/report-1/preview');
});

it('saves a versioned snapshot without posting images', async () => {
  jest.mocked(api.patch).mockResolvedValue({ data: { data: { ...report, revision: 4 } } });
  const saved = await salvageService.savePreview(report._id, report.preview_data!, 3);
  expect(saved.revision).toBe(4);
  expect(api.patch).toHaveBeenCalledWith('/salvage/report-1/preview', {
    data: { vin: 'EDITED' },
    baseRevision: 3,
  });
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps assessment evidence and original images out of editable requests', async () => {
  jest.mocked(api.patch).mockResolvedValue({ data: { data: { ...report, revision: 4 } } });
  await salvageService.savePreview(report._id, { assessment_inputs: { province: 'ON', market: 'Toronto', odometer: null },
    assessment: {} as SalvageAssessmentV2, imageUrls: ['https://assetinsight.pro/photo.jpg'], user: 'other-owner' }, 3);
  expect(api.patch).toHaveBeenCalledWith('/salvage/report-1/preview', { data: { assessment_inputs: { province: 'ON', market: 'Toronto', odometer: null } }, baseRevision: 3 });
  expect(api.post).not.toHaveBeenCalled();
});

it('preserves report context values and explicit clears but excludes server report enrichment from revisioned edits', async () => {
  jest.mocked(api.patch).mockResolvedValue({ data: { data: { ...report, revision: 4 } } });
  await salvageService.savePreview(report._id, {
    report_context: { intended_use: 'Disposition review', reconciliation_notes: 'First note\nSecond note', pre_loss_condition: null, repair_estimate_date: '2026-09-09' },
    report_enrichment: { schemaVersion: 1, sections: [{ id: 'executive-summary', title: 'Do not post', paragraphs: ['Protected'], tables: [] }] },
    imageUrls: ['https://assetinsight.pro/original.jpg'],
  }, 3);
  expect(api.patch).toHaveBeenCalledWith('/salvage/report-1/preview', { data: {
    report_context: { intended_use: 'Disposition review', reconciliation_notes: 'First note\nSecond note', pre_loss_condition: null, repair_estimate_date: '2026-09-09' },
  }, baseRevision: 3 });
  expect(api.post).not.toHaveBeenCalled();
});

it('preserves explicit workbook field edits and null clears without sending vehicle evidence or photos', async () => {
  jest.mocked(api.patch).mockResolvedValue({ data: { data: { ...report, revision: 4 } } });
  await salvageService.savePreview(report._id, {
    assessment_inputs: { vehicleOverrides: { vin: null, engineModel: 'Manual model', 'spec:Transmission': 'Automatic' } },
    assessment: { vehicleDetails: { schemaVersion: 1, fields: [] } } as unknown as SalvageAssessmentV2,
    vehicleDetails: { fields: [{ key: 'vin', value: 'FORGED' }] },
    imageUrls: ['https://assetinsight.pro/original.jpg'],
  }, 3);
  expect(api.patch).toHaveBeenCalledWith('/salvage/report-1/preview', { data: {
    assessment_inputs: { vehicleOverrides: { vin: null, engineModel: 'Manual model', 'spec:Transmission': 'Automatic' } },
  }, baseRevision: 3 });
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['preview', 'declined', 'approved', 'pending_approval'] as const)(
  'submits %s from persisted status with the current revision',
  async (status) => {
    jest.mocked(api.post).mockResolvedValue({ data: { data: report, reportId: report._id } });
    const row = { ...report, status };
    await salvageService.submit(row);
    const action = status === 'preview' ? 'submit' : 'resubmit';
    expect(salvageSubmissionAction(row)).toBe(action);
    expect(api.post).toHaveBeenCalledWith(`/salvage/report-1/${action}`, { baseRevision: 3 });
  }
);

it('does not automatically retry a rejected submit or revision conflict', async () => {
  const conflict = { response: { status: 409, data: { code: 'SALVAGE_REVISION_CONFLICT' } } };
  jest.mocked(api.post).mockRejectedValue(conflict);
  await expect(salvageService.submit(report)).rejects.toBe(conflict);
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('retries the existing report without creating or uploading another one', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { ...report, status: 'processing' } } });
  await salvageService.retry(report._id);
  expect(api.post).toHaveBeenCalledWith('/salvage/report-1/retry');
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('cancels the exact active job with revision fencing and resumes the same report with its saved revision', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { ...report, status: 'cancelled' } } });
  await salvageService.cancel(report._id, 3, 'job-original');
  expect(api.post).toHaveBeenLastCalledWith('/salvage/report-1/cancel', { baseRevision: 3, jobId: 'job-original' });
  await salvageService.retry(report._id, 4);
  expect(api.post).toHaveBeenLastCalledWith('/salvage/report-1/retry', { baseRevision: 4 });
  expect(api.patch).not.toHaveBeenCalled();
});

it('does not automatically replay an uncertain cancellation', async () => {
  jest.mocked(api.post).mockRejectedValue(new Error('Network response unknown'));
  await expect(salvageService.cancel(report._id, 3, 'job-original')).rejects.toThrow('Network response unknown');
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('requests new research explicitly with the saved revision and stable identity', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { ...report, status: 'processing' } } });
  await salvageService.research(report._id, 3, 'research-identity');
  expect(api.post).toHaveBeenCalledWith('/salvage/report-1/research', { baseRevision: 3, client_request_id: 'research-identity' });
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([
  { status: 'processing' },
  { files_generating: true },
  { generation_state: 'queued' },
  { generation_state: 'processing' },
  { workflow_stage: 'preparing_preview' },
  { workflow_stage: 'generating_files' },
])('locks editing while background work is active: %j', (change) => {
  expect(isSalvageGenerating({ ...report, ...change } as SalvageReport)).toBe(true);
});

it('allows a ready or failed report to be reviewed without treating it as running', () => {
  expect(isSalvageGenerating(report)).toBe(false);
  expect(isSalvageGenerating({ ...report, generation_state: 'error' })).toBe(false);
});
