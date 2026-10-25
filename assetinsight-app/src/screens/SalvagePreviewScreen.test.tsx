import React from 'react';
import { Alert, AppState } from 'react-native';
import { act, fireEvent, render as renderNative, screen } from '@testing-library/react-native';
import SalvagePreviewScreen from './SalvagePreviewScreen';
import salvageService, { type SalvageReport } from '../services/salvageService';
import { downloadApprovedReportFile } from '../services/reportDownloadTransport';
import assignedApprovalService from '../services/assignedApprovalService';
import NetInfo from '@react-native-community/netinfo';
import { salvageResearchRequestId } from '../services/salvageResearchRequest';
import type { SalvageAssessmentV2 } from '../types/salvageAssessment';

jest.mock('../services/salvageResearchRequest', () => ({
  salvageResearchRequestId: jest.fn(async () => 'stable-research-id'),
  clearSalvageResearchRequest: jest.fn(async () => undefined),
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true, default: { addEventListener: jest.fn(() => jest.fn()) },
}));

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../context/ThemeContext', () => ({
  useAppTheme: () => ({
    colors: { background: '#111', surface: '#222', text: '#fff', accent: '#55f' },
  }),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/reportDownloadTransport', () => ({ downloadApprovedReportFile: jest.fn() }));
jest.mock('../services/assignedApprovalService', () => ({
  __esModule: true,
  default: { getPreview: jest.fn() },
}));
jest.mock('../services/salvageService', () => {
  const actual = jest.requireActual('../services/salvageService');
  return {
    ...actual,
    __esModule: true,
    default: { getPreview: jest.fn(), savePreview: jest.fn(), submit: jest.fn(), retry: jest.fn(), research: jest.fn(), cancel: jest.fn() },
  };
});
jest.mock('../services/api', () => ({ __esModule: true, default: {} }));

const preview: SalvageReport = {
  _id: 'report-1',
  file_number: 'SALVAGE-42',
  status: 'preview',
  revision: 2,
  imageUrls: ['https://assetinsight.pro/original.jpg'],
  preview_data: {
    item_type: 'Vehicle',
    vin: 'OLD-VIN',
    damage_description: 'Front damage',
    repair_items: [],
    labour_breakdown: [],
    valuation: { fair_market_value: 1200 },
  },
};
// Existing editor interaction tests explicitly open the preview from the new status page.
async function render(element: React.ReactElement) {
  const result = await renderNative(element);
  const open = screen.queryByLabelText('Open preview');
  if (open) await fireEvent.press(open);
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
  jest.mocked(salvageService.getPreview).mockResolvedValue(preview);
  jest
    .mocked(salvageService.savePreview)
    .mockImplementation(async (_id, data) => ({ ...preview, revision: 3, preview_data: data }));
  jest.mocked(salvageService.submit).mockResolvedValue({
    message: 'Accepted',
    data: {
      ...preview,
      status: 'pending_approval',
      workflow_stage: 'generating_files',
      files_generating: true,
    },
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('requires explicit research confirmation and sends the persisted request identity', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  jest.mocked(salvageService.research).mockResolvedValue({ message: 'Accepted', data: { ...preview, status: 'processing' } });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.press(screen.getByText('Research again'));
  expect(salvageService.research).not.toHaveBeenCalled();
  expect(alert.mock.calls[0][1]).toMatch(/15 minutes/);
  expect(alert.mock.calls[0][1]).toMatch(/ordinary saves do not run research/i);
  expect(alert.mock.calls[0][1]).not.toMatch(/US\$10|multiplier|cost allowance/i);
  const confirm = alert.mock.calls[0][2]!.find((button) => button.text === 'Start research')!;
  await act(async () => { confirm.onPress?.(); });
  expect(salvageResearchRequestId).toHaveBeenCalledWith('report-1', 2);
  expect(salvageService.research).toHaveBeenCalledWith('report-1', 2, 'stable-research-id');
  expect(salvageService.savePreview).not.toHaveBeenCalled();
  expect(salvageService.submit).not.toHaveBeenCalled();
  expect(screen.queryByText('Research again')).toBeNull();
});

it('edits only appraiser report notes and refreshes the saved review with the next server revision', async () => {
  const enriched: SalvageReport = { ...preview, preview_data: { ...preview.preview_data,
    report_context: { intended_use: 'Old use', market_context: 'Retained market' },
    report_enrichment: { schemaVersion: 1, sections: [{ id: 'executive-summary', title: 'Executive summary', paragraphs: ['Saved server conclusion'], tables: [] }] },
  } };
  jest.mocked(salvageService.getPreview).mockResolvedValue(enriched);
  jest.mocked(salvageService.savePreview).mockImplementation(async (_id, data) => ({ ...enriched, revision: 3, preview_data: { ...data,
    report_enrichment: { schemaVersion: 1, sections: [{ id: 'executive-summary', title: 'Executive summary', paragraphs: ['Updated server conclusion'], tables: [] }] },
  } }));
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.getByText('Saved server conclusion')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Appraiser report notes' }));
  await fireEvent.changeText(screen.getByLabelText('Report notes: Intended use'), 'Auction review');
  expect(screen.getByText('Unsaved edits are not reflected below. Save to refresh the report review.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Save changes'));
  expect(salvageService.savePreview).toHaveBeenCalledWith('report-1', expect.objectContaining({
    report_context: { intended_use: 'Auction review', market_context: 'Retained market' },
    report_enrichment: enriched.preview_data!.report_enrichment,
  }), 2);
  expect(screen.getByText('Updated server conclusion')).toBeTruthy();
  expect(salvageService.research).not.toHaveBeenCalled();
  expect(salvageService.submit).not.toHaveBeenCalled();
});

it('edits saved preview data then submits only after saving with the returned revision', async () => {
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText('Vin'), 'USER-EDITED-VIN');
  await fireEvent.press(screen.getByText('Save & submit'));
  expect(salvageService.savePreview).toHaveBeenCalledWith(
    'report-1',
    expect.objectContaining({ vin: 'USER-EDITED-VIN' }),
    2
  );
  expect(salvageService.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      revision: 3,
      preview_data: expect.objectContaining({ vin: 'USER-EDITED-VIN' }),
    })
  );
  expect(screen.getByText('Generating report files')).toBeTruthy();
  expect(screen.queryByLabelText('Vin')).toBeNull();
});

it('saves photo-derived vehicle overrides before submitting and leaves evidence and photos unchanged', async () => {
  const inputs = {
    year: null, make: null, model: null, trim: null, powertrain: null, vin: null, odometer: null, odometerUnit: null,
    province: 'ON', market: 'Ottawa', effectiveDate: '2026-09-08', lossType: null, condition: null, damageDescription: null,
    documentedBrand: null, brandProvince: null, brandEvidenceRef: null, currency: 'CAD' as const, repairItems: [], labourItems: [], charges: [],
    sellerCosts: { fees: null, transport: null, storage: null, disposal: null }, suppliedComparables: [], suppliedReferences: [],
    overrides: { preLoss: null, asIs: null },
  };
  const conclusion = { amount: null, low: null, high: null, currency: 'CAD' as const, priceBasis: null,
    status: 'insufficient_evidence' as const, comparableIds: [], method: 'No evidence', referenceIds: [] };
  const assessment: SalvageAssessmentV2 = {
    schemaVersion: 2, generatedAt: '2026-09-08', stale: false, inputs, researchedInputs: inputs,
    photoFindings: [], candidates: [], comparables: [], references: [], limitations: [], research: {},
    valuations: { preLoss: conclusion, asIs: conclusion },
    repairs: { parts: [], labour: [], charges: [], partsTotal: null, labourTotal: null, chargesTotal: null, knownSubtotal: 0, total: null, status: 'incomplete' },
    netRecovery: { gross: null, deductions: inputs.sellerCosts, knownDeductions: 0, total: null, status: 'incomplete', formula: 'Gross less deductions' },
    vehicleDetails: { schemaVersion: 1, category: null, warnings: [], fields: [
      { key: 'vin', label: 'VIN', value: null, status: 'unknown', evidence: [], type: 'text', options: [], required: false, source: 'standard', manualOverride: null },
      { key: 'engineModel', label: 'Engine model', value: null, status: 'unknown', evidence: [], type: 'text', options: [], required: false, source: 'standard', manualOverride: null },
    ] },
  };
  const vehiclePreview = { ...preview, preview_data: { assessment, assessment_inputs: inputs } };
  jest.mocked(salvageService.getPreview).mockResolvedValue(vehiclePreview);
  jest.mocked(salvageService.savePreview).mockImplementation(async (_id, data) => ({ ...vehiclePreview, revision: 3, preview_data: data }));
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.getByLabelText('Vehicle VIN').props.placeholder).toBe('Cannot find from image');
  await fireEvent.changeText(screen.getByLabelText('Vehicle Engine model'), 'Appraiser verified model');
  await fireEvent.press(screen.getByText('Save & submit'));
  expect(salvageService.savePreview).toHaveBeenCalledWith('report-1', expect.objectContaining({
    assessment_inputs: expect.objectContaining({ vehicleOverrides: { engineModel: 'Appraiser verified model' } }),
  }), 2);
  expect(salvageService.submit).toHaveBeenCalledWith(expect.objectContaining({ revision: 3,
    preview_data: expect.objectContaining({ assessment_inputs: expect.objectContaining({ vehicleOverrides: { engineModel: 'Appraiser verified model' } }) }),
  }));
  expect(assessment.vehicleDetails?.fields[1].value).toBeNull();
  expect(vehiclePreview.imageUrls).toEqual(['https://assetinsight.pro/original.jpg']);
  expect(salvageService.research).not.toHaveBeenCalled();
});

it('preserves edits and blocks submission when another reviewer changed the revision', async () => {
  jest.mocked(salvageService.savePreview).mockRejectedValue({ response: { status: 409 } });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText('Vin'), 'MY-UNSAVED-VIN');
  await fireEvent.press(screen.getByText('Save & submit'));
  expect(screen.getByDisplayValue('MY-UNSAVED-VIN')).toBeTruthy();
  expect(screen.getByText(/This report changed elsewhere/)).toBeTruthy();
  expect(salvageService.submit).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Save & submit'));
  expect(salvageService.savePreview).toHaveBeenCalledTimes(1);
});

it('uses saved approved state to expose resubmit instead of an invalid initial submit', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue({ ...preview, status: 'approved' });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.press(screen.getByText('Save & resubmit'));
  expect(salvageService.submit).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'approved', revision: 2 })
  );
  expect(salvageService.savePreview).not.toHaveBeenCalled();
});

it('keeps source media and repair row values when a part is edited', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue({
    ...preview,
    preview_data: {
      ...preview.preview_data,
      imageUrls: preview.imageUrls,
      repair_items: [
        {
          name: 'Bumper',
          quantity: 1,
          unit_price: 300,
          vendor_link: 'https://example.test/part',
        },
      ],
    },
  });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.press(screen.getByText('Repair Items'));
  await fireEvent.changeText(screen.getByLabelText('Repair Items 1 Quantity'), '2');
  await fireEvent.press(screen.getByText('Save changes'));
  expect(salvageService.savePreview).toHaveBeenCalledWith(
    'report-1',
    expect.objectContaining({
      imageUrls: preview.imageUrls,
      repair_items: [
        expect.objectContaining({ quantity: '2', vendor_link: 'https://example.test/part' }),
      ],
    }),
    2
  );
});

it('never exposes download controls until the canonical download gate permits them', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue({
    ...preview,
    files_ready: true,
    downloadable: false,
    files: { pdf: 'a'.repeat(24) },
  });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.queryByText('Download PDF')).toBeNull();
  expect(screen.getByText(/Downloads remain subject to approval and release/)).toBeTruthy();
});

it('downloads approved files through the authenticated file-id transport', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue({
    ...preview,
    status: 'approved',
    downloadable: true,
    files: { pdf: 'a'.repeat(24) },
  });
  jest.mocked(downloadApprovedReportFile).mockResolvedValue({
    status: 200,
    uri: 'file:///cache/file.pdf',
    headers: {},
    mimeType: 'application/pdf',
  });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.press(screen.getByText('Download PDF'));
  expect(downloadApprovedReportFile).toHaveBeenCalledWith(
    'a'.repeat(24),
    expect.stringContaining('file:///cache/')
  );
});

it('retries a failed canonical report instead of creating a duplicate', async () => {
  jest
    .mocked(salvageService.getPreview)
    .mockResolvedValue({ ...preview, status: 'error', job_error: 'Analysis could not finish' });
  jest
    .mocked(salvageService.retry)
    .mockResolvedValue({ message: 'Accepted', data: { ...preview, status: 'processing' } });
  await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await fireEvent.press(screen.getByText('Retry processing'));
  expect(salvageService.retry).toHaveBeenCalledWith('report-1', 2);
  expect(screen.getByText('Preparing preview')).toBeTruthy();
});

it('stops background status polling after unmount', async () => {
  jest.useFakeTimers();
  jest.mocked(salvageService.getPreview).mockResolvedValue({ ...preview, status: 'processing' });
  const rendered = await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(salvageService.getPreview).toHaveBeenCalledTimes(2);
  await rendered.unmount();
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(salvageService.getPreview).toHaveBeenCalledTimes(2);
});

it('reconnects after repeated status failures without starting another report', async () => {
  jest.useFakeTimers();
  jest.mocked(salvageService.getPreview).mockResolvedValueOnce({ ...preview, status: 'processing' });
  const rendered = await render(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  jest.mocked(salvageService.getPreview).mockRejectedValue(new Error('offline'));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await act(async () => { jest.advanceTimersByTime(30000); });
  }
  expect(screen.getByText(/Connection interrupted/)).toBeTruthy();
  jest.mocked(salvageService.getPreview).mockResolvedValue(preview);
  const listener = jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];
  await act(async () => { listener({ isConnected: true, isInternetReachable: true } as any); });
  expect(screen.queryByLabelText('Vin')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Open preview'));
  expect(screen.getByLabelText('Vin')).toBeTruthy();
  expect(screen.queryByText(/Connection interrupted/)).toBeNull();
  expect(salvageService.retry).not.toHaveBeenCalled();
  expect(salvageService.submit).not.toHaveBeenCalled();
  await rendered.unmount();
});

it('opens assigned Salvage through the protected review endpoint without owner mutations', async () => {
  jest
    .mocked(assignedApprovalService.getPreview)
    .mockResolvedValue({ ...preview, status: 'pending_approval' });
  await render(<SalvagePreviewScreen reportId="pdf-record-42" onBack={jest.fn()} readOnly />);
  expect(assignedApprovalService.getPreview).toHaveBeenCalledWith('pdf-record-42');
  expect(salvageService.getPreview).not.toHaveBeenCalled();
  expect(screen.getByText(/Read-only assigned review/)).toBeTruthy();
  expect(screen.getByLabelText('Vin').props.editable).toBe(false);
  expect(screen.queryByText('Save & resubmit')).toBeNull();
  await fireEvent.press(screen.getByText('Repair Items'));
  expect(screen.queryByText('Add part')).toBeNull();
  expect(salvageService.savePreview).not.toHaveBeenCalled();
  expect(salvageService.submit).not.toHaveBeenCalled();
});

const running: SalvageReport = { ...preview, status: 'processing', revision: 2, generation_state: 'processing',
  workflow_stage: 'generating_files', files_generating: true, preview_available: true, can_cancel: true, job_id: 'job-first',
  workflow_message: 'Creating PDF from saved preview', workflow_progress_percent: 35, workflow_steps: [
    { key: 'photos', label: 'Uploaded photos saved', status: 'completed' },
    { key: 'files', label: 'Creating report files', status: 'active' },
  ],
};
const stoppedReport: SalvageReport = { ...preview, status: 'cancelled', generation_state: 'cancelled', revision: 3,
  workflow_stage: 'stopped', preview_available: true, can_cancel: false, job_id: 'job-first', files_generating: false,
};
async function confirmStop() {
  await fireEvent.press(screen.getByLabelText('Stop processing'));
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  await act(async () => { buttons?.find((button) => button.text === 'Stop processing')?.onPress?.(); });
}

it('shows status first and never opens a completed preview without an explicit tap', async () => {
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.queryByLabelText('Vin')).toBeNull();
  expect(screen.queryByText('Save & submit')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Open preview'));
  expect(screen.getByLabelText('Vin')).toBeTruthy();
  await fireEvent.press(screen.getByText('Close preview'));
  expect(screen.queryByLabelText('Vin')).toBeNull();
  expect(screen.getByLabelText('Open preview')).toBeTruthy();
});

it('waits for confirmed cancellation, edits and resubmits, then can stop the new job again', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let confirmCancellation!: (value: { data: SalvageReport }) => void;
  jest.mocked(salvageService.getPreview).mockResolvedValue(running);
  jest.mocked(salvageService.cancel).mockImplementationOnce(() => new Promise((resolve) => { confirmCancellation = resolve; }))
    .mockResolvedValueOnce({ data: { ...stoppedReport, revision: 6, job_id: 'job-second' } });
  jest.mocked(salvageService.savePreview).mockImplementation(async (_id, next) => ({ ...stoppedReport, revision: 4, preview_data: next }));
  jest.mocked(salvageService.submit).mockResolvedValue({ message: 'Accepted', data: { ...running, revision: 5, job_id: 'job-second' } });
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.getByText('Uploaded photos saved')).toBeTruthy();
  expect(screen.getByText('Creating report files')).toBeTruthy();
  await confirmStop();
  expect(salvageService.cancel).toHaveBeenCalledWith('report-1', 2, 'job-first');
  expect(screen.getByText('Stopping report processing…')).toBeTruthy();
  expect(screen.queryByLabelText('Open preview')).toBeNull();
  expect(screen.queryByLabelText('Vin')).toBeNull();
  await act(async () => { confirmCancellation({ data: stoppedReport }); });
  expect(screen.getByText('Processing stopped')).toBeTruthy();
  expect(screen.queryByLabelText('Vin')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Open preview'));
  await fireEvent.changeText(screen.getByLabelText('Vin'), 'EDITED-AFTER-STOP');
  await fireEvent.press(screen.getByText('Save & submit'));
  expect(salvageService.submit).toHaveBeenCalledWith(expect.objectContaining({ revision: 4, preview_data: expect.objectContaining({ vin: 'EDITED-AFTER-STOP' }) }));
  expect(screen.queryByLabelText('Vin')).toBeNull();
  expect(screen.getByText('Generating report files')).toBeTruthy();
  await confirmStop();
  expect(salvageService.cancel).toHaveBeenLastCalledWith('report-1', 5, 'job-second');
  expect(screen.getByText('Processing stopped')).toBeTruthy();
  expect(salvageService.research).not.toHaveBeenCalled();
});

it('does not invent a preview after an initial run was stopped before completing', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue({ ...stoppedReport, preview_available: false, preview_data: {} });
  jest.mocked(salvageService.retry).mockResolvedValue({ message: 'Accepted', data: { ...running, workflow_stage: 'preparing_preview', files_generating: false } });
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.queryByLabelText('Open preview')).toBeNull();
  await fireEvent.press(screen.getByText('Resume processing'));
  expect(salvageService.retry).toHaveBeenCalledWith('report-1', 3);
  expect(screen.getByText('Preparing preview')).toBeTruthy();
});

it('keeps editing closed after an uncertain or stale stop response', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(salvageService.getPreview).mockResolvedValue(running);
  jest.mocked(salvageService.cancel).mockRejectedValue({ response: { status: 409, data: { code: 'SALVAGE_GENERATION_CONFLICT', message: 'Another job is active.' } } });
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await confirmStop();
  expect(screen.getByText(/Stop not confirmed/)).toBeTruthy();
  expect(screen.queryByLabelText('Open preview')).toBeNull();
  expect(screen.queryByLabelText('Vin')).toBeNull();
  expect(salvageService.savePreview).not.toHaveBeenCalled();
  expect(salvageService.cancel).toHaveBeenCalledTimes(1);
});

it('ignores an older in-flight progress response after cancellation is confirmed', async () => {
  jest.useFakeTimers();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let oldPoll!: (value: SalvageReport) => void;
  jest.mocked(salvageService.getPreview).mockResolvedValueOnce(running).mockImplementationOnce(() => new Promise((resolve) => { oldPoll = resolve; }));
  jest.mocked(salvageService.cancel).mockResolvedValue({ data: stoppedReport });
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  await act(async () => { jest.advanceTimersByTime(3000); });
  await confirmStop();
  await act(async () => { oldPoll(running); });
  expect(screen.getByText('Processing stopped')).toBeTruthy();
  expect(screen.queryByText('Generating report files')).toBeNull();
  expect(screen.getByLabelText('Open preview')).toBeTruthy();
});

it('reopens the persisted stopped report without restarting work or opening the editor', async () => {
  jest.mocked(salvageService.getPreview).mockResolvedValue(stoppedReport);
  await renderNative(<SalvagePreviewScreen reportId="report-1" onBack={jest.fn()} />);
  expect(screen.getByText('Processing stopped')).toBeTruthy();
  expect(screen.getByLabelText('Open preview')).toBeTruthy();
  expect(screen.queryByLabelText('Vin')).toBeNull();
  expect(salvageService.retry).not.toHaveBeenCalled();
  expect(salvageService.cancel).not.toHaveBeenCalled();
});
