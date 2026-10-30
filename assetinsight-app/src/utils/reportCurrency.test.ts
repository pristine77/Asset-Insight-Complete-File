import api from '../services/api';
import { currencyForReportLocation, detectReportCurrency } from './reportCurrency';
jest.mock('../services/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
beforeEach(() => jest.clearAllMocks());
it.each([['London, Ontario, Canada', 'CAD'], ['Los Angeles, California, United States', 'USD'], ['Manchester, England', 'GBP'], ['Paris, France', 'EUR'], ['Sydney, Australia', 'AUD'], ['London', null], ['Current Browser Location', null]])('detects a report location without guessing from the device locale: %s', (location, currency) => {
  expect(currencyForReportLocation(location)).toBe(currency);
});
it('uses report coordinates through the existing location endpoint', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { currency: 'GBP' } } });
  await expect(detectReportCurrency('Current Browser Location', 51.5, -.1)).resolves.toBe('GBP');
  expect(api.post).toHaveBeenCalledWith('/location/reverse-geocode', { latitude: 51.5, longitude: -.1 }, { timeout: 8000 });
});
it('does not request a lookup for absent coordinates, and tolerates offline failures', async () => {
  await expect(detectReportCurrency('Not provided')).resolves.toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  jest.mocked(api.post).mockRejectedValue(new Error('offline'));
  await expect(detectReportCurrency('Current Browser Location', 51.5, -.1)).resolves.toBeNull();
});
