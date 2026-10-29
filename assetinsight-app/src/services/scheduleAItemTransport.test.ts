import api from './api';
import assetService, { type AssetCreateDetails } from './assetService';
import lotListingService, { type LotListingDetails } from './lotListingService';
import { uploadReportFilesDirectToR2 } from './directR2UploadService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./directR2UploadService', () => ({ uploadReportFilesDirectToR2: jest.fn() }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));

// owner 2026-10-28: a lot on a Schedule A contract names the Schedule A item it
// belongs to (schedule_a_parent_lot_id) on every mixed_lots entry. Both upload
// services rebuild or copy mixed_lots, so each must keep that field for both
// the direct upload and the older multipart upload.
const photo = (lot: number) => ({ uri: `file:///lot-${lot}.jpg`, name: `lot-${lot}.jpg`, type: 'image/jpeg', size: 500 });
const lots = [0, 1].map(index => ({ id: `lot-${index}`, lot_number: index + 1, files: [photo(index)], extraFiles: [],
  coverIndex: 0, mode: 'single_lot' as const }));
const details = (withItem: boolean, workItem = true) => ({
  ...(workItem ? { auctioneer_work_item_id: 'work-next' } : {}),
  contract_no: '93530.3-A', client_submission_id: 'submission-next', grouping_mode: 'mixed' as const,
  client_name: 'Client', appraisal_purpose: 'Auction listing', effective_date: '2026-10-28', appraiser: 'Inspector',
  currency: 'CAD', language: 'en' as const, sales_date: '2026-10-28', location: 'Yard',
  mixed_lots: lots.map(lot => ({ count: lot.files.length, extra_count: 0, cover_index: 0, mode: lot.mode,
    ...(withItem ? { schedule_a_parent_lot_id: 'parent-lot-7' } : {}) })),
});
const originalFormData = global.FormData;
class TestFormData { parts: [string, unknown][] = []; append(name: string, value: unknown) { this.parts.push([name, value]); } }
beforeAll(() => { global.FormData = TestFormData as unknown as typeof FormData; });
afterAll(() => { global.FormData = originalFormData; });
beforeEach(() => { jest.clearAllMocks(); jest.mocked(api.post).mockResolvedValue({ data: { reportId: 'report', jobId: 'job' } }); });

describe.each(['asset', 'lotListing'] as const)('%s Schedule A item transport', kind => {
  const create = (input: ReturnType<typeof details>) => kind === 'asset'
    ? assetService.createAssetReport(input as AssetCreateDetails, lots)
    : lotListingService.createLotListing(input as LotListingDetails, lots);

  it('keeps the chosen Schedule A item on every lot of the direct upload', async () => {
    jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
    await create(details(true));
    const sent = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0].details;
    expect(sent.mixed_lots.map((lot: any) => lot.schedule_a_parent_lot_id)).toEqual(['parent-lot-7', 'parent-lot-7']);
  });

  it('keeps the chosen Schedule A item through the older multipart upload', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      jest.mocked(uploadReportFilesDirectToR2).mockRejectedValue({ response: { status: 404 } });
      await create(details(true));
      const form = jest.mocked(api.post).mock.calls[0][1] as unknown as TestFormData;
      const uploaded = JSON.parse(form.parts.find(([name]) => name === 'details')![1] as string);
      expect(uploaded.mixed_lots.map((lot: any) => lot.schedule_a_parent_lot_id)).toEqual(['parent-lot-7', 'parent-lot-7']);
    } finally { warning.mockRestore(); }
  });

  it('adds no Schedule A item field when none was chosen', async () => {
    jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
    await create(details(false));
    const sent = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0].details;
    sent.mixed_lots.forEach((lot: any) => expect(lot).not.toHaveProperty('schedule_a_parent_lot_id'));
  });
});

it('sends a Schedule A item from a Lot Listing only for Incoming work, like the other Auctioneer lot fields', async () => {
  jest.mocked(uploadReportFilesDirectToR2).mockResolvedValue({ reportId: 'report', jobId: 'job', message: 'Accepted' });
  await lotListingService.createLotListing(details(true, false) as LotListingDetails, lots);
  const sent = jest.mocked(uploadReportFilesDirectToR2).mock.calls[0][0].details;
  sent.mixed_lots.forEach((lot: any) => expect(lot).not.toHaveProperty('schedule_a_parent_lot_id'));
});
