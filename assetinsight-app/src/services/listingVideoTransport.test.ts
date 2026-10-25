import api from './api';
import assetService, { type AssetCreateDetails } from './assetService';
import lotListingService, { type LotListingDetails } from './lotListingService';
import { uploadReportFilesDirectToR2 } from './directR2UploadService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./directR2UploadService', () => ({ uploadReportFilesDirectToR2: jest.fn() }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));

const video = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4', size: 8_000_000 };
const photo = (lot: number) => ({ uri: `file:///lot-${lot}.jpg`, name: `lot-${lot}.jpg`, type: 'image/jpeg', size: 500 });
const lots = [0, 1, 2].map(index => ({ id: `stable-lot-${index}`, lot_number: `${index + 157}`, files: [photo(index)],
  extraFiles: index === 1 ? [photo(10)] : [], coverIndex: 0, mode: 'single_lot' as const,
  ...(index === 1 ? { videoFile: video } : {}),
}));
const details = { contract_no: 'same-contract', client_submission_id: 'same-submission', grouping_mode: 'mixed' as const,
  client_name: 'Test client', appraisal_purpose: 'Test', effective_date: '2026-09-24', appraiser: 'Test appraiser', currency: 'CAD', language: 'en' as const,
  sales_date: '2026-09-24', location: 'Test yard',
  mixed_lots: lots.map(lot => ({ count: lot.files.length, extra_count: lot.extraFiles.length, cover_index: 0, mode: lot.mode })),
};
const originalFormData = global.FormData;
class TestFormData { parts: Array<[string, unknown]> = []; append(name: string, value: unknown) { this.parts.push([name, value]); } }
beforeAll(() => { global.FormData = TestFormData as unknown as typeof FormData; });
afterAll(() => { global.FormData = originalFormData; });
beforeEach(() => { jest.clearAllMocks(); jest.mocked(api.post).mockResolvedValue({ data: { reportId: 'report', jobId: 'job' } }); });

describe.each(['asset', 'lotListing'] as const)('%s camera video transport', kind => {
  const create = () => kind === 'asset'
    ? assetService.createAssetReport(details as AssetCreateDetails, lots)
    : lotListingService.createLotListing(details as LotListingDetails, lots);

  it('sends the original clip in its own video slot without counting it as an image', async () => {
    jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
    await create();
    const input = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0];
    expect(input.endpoint).toBe(kind === 'asset' ? '/asset' : '/lot-listing');
    expect(input.files.filter(file => file.role === 'video')).toEqual([expect.objectContaining({ ...video,
      fieldname: 'videos', role: 'video', lotIndex: 1, imageIndex: 0,
    })]);
    expect(input.files.filter(file => file.fieldname === 'images')).toHaveLength(4);
    expect(input.details.mixed_lots.map((lot: any) => lot.video_count)).toEqual([0, 1, 0]);
    expect(input.details.mixed_lots.map((lot: any) => lot.count)).toEqual([1, 1, 1]);
    expect(input.details.mixed_lots.map((lot: any) => lot.extra_count)).toEqual([0, 1, 0]);
    expect(details.mixed_lots[1]).not.toHaveProperty('video_count');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('preserves sparse video-to-lot mapping through legacy multipart fallback', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      jest.mocked(uploadReportFilesDirectToR2).mockRejectedValue({ response: { status: 404 } });
      await create();
      const form = jest.mocked(api.post).mock.calls[0][1] as TestFormData;
      const uploaded = JSON.parse(form.parts.find(([name]) => name === 'details')![1] as string);
      expect(uploaded.client_submission_id).toBe('same-submission');
      expect(uploaded.mixed_lots.map((lot: any) => lot.video_count)).toEqual([0, 1, 0]);
      expect(form.parts.filter(([name]) => name === 'videos')).toEqual([['videos', { uri: video.uri, name: video.name, type: video.type }]]);
      expect(form.parts.filter(([name]) => name === 'images')).toHaveLength(4);
    } finally { warning.mockRestore(); }
  });
});
