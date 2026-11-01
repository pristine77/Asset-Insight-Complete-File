import { act, renderHook, waitFor } from '@testing-library/react-native';
import useReportCurrency from './useReportCurrency';
import { currencyForReportLocation, detectReportCurrency } from '../../utils/reportCurrency';
import { invalidateAuthOperations } from '../../services/authSessionOperation';
jest.mock('../../utils/reportCurrency', () => ({ currencyForReportLocation: jest.fn(), detectReportCurrency: jest.fn(), normalizeReportCurrency: (v: unknown) => typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null }));
beforeEach(() => { jest.clearAllMocks(); jest.mocked(currencyForReportLocation).mockReturnValue(null); jest.mocked(detectReportCurrency).mockResolvedValue('GBP'); });

it('starts blank and requires a choice when location detection is unavailable', async () => {
  jest.mocked(detectReportCurrency).mockResolvedValue(null);
  const { result } = await renderHook(() => useReportCurrency({ visible: true }));
  await waitFor(() => expect(result.current.detecting).toBe(false));
  expect(result.current.currency).toBe('');
  expect(result.current.currencyForSubmission()).toBeNull();
});
it('blocks submission while a lookup is pending and uses its confirmed currency afterward', async () => {
  let finish!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = await renderHook(() => useReportCurrency({ visible: true, latitude: 47, longitude: -103 }));
  expect(result.current.currency).toBe(''); expect(result.current.detecting).toBe(true);
  expect(result.current.currencyForSubmission()).toBeNull();
  await act(() => finish('USD'));
  expect(result.current.currencyForSubmission()).toBe('USD');
});
it('resolves a known address synchronously without a reverse-geocode request', async () => {
  jest.mocked(currencyForReportLocation).mockReturnValue('USD');
  const { result } = await renderHook(() => useReportCurrency({ visible: true, location: 'Minot, ND 58701' }));
  expect(result.current.currency).toBe('USD'); expect(result.current.detecting).toBe(false);
  expect(result.current.currencyForSubmission()).toBe('USD'); expect(detectReportCurrency).not.toHaveBeenCalled();
});
it('preserves manual overrides against late responses', async () => {
  let finish!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = await renderHook(() => useReportCurrency({ visible: true }));
  await act(() => result.current.setCurrency('USD')); await act(() => finish('GBP'));
  expect(result.current.currency).toBe('USD'); expect(result.current.detecting).toBe(false);
});
it('keeps restored currencies and does not look them up again', async () => {
  const { result } = await renderHook(() => useReportCurrency({ visible: true, initialCurrency: 'CAD', location: 'United Kingdom' }));
  expect(result.current.currency).toBe('CAD'); expect(detectReportCurrency).not.toHaveBeenCalled();
});
it('clears an automatic value immediately when a new location cannot be resolved', async () => {
  jest.mocked(detectReportCurrency).mockResolvedValueOnce('USD').mockResolvedValueOnce(null);
  const { result, rerender } = await renderHook(({ location }: { location: string }) => useReportCurrency({ visible: true, location }), { initialProps: { location: 'US yard' } });
  await waitFor(() => expect(result.current.currency).toBe('USD'));
  await rerender({ location: 'Unknown yard' });
  expect(result.current.currencyForSubmission()).toBeNull();
  await waitFor(() => expect(result.current.detecting).toBe(false)); expect(result.current.currency).toBe('');
});
it('ignores an old response after a location ABA change', async () => {
  let first!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValueOnce(new Promise(resolve => { first = resolve; })).mockResolvedValueOnce('USD').mockResolvedValueOnce('CAD');
  const { result, rerender } = await renderHook(({ location }: { location: string }) => useReportCurrency({ visible: true, location }), { initialProps: { location: 'A' } });
  await rerender({ location: 'B' }); await rerender({ location: 'A' });
  await waitFor(() => expect(result.current.currency).toBe('CAD')); await act(() => first('GBP'));
  expect(result.current.currency).toBe('CAD');
});
it('an explicit clear cancels an outstanding lookup without restoring an old automatic value', async () => {
  let finish!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = await renderHook(() => useReportCurrency({ visible: true }));
  await act(() => result.current.setCurrency('')); await act(() => finish('USD'));
  expect(result.current.currency).toBe(''); expect(result.current.currencyForSubmission()).toBeNull(); expect(result.current.detecting).toBe(false);
});
it('pauses detection until a draft is restored and retains its explicit currency on resume', async () => {
  const { result, rerender } = await renderHook(({ paused }: { paused: boolean }) => useReportCurrency({ visible: true, paused }), { initialProps: { paused: true } });
  expect(detectReportCurrency).not.toHaveBeenCalled(); await act(() => result.current.setCurrency('USD'));
  await rerender({ paused: false }); expect(result.current.currency).toBe('USD'); expect(detectReportCurrency).not.toHaveBeenCalled();
});
it('starts in the sale currency and keeps it through reset, with no unknown CAD fallback', async () => {
  const { result } = await renderHook(() => useReportCurrency({ visible: true, initialCurrency: 'USD', location: 'Regina, Saskatchewan' }));
  await act(() => result.current.resetCurrency('USD')); expect(result.current.currency).toBe('USD'); expect(detectReportCurrency).not.toHaveBeenCalled();
  jest.mocked(detectReportCurrency).mockResolvedValue(null); await act(() => result.current.resetCurrency());
  await waitFor(() => expect(result.current.detecting).toBe(false)); expect(result.current.currency).toBe('');
});
it('rejects late account responses and prevents a captured handler from using a previous account currency', async () => {
  let finish!: (v: string) => void;
  jest.mocked(detectReportCurrency).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = await renderHook(() => useReportCurrency({ visible: true }));
  await act(() => result.current.setCurrency('USD')); const read = result.current.currencyForSubmission;
  invalidateAuthOperations(); invalidateAuthOperations(); expect(read()).toBeNull();
  await act(() => result.current.setCurrency('CAD')); expect(read()).toBeNull();
  jest.mocked(detectReportCurrency).mockResolvedValue(null); await rerender(undefined); await act(() => finish('GBP'));
  await waitFor(() => expect(result.current.detecting).toBe(false)); expect(result.current.currency).toBe('');
});
