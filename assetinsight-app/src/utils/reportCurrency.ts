import api from '../services/api';

export const REPORT_CURRENCIES = ['CAD', 'USD', 'GBP', 'EUR', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'INR', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'ZAR', 'AED', 'SAR', 'KRW'] as const;

export function normalizeReportCurrency(value: unknown): string | null {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try { new Intl.NumberFormat('en', { style: 'currency', currency: code }); return code; } catch { return null; }
}

/** Only explicit countries/provinces, never the phone's locale or an ambiguous city. */
export function currencyForReportLocation(location: unknown): string | null {
  const text = String(location || '');
  if (/\b(Canada|Canadian|Saskatchewan|Alberta|Ontario|Quebec|Québec|Manitoba|British Columbia|Nova Scotia|New Brunswick|Newfoundland|Prince Edward Island|Yukon|Nunavut|Northwest Territories)\b/i.test(text)) return 'CAD';
  if (/\b(United States|USA|U\.S\.A\.?|California|Texas|Florida|New York|New Mexico)\b/i.test(text)) return 'USD';
  if (/\b(United Kingdom|UK|Great Britain|England|Scotland|Wales|Northern Ireland)\b/i.test(text)) return 'GBP';
  if (/\b(Australia)\b/i.test(text)) return 'AUD';
  if (/\b(New Zealand)\b/i.test(text)) return 'NZD';
  if (/\b(France|Germany|Spain|Italy|Ireland|Portugal|Netherlands|Belgium|Austria|Finland|Greece)\b/i.test(text)) return 'EUR';
  if (/\b(Switzerland)\b/i.test(text)) return 'CHF';
  if (/\b(Japan)\b/i.test(text)) return 'JPY';
  if (/\b(India)\b/i.test(text)) return 'INR';
  if (/\b(Mexico)\b/i.test(text)) return 'MXN';
  return null;
}

export async function detectReportCurrency(location: unknown, latitude?: number, longitude?: number): Promise<string | null> {
  const namedCurrency = currencyForReportLocation(location);
  if (namedCurrency) return namedCurrency;
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  try {
    const response = await api.post('/location/reverse-geocode', { latitude, longitude }, { timeout: 8_000 });
    return normalizeReportCurrency(response.data?.data?.currency ?? response.data?.currency);
  } catch { return null; }
}
