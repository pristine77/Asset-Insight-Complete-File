import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PreviewCurrencyConversion from './PreviewCurrencyConversion';
import api from '../services/api';
import { invalidateAuthOperations } from '../services/authSessionOperation';

jest.mock('../services/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
const preview = { currency: 'CAD', lots: [{ id: 'one', title: 'Saved lot', estimated_value: '100', image_indexes: [0] }] };
const converted = { ...preview, currency: 'USD', lots: [{ ...preview.lots[0], estimated_value: '70' }], currency_conversion: { signed: 'opaque' } };
const quote = { fromCurrency: 'CAD', toCurrency: 'USD', rate: .7, asOf: '2026-10-30', sourceUrl: 'https://example.test/rate', sourceTitle: 'Published exchange rate', quotedAt: '2026-10-30T10:00:00Z' };
const result = { data: { data: { preview_data: converted, quote } } };
const onBusyChange = jest.fn(), onPendingChange = jest.fn(), onConverted = jest.fn(), onSave = jest.fn();
const endpoint = '/asset/report/preview/currency-conversion';
const props = { endpoint, disabled: false, onBusyChange, onPendingChange, onConverted };
function Harness() {
  const [data, setData] = useState<Record<string, any>>(preview);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <>
    <PreviewCurrencyConversion previewData={data} endpoint={endpoint} disabled={false}
      onBusyChange={value => { onBusyChange(value); setBusy(value); }}
      onPendingChange={value => { onPendingChange(value); setPending(value); }}
      onConverted={value => { onConverted(value); setData(value); }} />
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save fixture" disabled={busy || pending !== null} onPress={() => onSave(data)}><Text>Save fixture</Text></TouchableOpacity>
  </>;
}
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(Alert, 'alert').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());
async function select(code: string) {
  await fireEvent.press(screen.getByRole('button', { name: 'Preview target currency' }));
  await fireEvent.press(screen.getByRole('radio', { name: code }));
}
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(finish => { resolve = finish; });
  return { promise, resolve };
}

it('automatically converts a selected currency and saves the exact confirmed snapshot and opaque receipt', async () => {
  jest.mocked(api.post).mockResolvedValue(result);
  await render(<Harness />);
  await select('USD');
  await screen.findByText('1 CAD = 0.7 USD · 2026-10-30');
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(endpoint, { targetCurrency: 'USD', preview_data: preview }, expect.objectContaining({ skipAuthRefreshReplay: true, timeout: 60000 }));
  expect(screen.getByRole('button', { name: 'Save fixture' })).toBeEnabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Save fixture' }));
  expect(onSave).toHaveBeenCalledWith(converted);
  expect(onPendingChange).toHaveBeenCalledWith('USD');
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
});

it('blocks Save while a selected currency is waiting for its quote', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  await render(<Harness />);
  await select('USD');
  expect(screen.getByRole('button', { name: 'Save fixture' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Save fixture' }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('Converting CAD amounts to USD. Save is unavailable until conversion is applied.')).toBeTruthy();
  await act(() => pending.resolve(result));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save fixture' })).toBeEnabled());
});

it('keeps Save blocked after a failed lookup and allows cancelling to the current currency', async () => {
  jest.mocked(api.post).mockRejectedValue({ response: { status: 409 } });
  await render(<Harness />);
  await select('USD');
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Currency conversion unavailable', expect.stringContaining('Reload')));
  expect(onConverted).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save fixture' })).toBeDisabled();
  expect(screen.getByText('USD is selected, but the report is still CAD. Retry conversion before saving, or select CAD to keep the current amounts.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Save fixture' }));
  expect(onSave).not.toHaveBeenCalled();
  await select('CAD');
  expect(screen.getByRole('button', { name: 'Save fixture' })).toBeEnabled();
  expect(api.post).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Save fixture' }));
  expect(onSave).toHaveBeenCalledWith(preview);
});

it('retries a failed conversion without losing its selected target or the source values', async () => {
  jest.mocked(api.post).mockRejectedValueOnce(new Error('Rate unavailable')).mockResolvedValueOnce(result);
  await render(<Harness />);
  await select('USD');
  await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Preview target currency' })).toHaveAccessibilityValue({ text: 'USD' });
  await fireEvent.press(screen.getByRole('button', { name: 'Convert report currency' }));
  await screen.findByText('1 CAD = 0.7 USD · 2026-10-30');
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(onConverted).toHaveBeenCalledTimes(1);
  expect(onConverted).toHaveBeenCalledWith(converted);
});

it('does not clear pending Save until the parent acknowledges the exact converted preview', async () => {
  jest.mocked(api.post).mockResolvedValue(result);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD');
  await waitFor(() => expect(onConverted).toHaveBeenCalledWith(converted));
  expect(onPendingChange).toHaveBeenLastCalledWith('USD');
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={converted} />);
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
  expect(screen.getByText('1 CAD = 0.7 USD · 2026-10-30')).toBeTruthy();
});

it('keeps newer edits when an older conversion completes and retains the pending target for retry', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD');
  const newer = { ...preview, client_name: 'Newer edit' };
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={newer} />);
  await act(() => pending.resolve(result));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('Preview changed', expect.any(String));
  expect(onPendingChange).toHaveBeenLastCalledWith('USD');
});

it('ignores an old conversion after switching reports and returning to the first report', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD');
  await view.rerender(<PreviewCurrencyConversion {...props} endpoint="/asset/other/preview/currency-conversion" previewData={preview} />);
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await act(() => pending.resolve(result));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Preview target currency' })).toHaveAccessibilityValue({ text: 'CAD' });
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
});

it('ignores an old conversion after a source-currency ABA change', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD');
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={{ ...preview, currency: 'EUR' }} />);
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await act(() => pending.resolve(result));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
});

it('ignores a response after the account changes and returns, resetting the previous selection', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD');
  invalidateAuthOperations(); invalidateAuthOperations();
  await view.rerender(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await act(() => pending.resolve(result));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Preview target currency' })).toHaveAccessibilityValue({ text: 'CAD' });
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
});

it('does not apply a conversion after the preview is closed', async () => {
  const pending = deferred(); jest.mocked(api.post).mockReturnValue(pending.promise);
  const view = await render(<PreviewCurrencyConversion {...props} previewData={preview} />);
  await select('USD'); await view.unmount();
  const callbackCount = onPendingChange.mock.calls.length;
  await act(() => pending.resolve(result));
  expect(onConverted).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(onPendingChange).toHaveBeenCalledTimes(callbackCount);
});

it('rejects a malformed quote instead of allowing a relabelled Save', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { preview_data: converted, quote: { ...quote, toCurrency: 'EUR' } } } });
  await render(<Harness />);
  await select('USD');
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Currency conversion unavailable', expect.stringContaining('confirmed conversion')));
  expect(onConverted).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save fixture' })).toBeDisabled();
});
