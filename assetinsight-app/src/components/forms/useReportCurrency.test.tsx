import { act, renderHook, waitFor } from '@testing-library/react-native';
import useReportCurrency from './useReportCurrency';
import { detectReportCurrency } from '../../utils/reportCurrency';
jest.mock('../../utils/reportCurrency', () => ({ detectReportCurrency: jest.fn(), normalizeReportCurrency: (v: unknown) => typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null }));
beforeEach(() => { jest.clearAllMocks(); jest.mocked(detectReportCurrency).mockResolvedValue('GBP'); });
it('detects from the inspection location and preserves manual overrides against late responses', async () => {
  let finish!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = await renderHook(() => useReportCurrency({ visible: true, location: 'United Kingdom' }));
  await act(() => result.current.setCurrency('USD'));
  await act(() => finish('GBP'));
  expect(result.current.currency).toBe('USD');
  expect(result.current.detecting).toBe(false);
});
it('keeps restored currencies and does not look them up again', async () => {
  const { result } = await renderHook(() => useReportCurrency({ visible: true, initialCurrency: 'CAD', location: 'United Kingdom' }));
  expect(result.current.currency).toBe('CAD');
  expect(detectReportCurrency).not.toHaveBeenCalled();
});
it('ignores a superseded report location response', async () => {
  let first!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValueOnce(new Promise(resolve => { first = resolve; })).mockResolvedValueOnce('USD');
  const { result, rerender } = await renderHook(({ location }: { location: string }) => useReportCurrency({ visible: true, location }), { initialProps: { location: 'UK' } });
  await rerender({ location: 'USA' });
  await waitFor(() => expect(result.current.currency).toBe('USD'));
  await act(() => first('GBP'));
  expect(result.current.currency).toBe('USD');
});
it('starts in the sale currency and keeps it through a form reset (owner, 2026-10-31)', async () => {
  const { result } = await renderHook(() => useReportCurrency({ visible: true, initialCurrency: 'USD', location: 'Regina, Saskatchewan' }));
  expect(result.current.currency).toBe('USD');
  await act(() => result.current.resetCurrency('USD'));
  expect(result.current.currency).toBe('USD');
  expect(detectReportCurrency).not.toHaveBeenCalled();
  await act(() => result.current.resetCurrency());
  await waitFor(() => expect(result.current.currency).toBe('GBP'));
});
