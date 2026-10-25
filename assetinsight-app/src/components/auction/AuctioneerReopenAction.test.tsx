import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../context/ThemeContext';
import AuctioneerReopenAction from './AuctioneerReopenAction';
import auctioneerService from '../../services/auctioneerService';
import { invalidateAuthOperations } from '../../services/authSessionOperation';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../services/auctioneerService', () => ({
  __esModule: true,
  default: { getCapturePermission: jest.fn() },
}));

const permitted = {
  reopen: { allowed: true, reason: null, reopenUntil: '2026-10-27T15:00:00.000Z' },
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValue(permitted);
});

it('expires an allowed button and requires an explicit fresh permission check', async () => {
  jest.useFakeTimers();
  try {
    const reopen = jest.fn();
    await render(
      <ThemeProvider>
        <AuctioneerReopenAction
          contractId="contract"
          contractNo="93530"
          busy={false}
          blocked={false}
          onReopen={reopen}
        />
      </ThemeProvider>
    );
    expect(await screen.findByRole('button', { name: 'Re-Open contract 93530' })).toBeTruthy();
    expect(screen.getByText('Re-open until Oct 27, 9:00 a.m. Saskatchewan time')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(30_001));
    expect(screen.queryByRole('button', { name: 'Re-Open contract 93530' })).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check Re-Open availability contract 93530' })
    );
    expect(await screen.findByRole('button', { name: 'Re-Open contract 93530' })).toBeTruthy();
    expect(auctioneerService.getCapturePermission).toHaveBeenCalledTimes(2);
    expect(reopen).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('does not render permission arriving after the authentication epoch changed', async () => {
  let finish!: (value: any) => void;
  jest.mocked(auctioneerService.getCapturePermission).mockReturnValue(
    new Promise((done) => {
      finish = done;
    })
  );
  await render(
    <ThemeProvider>
      <AuctioneerReopenAction
        contractId="contract"
        contractNo="93530"
        busy={false}
        blocked={false}
        onReopen={jest.fn()}
      />
    </ThemeProvider>
  );
  invalidateAuthOperations();
  await act(async () => finish(permitted));
  expect(screen.queryByRole('button', { name: 'Re-Open contract 93530' })).toBeNull();
});

it('never presents a new Re-Open for a locally uncertain outcome without server confirmationPending', async () => {
  await render(
    <ThemeProvider>
      <AuctioneerReopenAction
        contractId="contract"
        contractNo="93530"
        busy={false}
        blocked
        onReopen={jest.fn()}
      />
    </ThemeProvider>
  );
  await act(async () => Promise.resolve());
  expect(screen.queryByRole('button', { name: 'Re-Open contract 93530' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check Re-Open contract 93530' })).toBeNull();
});
