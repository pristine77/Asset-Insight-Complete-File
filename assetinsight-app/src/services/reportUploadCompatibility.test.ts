import api from './api';
import realEstateService, { type RealEstateDetails } from './realEstateService';
import salvageService, { type SalvageDetails } from './salvageService';
import { remainingImageSlots } from './reportUploadPolicy';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));

const photos = (count: number) => Array.from({ length: count }, (_, index) => ({ uri: `file:///photo-${index}.jpg`, name: `photo-${index}.jpg`, type: 'image/jpeg' }));
const getParts = () => (jest.mocked(api.post).mock.calls[0][1] as unknown as { getParts(): { fieldName: string; uri?: string; string?: string }[] }).getParts();
const originalFormData = global.FormData;
beforeAll(() => {
  // Native FormData preserves {uri,name,type}; Node's web FormData stringifies it.
  global.FormData = class {
    private parts: object[] = [];
    append(fieldName: string, value: string | object) {
      this.parts.push({ fieldName, ...(typeof value === 'string' ? { string: value } : value) });
    }
    getParts() { return this.parts; }
  } as unknown as typeof FormData;
});
afterAll(() => { global.FormData = originalFormData; });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.post).mockResolvedValue({ data: { jobId: 'accepted', phase: 'processing' } });
});

it('sends all 50 Real Estate main photos and 100 report-only photos, including a map', async () => {
  const map = { uri: 'file:///map.jpg', name: 'map.jpg', type: 'image/jpeg' };
  const details = { property_type: 'agricultural', farmland_details: { use_income_approach: true, market_rent_per_acre: 0, vacancy_loss_percent: 0, cap_rate: 4.5 } } as RealEstateDetails;
  await realEstateService.create(details, photos(50), map, undefined, photos(99));
  const parts = getParts();
  expect(parts.filter((part) => part.fieldName === 'images')).toHaveLength(50);
  expect(parts.filter((part) => part.fieldName === 'extraImages')).toHaveLength(100);
  expect(parts.find((part) => part.uri === map.uri)?.fieldName).toBe('extraImages');
  expect(parts.some((part) => part.fieldName === 'mapImage')).toBe(false);
  expect(parts[0].string).toBe(JSON.stringify(details));
  expect(api.post).toHaveBeenCalledWith('/real-estate', expect.anything(), expect.objectContaining({ timeout: 300_000 }));
});

it('rejects excess Real Estate photos before network submission rather than silently dropping any', async () => {
  await expect(realEstateService.create({} as RealEstateDetails, photos(51))).rejects.toThrow('up to 50');
  await expect(realEstateService.create({} as RealEstateDetails, photos(1), photos(1)[0], undefined, photos(100))).rejects.toThrow('up to 100');
  expect(api.post).not.toHaveBeenCalled();
});

it.each([0, 1, 30, 31, 49, 50])('uploads all %i Salvage images and rejects the fifty-first', async (count) => {
  await salvageService.create({} as SalvageDetails, photos(count));
  expect(getParts().filter((part) => part.fieldName === 'images').map((part) => part.uri)).toEqual(photos(count).map((photo) => photo.uri));
  expect(api.post).toHaveBeenCalledWith('/salvage', expect.anything(), expect.objectContaining({ timeout: 300_000 }));
  jest.clearAllMocks();
  await expect(salvageService.create({} as SalvageDetails, photos(51))).rejects.toThrow('up to 50');
  expect(api.post).not.toHaveBeenCalled();
});

it('does not treat a full picker as unlimited', () => {
  expect(remainingImageSlots(30, 30)).toBe(0);
  expect(remainingImageSlots(100, 100)).toBe(0);
  expect(remainingImageSlots(49, 50)).toBe(1);
});
