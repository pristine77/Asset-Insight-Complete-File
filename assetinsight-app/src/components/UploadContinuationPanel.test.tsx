import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import UploadContinuationPanel from './UploadContinuationPanel';
import continuation from '../services/durableContinuationService';

let mockOwner = 'owner-a';
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: mockOwner } }) }));
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#444', accent: '#f00', surface: '#fff', borderStrong: '#aaa' } }) }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner, subscribeContinuations: () => () => undefined } }));
jest.mock('../services/durableContinuationService', () => ({ __esModule: true, default: { list: jest.fn(), complete: jest.fn() } }));
const row = () => ({ id: `intent-${mockOwner}`, ownerId: mockOwner, type: 'asset', stage: 'staged', parentSetup: { contract: { contractNo: mockOwner } } });
const result = (id = 'saved-child') => ({ draftId: id, setup: { workItemId: 'next' } });
beforeEach(() => {
  mockOwner = 'owner-a'; jest.clearAllMocks();
  jest.mocked(continuation.list).mockImplementation(async () => [row()] as any);
  jest.mocked(continuation.complete).mockResolvedValue(result() as any);
});
afterEach(cleanup);

it('shows a durable pending request without submitting or reserving on reopen, then explicitly opens its saved successor', async () => {
  const open = jest.fn(); await render(<UploadContinuationPanel onOpen={open} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-a' })).toBeTruthy());
  expect(continuation.complete).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-a' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('saved-child', 'asset', result().setup));
  expect(continuation.complete).toHaveBeenCalledTimes(1);
});

it('routes a confirmed unstaged request back to its original saved draft without submitting it', async () => {
  jest.mocked(continuation.complete).mockResolvedValue({ ...result('saved-parent'), parentNotStaged: true } as any);
  const open = jest.fn(); await render(<UploadContinuationPanel onOpen={open} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-a' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-a' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('saved-parent', 'asset', result().setup));
});

it('shows a read failure instead of a false empty list and retries without any reservation or upload', async () => {
  jest.mocked(continuation.list).mockRejectedValueOnce(new Error('SQLite read failed'));
  await render(<UploadContinuationPanel onOpen={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(/Continue requests could not be loaded/)).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading Continue requests' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-a' })).toBeTruthy());
  expect(screen.queryByText(/Continue requests could not be loaded/)).toBeNull();
  expect(continuation.complete).not.toHaveBeenCalled();
});

it('resets the owner gate while fencing late requests from unlocking a newer owner request', async () => {
  const pending: Array<(value: any) => void> = [];
  jest.mocked(continuation.complete).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  const open = jest.fn(), view = await render(<UploadContinuationPanel onOpen={open} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-a' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-a' }));
  mockOwner = 'owner-b'; await view.rerender(<UploadContinuationPanel onOpen={open} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-b' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-b' }));
  expect(continuation.complete).toHaveBeenCalledTimes(2);
  await act(async () => { pending[0](result('foreign-child')); });
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-b' }));
  expect(continuation.complete).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1](result('owner-b-child')); });
  expect(open).toHaveBeenCalledWith('owner-b-child', 'asset', result().setup);
});

it('does not navigate after the recovery screen unmounts during reservation', async () => {
  let finish!: (value: any) => void;
  jest.mocked(continuation.complete).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const open = jest.fn(), view = await render(<UploadContinuationPanel onOpen={open} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot for owner-a' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot for owner-a' }));
  await view.unmount(); await act(async () => { finish(result()); }); expect(open).not.toHaveBeenCalled();
});
