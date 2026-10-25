import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../context/ThemeContext';
import api from '../../services/api';
import type { AuctioneerDeliverySummary } from '../../services/auctioneerDeliveryService';
import AuctioneerDeliveryAction from './AuctioneerDeliveryAction';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { _id: 'owner-a' } }),
}));
// The component and delivery service are real; only the protected API boundary is simulated.
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

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
const envelope = (data: unknown) => ({ data: { success: true, data } });

function ReportsCard({ onUpdated }: { onUpdated: (value: AuctioneerDeliverySummary) => void }) {
  const [delivery, setDelivery] = useState(ready);
  return (
    <ThemeProvider>
      <AuctioneerDeliveryAction
        delivery={delivery}
        onUpdated={(value) => {
          onUpdated(value);
          setDelivery(value);
        }}
      />
    </ThemeProvider>
  );
}

async function confirmSend() {
  await fireEvent.press(screen.getByRole('button', { name: 'Send to Auctioneer' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm send to Auctioneer' }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.get).mockResolvedValue(envelope(ready));
});

it('preserves the real safe 409 refusal through the scoped service error and rendered component', async () => {
  const message = 'Your part of this contract was closed. Re-open it from Incoming before sending more lots.';
  jest.mocked(api.post).mockRejectedValue({
    response: { status: 409, data: { message, code: 'auctioneer_contract_closed' } },
    message: 'Request failed with status code 409',
  });
  const onUpdated = jest.fn();
  await render(<ReportsCard onUpdated={onUpdated} />);
  await confirmSend();
  await waitFor(() => expect(screen.getByRole('alert').props.children).toBe(message));
  expect(screen.queryByText(/status code 409/)).toBeNull();
  expect(onUpdated).not.toHaveBeenCalled();
  expect(api.get).toHaveBeenCalledWith('/auctioneer/deliveries/work-a');
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/auctioneer/deliveries/work-a/send', {
    destination: 'LottingBoard', completeContract: false,
  }, { skipAuthRefreshReplay: true });
});

it('adopts the verified queue receipt and renders Queued rather than Sent', async () => {
  const queued: AuctioneerDeliverySummary = {
    ...ready, state: 'queued', canSend: false, destination: 'LottingBoard', completeContract: false,
  };
  jest.mocked(api.post).mockResolvedValue(envelope(queued));
  const onUpdated = jest.fn();
  await render(<ReportsCard onUpdated={onUpdated} />);
  await confirmSend();
  await waitFor(() => expect(screen.getByText('Auctioneer delivery queued. You can continue working.')).toBeTruthy());
  expect(onUpdated).toHaveBeenCalledTimes(1);
  expect(onUpdated).toHaveBeenCalledWith(queued);
  expect(screen.queryByText('Sent to Auctioneer.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send to Auctioneer' })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('rejects a mismatched report receipt even when it claims Sent and never updates the report card', async () => {
  jest.mocked(api.post).mockResolvedValue(envelope({
    ...ready, reportId: 'another-report', state: 'sent', canSend: false,
  }));
  const onUpdated = jest.fn();
  await render(<ReportsCard onUpdated={onUpdated} />);
  await confirmSend();
  await waitFor(() => expect(screen.getByRole('alert').props.children).toBe(
    'The Auctioneer delivery status could not be verified. Refresh Reports before trying again.'
  ));
  expect(screen.queryByText('Sent to Auctioneer.')).toBeNull();
  expect(screen.getByText('Ready to send to Auctioneer.')).toBeTruthy();
  expect(onUpdated).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});
