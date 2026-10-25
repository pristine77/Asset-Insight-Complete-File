import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../context/ThemeContext';
import { invalidateAuthOperations } from '../../services/authSessionOperation';
import auctioneerDeliveryService, {
  type AuctioneerDeliverySummary,
} from '../../services/auctioneerDeliveryService';
import AuctioneerDeliveryAction from './AuctioneerDeliveryAction';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
let mockUser: { _id: string } | null = { _id: 'owner-a' };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../../services/auctioneerDeliveryService', () => {
  const actual = jest.requireActual('../../services/auctioneerDeliveryService');
  return {
    ...actual,
    __esModule: true,
    default: { getDelivery: jest.fn(), sendDelivery: jest.fn() },
  };
});

const ready: AuctioneerDeliverySummary = {
  workItemId: 'work-a',
  reportId: 'report-a',
  reportModel: 'LotListing',
  reportType: 'lotListing',
  contractId: 'contract-a',
  contractNo: '93530',
  accessRevision: 2,
  state: 'ready',
  canSend: true,
  canCompleteContract: true,
  contractCompletionScope: 'user',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mount(delivery = ready, onUpdated = jest.fn()) {
  const view = await render(
    <ThemeProvider>
      <AuctioneerDeliveryAction delivery={delivery} onUpdated={onUpdated} />
    </ThemeProvider>
  );
  return { ...view, onUpdated };
}
async function open(retry = false) {
  await fireEvent.press(
    screen.getByRole('button', { name: retry ? 'Retry Auctioneer delivery' : 'Send to Auctioneer' })
  );
}
async function confirm() {
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm send to Auctioneer' }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { _id: 'owner-a' };
  jest.mocked(auctioneerDeliveryService.getDelivery).mockResolvedValue(ready);
  jest
    .mocked(auctioneerDeliveryService.sendDelivery)
    .mockResolvedValue({ ...ready, state: 'queued', canSend: false });
});

it('requires explicit confirmation, refreshes the exact delivery and shows queued rather than sent', async () => {
  const view = await mount();
  expect(auctioneerDeliveryService.getDelivery).not.toHaveBeenCalled();
  await open();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  expect(
    screen.getByRole('checkbox', { name: 'Close my part after sending' }).props.accessibilityState
      .checked
  ).toBe(false);
  await confirm();
  expect(auctioneerDeliveryService.getDelivery).toHaveBeenCalledWith('work-a', ready);
  expect(auctioneerDeliveryService.sendDelivery).toHaveBeenCalledWith(ready, {
    destination: 'LottingBoard',
    completeContract: false,
  });
  const queued = { ...ready, state: 'queued' as const, canSend: false };
  expect(view.onUpdated).toHaveBeenCalledWith(queued);
  await view.rerender(
    <ThemeProvider>
      <AuctioneerDeliveryAction delivery={queued} onUpdated={view.onUpdated} />
    </ThemeProvider>
  );
  expect(screen.getByText('Auctioneer delivery queued. You can continue working.')).toBeTruthy();
  expect(screen.queryByText('Sent to Auctioneer.')).toBeNull();
});

it('Cancel never reads or sends a delivery', async () => {
  await mount();
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel Auctioneer delivery' }));
  expect(auctioneerDeliveryService.getDelivery).not.toHaveBeenCalled();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Confirm send to Auctioneer' })).toBeNull();
});

it('requires an Operations note and sends its trimmed content and explicit own-part close choice', async () => {
  await mount();
  await open();
  await fireEvent.press(screen.getByRole('radio', { name: 'Operations To-Do' }));
  await confirm();
  expect(screen.getByRole('alert').props.children).toBe(
    'Add an Operations To-Do note before sending.'
  );
  expect(auctioneerDeliveryService.getDelivery).not.toHaveBeenCalled();
  await fireEvent.changeText(
    screen.getByLabelText('Operations To-Do note'),
    '  Please photograph the serial tag.  '
  );
  await fireEvent.press(screen.getByRole('checkbox', { name: 'Close my part after sending' }));
  await confirm();
  expect(auctioneerDeliveryService.sendDelivery).toHaveBeenCalledWith(ready, {
    destination: 'OpToDoBoard',
    opTaskDescription: 'Please photograph the serial tag.',
    completeContract: true,
  });
});

it('bounds Operations notes and keeps close unavailable without server permission', async () => {
  await mount({ ...ready, canCompleteContract: false });
  await open();
  expect(screen.queryByRole('checkbox')).toBeNull();
  await fireEvent.press(screen.getByRole('radio', { name: 'Operations To-Do' }));
  expect(screen.getByLabelText('Operations To-Do note').props.maxLength).toBe(2000);
  await fireEvent.changeText(screen.getByLabelText('Operations To-Do note'), 'x'.repeat(2001));
  await confirm();
  expect(screen.getByText('Keep the Operations To-Do note within 2,000 characters.')).toBeTruthy();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
});

it.each(['not_ready', 'ready', 'failed'] as const)(
  'disables %s when the server does not allow sending',
  async (state) => {
    await mount({ ...ready, state, canSend: false });
    const button = screen.getByRole('button', {
      name: state === 'failed' ? 'Retry Auctioneer delivery' : 'Send to Auctioneer',
    });
    expect(button.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(button);
    expect(screen.queryByRole('button', { name: 'Confirm send to Auctioneer' })).toBeNull();
    expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  }
);

it.each(['queued', 'sending', 'sent', 'needs_reconciliation'] as const)(
  'does not offer a fresh send for %s',
  async (state) => {
    await mount({ ...ready, state, canSend: true });
    expect(screen.queryByRole('button', { name: 'Send to Auctioneer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry Auctioneer delivery' })).toBeNull();
    expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
    if (state === 'needs_reconciliation')
      expect(
        screen.getByText(/Open this report on the website to check and reconcile/)
      ).toBeTruthy();
  }
);

it('keeps the original failed delivery manifest and disables changing it', async () => {
  const failed: AuctioneerDeliverySummary = {
    ...ready,
    state: 'failed',
    destination: 'OpToDoBoard',
    opTaskDescription: 'Original note',
    completeContract: true,
  };
  jest.mocked(auctioneerDeliveryService.getDelivery).mockResolvedValue(failed);
  await mount(failed);
  await open(true);
  expect(
    screen.getByRole('radio', { name: 'Posting Board / Lien Tracker' }).props.accessibilityState
      .disabled
  ).toBe(true);
  expect(screen.getByLabelText('Operations To-Do note').props.editable).toBe(false);
  expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true);
  await confirm();
  expect(auctioneerDeliveryService.sendDelivery).toHaveBeenCalledWith(failed, {
    destination: 'OpToDoBoard',
    opTaskDescription: 'Original note',
    completeContract: true,
  });
});

it.each([
  { state: 'sent', canSend: false },
  { state: 'needs_reconciliation', canSend: false },
  { canSend: false },
  { accessRevision: 3 },
  { contractId: 'another-contract' },
  { reportId: 'another-report' },
  { reportModel: 'AssetReport', reportType: 'asset' },
] as const)('refuses a changed fresh delivery %# before any mutation', async (change) => {
  jest.mocked(auctioneerDeliveryService.getDelivery).mockResolvedValue({ ...ready, ...change });
  await mount();
  await open();
  await confirm();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  expect(screen.getByText(/This delivery has changed/)).toBeTruthy();
});

it('refuses changed retry settings and never creates another delivery', async () => {
  const failed: AuctioneerDeliverySummary = {
    ...ready,
    state: 'failed',
    destination: 'LottingBoard',
    completeContract: false,
  };
  jest
    .mocked(auctioneerDeliveryService.getDelivery)
    .mockResolvedValue({ ...failed, destination: 'OpToDoBoard', opTaskDescription: 'Changed' });
  await mount(failed);
  await open(true);
  await confirm();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  expect(screen.getByText(/This delivery has changed/)).toBeTruthy();
});

it('refuses a retry without its saved destination', async () => {
  await mount({ ...ready, state: 'failed' });
  await open(true);
  await confirm();
  expect(screen.getByText(/saved delivery destination is missing/)).toBeTruthy();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
});

it('refuses a retry without its explicit saved close choice', async () => {
  await mount({ ...ready, state: 'failed', destination: 'LottingBoard' });
  await open(true);
  await confirm();
  expect(screen.getByText(/saved delivery close choice is missing/)).toBeTruthy();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
});

it.each([
  {
    state: 'failed',
    destination: 'OpToDoBoard',
    opTaskDescription: 'Saved retry',
    completeContract: true,
  },
  { destination: 'OpToDoBoard' },
  { opTaskDescription: 'Changed server note' },
  { completeContract: true },
  { canCompleteContract: false },
  { contractCompletionScope: 'contract' },
] as const)(
  'invalidates an open confirmation when its displayed configuration changes %#',
  async (change) => {
    const view = await mount();
    await open();
    await view.rerender(
      <ThemeProvider>
        <AuctioneerDeliveryAction delivery={{ ...ready, ...change }} onUpdated={view.onUpdated} />
      </ThemeProvider>
    );
    expect(screen.queryByRole('button', { name: 'Confirm send to Auctioneer' })).toBeNull();
    expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  }
);

it('does not confirm an old modal after the same account starts a new authentication epoch', async () => {
  await mount();
  await open();
  invalidateAuthOperations();
  await confirm();
  expect(auctioneerDeliveryService.getDelivery).not.toHaveBeenCalled();
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
});

it.each([{ canCompleteContract: false }, { contractCompletionScope: 'contract' }] as const)(
  'refuses a fresh close-authority change %# even when the delivery is still ready',
  async (change) => {
    jest.mocked(auctioneerDeliveryService.getDelivery).mockResolvedValue({ ...ready, ...change });
    await mount();
    await open();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Close my part after sending' }));
    await confirm();
    expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
    expect(screen.getByText(/This delivery has changed/)).toBeTruthy();
  }
);

it('does not continue a pending preflight after a retry manifest arrives through refresh', async () => {
  const pending = deferred<AuctioneerDeliverySummary>();
  jest.mocked(auctioneerDeliveryService.getDelivery).mockReturnValue(pending.promise);
  const view = await mount();
  await open();
  await confirm();
  await view.rerender(
    <ThemeProvider>
      <AuctioneerDeliveryAction
        delivery={{
          ...ready,
          state: 'failed',
          destination: 'LottingBoard',
          completeContract: false,
        }}
        onUpdated={view.onUpdated}
      />
    </ThemeProvider>
  );
  await act(async () => pending.resolve(ready));
  expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
  expect(view.onUpdated).not.toHaveBeenCalled();
});

it('blocks duplicate confirmation and cannot cancel during a mutation', async () => {
  const pending = deferred<AuctioneerDeliverySummary>();
  jest.mocked(auctioneerDeliveryService.sendDelivery).mockReturnValue(pending.promise);
  await mount();
  await open();
  const button = screen.getByRole('button', { name: 'Confirm send to Auctioneer' });
  await fireEvent.press(button);
  await fireEvent.press(button);
  expect(auctioneerDeliveryService.getDelivery).toHaveBeenCalledTimes(1);
  expect(auctioneerDeliveryService.sendDelivery).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: 'Cancel Auctioneer delivery' }).props.accessibilityState
      .disabled
  ).toBe(true);
  await act(async () => pending.resolve({ ...ready, state: 'queued', canSend: false }));
});

it('shows safe conflict guidance instead of a status code or internal URL', async () => {
  jest
    .mocked(auctioneerDeliveryService.sendDelivery)
    .mockRejectedValue({
      response: { status: 409 },
      message: 'Request failed with status code 409 http://127.0.0.1/private',
    });
  await mount();
  await open();
  await confirm();
  expect(screen.getByText(/This delivery or contract has changed/)).toBeTruthy();
  expect(screen.queryByText(/status code|127\.0\.0\.1/)).toBeNull();
});

it('keeps the actual safe refusal reason visible', async () => {
  jest
    .mocked(auctioneerDeliveryService.sendDelivery)
    .mockRejectedValue({
      response: {
        status: 409,
        data: { message: 'This event is closed. No additional lots can be sent.' },
      },
    });
  await mount();
  await open();
  await confirm();
  expect(screen.getByText('This event is closed. No additional lots can be sent.')).toBeTruthy();
});

it.each(['epoch', 'owner', 'unmount'] as const)(
  'does not send after a preflight interrupted by %s',
  async (interruption) => {
    const pending = deferred<AuctioneerDeliverySummary>();
    jest.mocked(auctioneerDeliveryService.getDelivery).mockReturnValue(pending.promise);
    const view = await mount();
    await open();
    await confirm();
    if (interruption === 'epoch') invalidateAuthOperations();
    if (interruption === 'owner') {
      mockUser = { _id: 'owner-b' };
      await view.rerender(
        <ThemeProvider>
          <AuctioneerDeliveryAction delivery={ready} onUpdated={view.onUpdated} />
        </ThemeProvider>
      );
    }
    if (interruption === 'unmount') await view.unmount();
    await act(async () => pending.resolve(ready));
    expect(auctioneerDeliveryService.sendDelivery).not.toHaveBeenCalled();
    expect(view.onUpdated).not.toHaveBeenCalled();
  }
);

it.each(['epoch', 'owner', 'unmount'] as const)(
  'does not show a mutation result after %s',
  async (interruption) => {
    const pending = deferred<AuctioneerDeliverySummary>();
    jest.mocked(auctioneerDeliveryService.sendDelivery).mockReturnValue(pending.promise);
    const view = await mount();
    await open();
    await confirm();
    expect(auctioneerDeliveryService.sendDelivery).toHaveBeenCalledTimes(1);
    if (interruption === 'epoch') invalidateAuthOperations();
    if (interruption === 'owner') {
      mockUser = { _id: 'owner-b' };
      await view.rerender(
        <ThemeProvider>
          <AuctioneerDeliveryAction delivery={ready} onUpdated={view.onUpdated} />
        </ThemeProvider>
      );
    }
    if (interruption === 'unmount') await view.unmount();
    await act(async () => pending.resolve({ ...ready, state: 'queued', canSend: false }));
    expect(view.onUpdated).not.toHaveBeenCalled();
  }
);

it('does not offer sending without a signed-in owner', async () => {
  mockUser = null;
  await mount();
  expect(
    screen.getByRole('button', { name: 'Send to Auctioneer' }).props.accessibilityState.disabled
  ).toBe(true);
});
