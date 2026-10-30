import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PreviewCurrencyConversion from './PreviewCurrencyConversion';
import api from '../services/api';
import { invalidateAuthOperations } from '../services/authSessionOperation';
jest.mock('../services/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
const preview = { currency: 'CAD', lots: [{ id: 'one', title: 'Saved lot', estimated_value: '100', image_indexes: [0] }] };
const converted = { ...preview, currency: 'USD', lots: [{ ...preview.lots[0], estimated_value: '70' }], currency_conversion: { signed: 'opaque' } };
const quote = { fromCurrency: 'CAD', toCurrency: 'USD', rate: .7, asOf: '2026-10-30', sourceUrl: 'https://example.test/rate', sourceTitle: 'Published exchange rate', quotedAt: '2026-10-30T10:00:00Z' };
const onBusyChange = jest.fn(), onConverted = jest.fn();
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(Alert, 'alert').mockImplementation(() => undefined); });
async function selectUSD() { await fireEvent.press(screen.getByRole('button', { name: 'Preview target currency' })); await fireEvent.press(screen.getByRole('radio', { name: 'USD' })); }
it('converts only on explicit request and retains the opaque receipt for Save', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { preview_data: converted, quote } } });
  await render(<PreviewCurrencyConversion previewData={preview} endpoint="/asset/report/preview/currency-conversion" disabled={false} onBusyChange={onBusyChange} onConverted={onConverted} />);
  await selectUSD(); expect(api.post).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  await waitFor(() => expect(onConverted).toHaveBeenCalledWith(converted));
  expect(api.post).toHaveBeenCalledWith('/asset/report/preview/currency-conversion', { targetCurrency: 'USD', preview_data: preview }, expect.objectContaining({ skipAuthRefreshReplay: true, timeout: 60000 }));
  expect(screen.getByText('1 CAD = 0.7 USD · 2026-10-30')).toBeTruthy();
});
it('keeps newer edits when an older conversion completes', async () => {
  let finish!: (value: unknown) => void;
  jest.mocked(api.post).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const props = { endpoint: '/asset/report/preview/currency-conversion', disabled: false, onBusyChange, onConverted };
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await selectUSD(); await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={{ ...preview, client_name: 'Newer edit' }} />);
  await act(() => finish({ data: { data: { preview_data: converted, quote } } }));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('Preview changed', expect.any(String));
});
it('shows stale-report guidance without changing values or replaying the request', async () => {
  jest.mocked(api.post).mockRejectedValue({ response: { status: 409 } });
  await render(<PreviewCurrencyConversion previewData={preview} endpoint="/lot-listing/report/preview/currency-conversion" disabled={false} onBusyChange={onBusyChange} onConverted={onConverted} />);
  await selectUSD(); await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Currency conversion unavailable', expect.stringContaining('Reload')));
  expect(onConverted).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
});
it('ignores a response after the signed-in account session changes', async () => {
  let finish!: (value: unknown) => void;
  jest.mocked(api.post).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(<PreviewCurrencyConversion previewData={preview} endpoint="/asset/report/preview/currency-conversion" disabled={false} onBusyChange={onBusyChange} onConverted={onConverted} />);
  await selectUSD(); await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  invalidateAuthOperations();
  await act(() => finish({ data: { data: { preview_data: converted, quote } } }));
  expect(onConverted).not.toHaveBeenCalled(); expect(Alert.alert).not.toHaveBeenCalled();
});
it('rejects a malformed quote instead of relabeling values', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { preview_data: converted, quote: { ...quote, toCurrency: 'EUR' } } } });
  await render(<PreviewCurrencyConversion previewData={preview} endpoint="/asset/report/preview/currency-conversion" disabled={false} onBusyChange={onBusyChange} onConverted={onConverted} />);
  await selectUSD(); await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Currency conversion unavailable', expect.stringContaining('confirmed conversion')));
  expect(onConverted).not.toHaveBeenCalled();
});
