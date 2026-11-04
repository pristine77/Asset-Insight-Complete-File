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


describe.each(['asset', 'lotListing'] as const)('%s saved capture numbering', kind => {
  const send = (payload: any, savedLots: typeof lots) => kind === 'asset'
    ? assetService.createAssetReport(payload, savedLots)
    : lotListingService.createLotListing(payload, savedLots);
  it.each([false, true])('preserves saved labels and exact photo group identity (multipart=%s)', async fallback => {
    const savedLots = lots.map((lot, index) => ({ ...lot, lotNumber: ['157', '999', '40A'][index] }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      if (fallback) jest.mocked(uploadReportFilesDirectToR2).mockRejectedValue({ response: { status: 404 } });
      else jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
      await send(details, savedLots);
      const input = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0];
      const actual = fallback ? JSON.parse((jest.mocked(api.post).mock.calls[0][1] as TestFormData).parts.find(([key]) => key === 'details')![1] as string) : input.details;
      expect(actual.mixed_lots.map((lot: any) => [lot.capture_lot_id, lot.capture_lot_number])).toEqual([
        ['stable-lot-0', '157'], ['stable-lot-1', '999'], ['stable-lot-2', '40A'],
      ]);
      expect(input.files.filter(file => file.role === 'main').map(file => [file.name, file.lotIndex])).toEqual([
        ['lot-0.jpg', 0], ['lot-1.jpg', 1], ['lot-2.jpg', 2],
      ]);
    } finally { warn.mockRestore(); }
  });
  it('preserves a frozen retry label rather than renumbering it', async () => {
    jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
    await send({ ...details, mixed_lots: details.mixed_lots.map((lot, index) => ({ ...lot, capture_lot_id: `snapshot-${index}`, capture_lot_number: `42.${index}` })) }, lots);
    expect(jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0].details.mixed_lots[0]).toMatchObject({ capture_lot_id: 'snapshot-0', capture_lot_number: '42.0' });
  });
  it('leaves Auctioneer-assigned numbering authoritative', async () => {
    jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
    await send({ ...details, auctioneer_work_item_id: 'work' }, lots);
    expect(jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0].details.mixed_lots[0]).not.toHaveProperty('capture_lot_id');
  });
  it('refuses arrival capture metadata before any ordinary transport', async () => {
    await expect(send({ ...details, capturePurpose: 'arrivalPhotos' }, lots)).rejects.toThrow('Arrival Photos');
    expect(uploadReportFilesDirectToR2).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
