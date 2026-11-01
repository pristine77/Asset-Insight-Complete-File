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

/*
 * Owner, 2026-10-31: CAD and USD reports were not told apart reliably. The same
 * cases as assetinsight-client/lib/reportCurrency.test.ts, so the phone and the
 * website decide alike.
 */
it.each([
  ['Regina, SK', 'CAD'],
  ['Regina, SK S4P 3Y2', 'CAD'],
  ['2335 Lemieux Pl NW, Edmonton, AB T6R 0R6', 'CAD'],
  ['Box 12, Moose Jaw S6H 4N8', 'CAD'],
  ['Toronto, ON', 'CAD'],
  ['Brandon, Manitoba', 'CAD'],
  ['Charlottetown, Prince Edward Island', 'CAD'],
  ['Yellowknife, Northwest Territories', 'CAD'],
  ['Minot, ND 58701', 'USD'],
  ['Billings, MT', 'USD'],
  ['Sidney, Montana', 'USD'],
  ['Fargo, North Dakota 58102', 'USD'],
  ['Portland, OR 97201', 'USD'],
  ['Spokane, WA, 99201', 'USD'],
  ['Atlanta, GA 30301', 'USD'],
  ['Santa Fe, New Mexico', 'USD'],
  ['Ontario, California, United States', 'USD'],
  ['Belfast, Northern Ireland', 'GBP'],
  ['Dublin, Ireland', 'EUR'],
  ['Mexico City, Mexico', 'MXN'],
])('tells a Canadian from a US address: %s', (location, currency) => {
  expect(currencyForReportLocation(location)).toBe(currency);
});
it('chooses nothing when the address points both ways or nowhere', () => {
  expect(currencyForReportLocation('Ontario, California')).toBeNull();
  expect(currencyForReportLocation('Delaware, Ontario')).toBeNull();
  expect(currencyForReportLocation('Regina')).toBeNull();
  expect(currencyForReportLocation('Atlanta, Georgia')).toBeNull();
  expect(currencyForReportLocation('turn left on the gravel road')).toBeNull();
  expect(currencyForReportLocation('Regina, SK, Minot, ND')).toBeNull();
});

it.each([
  ['Canadian, Texas, United States', 'USD'], ['Canadian County, Oklahoma', 'USD'],
  ['Colombo, Sri Lanka', 'LKR'], ['Shanghai, China', 'CNY'], ['Singapore', 'SGD'],
  ['Dubai, United Arab Emirates', 'AED'], ['Johannesburg, South Africa', 'ZAR'],
  ['São Paulo, Brazil', 'BRL'], ['Luxembourg', 'EUR'], ['Cardiff, U.K.', 'GBP'], ['Great Britain', 'GBP'],
])('matches website country detection without treating Canadian as a country: %s', (location, currency) => {
  expect(currencyForReportLocation(location)).toBe(currency);
});
