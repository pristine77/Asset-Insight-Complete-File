import api from './api';
import { assetService, type AssetCreateDetails } from './assetService';
import { lotListingService, type LotListingDetails } from './lotListingService';
import assignedApprovalService from './assignedApprovalService';
import { uploadReportFilesDirectToR2 } from './directR2UploadService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), put: jest.fn() } }));
jest.mock('./directR2UploadService', () => ({ uploadReportFilesDirectToR2: jest.fn() }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: jest.fn() }));

const capture = { uri: 'content://media/external/images/123', name: 'capture.jpg', type: 'image/jpeg' };
const extra = { uri: 'file:///report-only.jpg', name: 'report-only.jpg', type: 'image/jpeg' };
const lots = [{ id: 'lot-1', lot_number: '157', files: [capture], extraFiles: [extra], coverIndex: 0 }];
const savedFormData = global.FormData;
beforeAll(() => {
  global.FormData = class {
    parts: [string, unknown][] = [];
    append(name: string, value: unknown) { this.parts.push([name, value]); }
  } as unknown as typeof FormData;
});
afterAll(() => { global.FormData = savedFormData; });
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ jobId: 'same-job', reportId: 'report-1', message: 'Accepted' });
  jest.mocked(api.post).mockResolvedValue({ data: { jobId: 'same-job' } });
  jest.mocked(api.put).mockResolvedValue({ data: {} });
});

describe.each(['asset', 'lotListing'] as const)('%s mobile watermark transport', (kind) => {
  const create = (details: object) => kind === 'asset'
    ? assetService.createAssetReport(details as AssetCreateDetails, lots)
    : lotListingService.createLotListing(details as LotListingDetails, lots);

  it.each([undefined, false, true])('sends an explicit %s preference and unchanged original URIs', async (choice) => {
    const details = { contract_no: 'TEST', watermark_images: choice };
    await create(details);
    const sent = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0];
    expect(sent.details.watermark_images).toBe(choice === true);
    expect(sent.files.map(file => file.uri)).toEqual([capture.uri, extra.uri]);
    expect(sent.files.map(file => file.role)).toEqual(['main', 'extra']);
    expect(details.watermark_images).toBe(choice);
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([undefined, true])('preserves %s policy and original files during legacy multipart fallback', async (choice) => {
    jest.mocked(uploadReportFilesDirectToR2).mockRejectedValue({ response: { status: 404 } });
    await create({ contract_no: 'TEST', watermark_images: choice });
    const form = jest.mocked(api.post).mock.calls[0][1] as { parts: [string, unknown][] };
    expect(JSON.parse(form.parts[0][1] as string).watermark_images).toBe(choice === true);
    expect(form.parts.slice(1).map(([, file]) => (file as { uri: string }).uri)).toEqual([capture.uri, extra.uri]);
  });
});

it('saves and submits existing photo URLs as JSON, without another image upload', async () => {
  const preview = { watermark_images: true, lots: [{ lot_number: '157', description: 'Edited condition',
    image_urls: ['https://assetinsight.pro/saved-photo.jpg'], extra_image_urls: [] }] };
  await assetService.updatePreviewData('report-1', preview);
  await assetService.submitPreview('report-1', preview);
  await assignedApprovalService.updatePreview('report-1', preview);
  await assignedApprovalService.resubmit('report-1', preview);
  for (const [, body] of [...jest.mocked(api.post).mock.calls, ...jest.mocked(api.put).mock.calls]) {
    expect(body).toEqual({ preview_data: preview });
  }
  expect(uploadReportFilesDirectToR2).not.toHaveBeenCalled();
});
