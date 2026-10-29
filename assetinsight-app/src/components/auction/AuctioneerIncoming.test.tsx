import React from 'react';
import { act, fireEvent, render as nativeRender, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../context/ThemeContext';
import AuctioneerIncoming, { retainAuctioneerAccessRevision } from './AuctioneerIncoming';
import AuctionManagementScreen from '../../screens/AuctionManagementScreen';
import DrawerContent from '../DrawerContent';
import auctioneerService, {
  type AuctioneerIncomingItem,
  type AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';
import legacyService from '../../services/auctionManagementService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { invalidateAuthOperations } from '../../services/authSessionOperation';

let mockPanelOwner: string | undefined;

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { _id: mockPanelOwner, username: 'Test appraiser' }, logout: jest.fn() }),
}));
jest.mock('../../services/auctioneerService', () => ({
  __esModule: true,
  isEditableAuctioneerSetup: jest.requireActual('../../services/auctioneerService')
    .isEditableAuctioneerSetup,
  default: { getStatus: jest.fn(), getIncoming: jest.fn(), getSetup: jest.fn(), claim: jest.fn(), getCapturePermission: jest.fn(), reopenContract: jest.fn() },
}));
jest.mock('../../services/auctionManagementService', () => ({
  __esModule: true,
  default: { getTasks: jest.fn(), getTask: jest.fn(), markOpened: jest.fn() },
}));
jest.mock('../forms/AssetFormSheet', () => {
  const { Text, View, TouchableOpacity } = jest.requireActual('react-native');
  return (props: any) => {
    const [boundarySession] = require('react').useState(props.auctioneer.workItemId);
    return props.visible ? (
      <View>
        <Text>Boundary session {boundarySession}</Text>
        <Text>Asset form {props.auctioneer.workItemId}</Text>
        <Text>Imported {props.auctioneer.contract.contractNo}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Accepted next form"
          onPress={() =>
            props.onAuctioneerSetupChange({
              ...props.auctioneer,
              workItemId: 'child-2',
              clientSubmissionId: 'submission-2',
              kind: 'unknown',
              lots: [],
            })
          }>
          <Text>Next</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close Asset form"
          onPress={props.onClose}>
          <Text>Close</Text>
        </TouchableOpacity>
      </View>
    ) : null;
  };
});
jest.mock('../forms/LotListingFormSheet', () => {
  const { Text, View } = jest.requireActual('react-native');
  return (props: any) =>
    props.visible ? (
      <View>
        <Text>Lot form {props.auctioneer?.workItemId || 'legacy'}</Text>
      </View>
    ) : null;
});

const render = (element: React.ReactElement) =>
  nativeRender(<ThemeProvider>{element}</ThemeProvider>);

const available: AuctioneerIncomingItem = {
  cycleKey: 'cycle-1',
  contractId: 'contract-1',
  contractNo: '93530',
  customerName: 'Imported customer',
  eventTitle: 'Sale',
  location: 'Regina',
  kind: 'scheduleA',
  lotCount: 2,
  status: 'available',
};
const setup: AuctioneerWorkItemSetup = {
  workItemId: 'work-1',
  cycleKey: 'cycle-1',
  kind: 'scheduleA',
  reportType: 'asset',
  clientSubmissionId: 'submission-1',
  status: 'claimed',
  contract: {
    id: 'contract-1',
    contractNo: '93530',
    customerName: 'Imported customer',
    eventTitle: 'Sale',
    location: 'Regina',
  },
  lots: [{ sourceKey: 'source-1', lotId: 'existing-lot' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPanelOwner = undefined;
  jest.mocked(auctioneerService.getStatus).mockResolvedValue({ configured: true, enabled: true });
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([available]);
  jest.mocked(auctioneerService.claim).mockResolvedValue(setup);
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(setup);
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValue({ reopen: { allowed: false, reason: null, reopenUntil: null } });
  jest.mocked(legacyService.getTasks).mockResolvedValue([]);
});

it('keeps pending Continue recovery inside the assigned-contract scroll list on short screens', async () => {
  mockPanelOwner = 'owner';
  const owner = jest.spyOn(OfflineCaptureStore, 'getOwnerId').mockReturnValue('owner');
  const rows = jest
    .spyOn(OfflineCaptureStore, 'listContinuations')
    .mockResolvedValue([
      {
        id: 'pending',
        ownerId: 'owner',
        type: 'asset',
        stage: 'staged',
        parentSetup: { contract: { contractNo: 'pending-contract' } },
      },
    ] as any);
  try {
    await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
    const button = await screen.findByRole('button', {
      name: 'Retry next lot for pending-contract',
    });
    const ancestors: string[] = [];
    for (let parent = button.parent; parent; parent = parent.parent) ancestors.push(parent.type);
    expect(ancestors.some((type) => /ScrollView/.test(type))).toBe(true);
  } finally {
    owner.mockRestore();
    rows.mockRestore();
  }
});

it.each(['asset', 'lotListing'] as const)(
  'opens an assigned contract in the selected %s form',
  async (type) => {
    jest.mocked(auctioneerService.claim).mockResolvedValue({ ...setup, reportType: type });
    await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
    await fireEvent.press(
      await screen.findByRole('button', {
        name: `Open contract 93530 as ${type === 'asset' ? 'Asset' : 'Lot Listing'}`,
      })
    );
    expect(auctioneerService.claim).toHaveBeenCalledWith('cycle-1', type);
    expect(
      await screen.findByText(`${type === 'asset' ? 'Asset' : 'Lot'} form work-1`)
    ).toBeTruthy();
    expect(legacyService.markOpened).not.toHaveBeenCalled();
  }
);

it('locks both claim choices until the same request completes', async () => {
  let resolve!: (value: AuctioneerWorkItemSetup) => void;
  jest.mocked(auctioneerService.claim).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Open contract 93530 as Asset' })
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Open contract 93530 as Lot Listing' }));
  expect(auctioneerService.claim).toHaveBeenCalledTimes(1);
  await act(async () => resolve(setup));
  expect(await screen.findByText('Asset form work-1')).toBeTruthy();
});

it('replaces an accepted form with the returned successor without claiming again', async () => {
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Open contract 93530 as Asset' })
  );
  await fireEvent.press(await screen.findByRole('button', { name: 'Accepted next form' }));
  expect(await screen.findByText('Asset form child-2')).toBeTruthy();
  expect(screen.queryByText('Asset form work-1')).toBeNull();
  expect(screen.getByText('Imported 93530')).toBeTruthy();
  expect(screen.getByText('Boundary session work-1')).toBeTruthy();
  expect(auctioneerService.claim).toHaveBeenCalledTimes(1);
});

it('opens an already-used work item as its saved report, not a new capture', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([
    {
      ...available,
      status: 'report_created',
      claimedByMe: true,
      workItemId: 'work-1',
      selectedReportType: 'lotListing',
    },
  ]);
  jest.mocked(auctioneerService.getSetup).mockResolvedValue({
    ...setup,
    reportType: 'lotListing',
    status: 'report_created',
    reportId: 'saved-report',
  });
  const onOpenReport = jest.fn();
  await render(<AuctioneerIncoming onOpenReport={onOpenReport} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Open contract 93530' }));
  expect(onOpenReport).toHaveBeenCalledWith('saved-report', 'lotListing');
  expect(auctioneerService.claim).not.toHaveBeenCalled();
  expect(screen.queryByText('Lot form work-1')).toBeNull();
});

it('does not load contracts when the backend feature is disabled', async () => {
  jest.mocked(auctioneerService.getStatus).mockResolvedValue({ configured: true, enabled: false });
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText(/currently disabled for your account/)).toBeTruthy();
  expect(auctioneerService.getIncoming).not.toHaveBeenCalled();
});

it('shows a retryable connection error without opening a form', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockRejectedValueOnce(new Error('Connection unavailable'));
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Connection unavailable')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry assigned contracts' }));
  expect(await screen.findByText('Contract 93530')).toBeTruthy();
  expect(auctioneerService.getIncoming).toHaveBeenLastCalledWith(true);
  expect(auctioneerService.claim).not.toHaveBeenCalled();
});

it('does not expose open actions for work claimed by another user', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([{ ...available, status: 'claimed', claimedByMe: false }]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('This work is not available to open.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Open contract/ })).toBeNull();
});

it('opens the current assigned queue directly without the legacy localhost proxy', async () => {
  await render(<AuctionManagementScreen onOpenDrawer={jest.fn()} onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Contract 93530')).toBeTruthy();
  expect(legacyService.getTasks).not.toHaveBeenCalled();
  expect(legacyService.getTask).not.toHaveBeenCalled();
  expect(auctioneerService.getStatus).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Auctionsoft')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh incoming contracts' }));
  expect(auctioneerService.getIncoming).toHaveBeenLastCalledWith(true);
  expect(legacyService.getTasks).not.toHaveBeenCalled();
});

it('matches Pristine web Outstanding and Completed without hiding unsent or released claims', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([
      available,
      {
        ...available,
        cycleKey: 'sent',
        contractNo: '90002',
        status: 'sent',
        claimedByMe: true,
        workItemId: 'sent-work',
      },
      {
        ...available,
        cycleKey: 'created',
        contractNo: '90003',
        status: 'report_created',
        claimedByMe: true,
        workItemId: 'created-work',
      },
      {
        ...available,
        cycleKey: 'released',
        contractNo: '90004',
        status: 'abandoned',
        claimedByMe: true,
      },
    ]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Outstanding (3)')).toBeTruthy();
  expect(screen.getByText('Completed (1)')).toBeTruthy();
  expect(screen.getByText('Contract 90003')).toBeTruthy();
  expect(screen.getByText('Contract 90004')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contract 90004' })).toBeNull();
  expect(screen.queryByText('Contract 90002')).toBeNull();
  await fireEvent.press(screen.getByRole('tab', { name: 'Completed contracts' }));
  expect(screen.getByText('Contract 90002')).toBeTruthy();
  expect(screen.getByText('Sent to Auctioneer')).toBeTruthy();
  expect(screen.queryByText('Contract 90003')).toBeNull();
  jest
    .mocked(auctioneerService.getSetup)
    .mockResolvedValue({ ...setup, reportId: 'saved-sent', status: 'sent' });
  const open = screen.getByRole('button', { name: 'Open contract 90002' });
  await fireEvent.press(open);
  expect(auctioneerService.getSetup).toHaveBeenCalledWith('sent-work');
  expect(auctioneerService.claim).not.toHaveBeenCalled();
});

it('shows contract description and explicit contact roles from the API', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([
      {
        ...available,
        description: 'Farm equipment',
        consignorName: 'Consignor name',
        salespersonName: 'Salesperson name',
      },
    ]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Description: Farm equipment')).toBeTruthy();
  expect(screen.getByText('Consignor: Consignor name')).toBeTruthy();
  expect(screen.getByText('Salesperson: Salesperson name')).toBeTruthy();
});

it('shows Retry instead of an empty success state or internal URL when the provider fails', async () => {
  jest
    .mocked(auctioneerService.getIncoming)
    .mockRejectedValueOnce({
      response: {
        status: 502,
        data: {
          message:
            'Could not reach Auctionsoft at http://127.0.0.1:3331/api/integrations/auction-management/tasks: fetch failed',
        },
      },
    });
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText(/server could not connect to Auctioneer/)).toBeTruthy();
  expect(screen.queryByText(/127\.0\.0\.1|fetch failed|No outstanding/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry assigned contracts' }));
  expect(await screen.findByText('Contract 93530')).toBeTruthy();
});

it('retains previously loaded contracts while a refresh fails', async () => {
  await render(<AuctionManagementScreen onOpenDrawer={jest.fn()} onOpenReport={jest.fn()} />);
  await screen.findByText('Contract 93530');
  jest.mocked(auctioneerService.getIncoming).mockRejectedValueOnce(new Error('Network Error'));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh incoming contracts' }));
  expect(await screen.findByText(/Showing the last loaded contracts/)).toBeTruthy();
  expect(screen.getByText('Contract 93530')).toBeTruthy();
  expect(screen.queryByText(/No outstanding/)).toBeNull();
});

it('does not open a blank form when a saved work item is no longer editable', async () => {
  jest
    .mocked(auctioneerService.getSetup)
    .mockResolvedValue({ ...setup, status: 'sent', reportId: undefined });
  jest
    .mocked(auctioneerService.getIncoming)
    .mockResolvedValue([
      { ...available, status: 'report_created', claimedByMe: true, workItemId: 'work-1' },
    ]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Open contract 93530' }));
  expect(await screen.findByText(/no longer available for a new capture/)).toBeTruthy();
  expect(screen.queryByText('Asset form work-1')).toBeNull();
});

it('ignores a late failed claim after the sign-in session changes', async () => {
  let reject!: (cause: unknown) => void;
  jest.mocked(auctioneerService.claim).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    })
  );
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Open contract 93530 as Asset' })
  );
  invalidateAuthOperations();
  await act(async () => reject(new Error('Previous account private error')));
  expect(screen.queryByText('Previous account private error')).toBeNull();
  expect(screen.queryByText('Asset form work-1')).toBeNull();
});

it('provides a reachable Incoming entry in the listing drawer', async () => {
  const onNavigate = jest.fn();
  const onClose = jest.fn();
  await render(
    <DrawerContent activeScreen="auctionManagement" onNavigate={onNavigate} onClose={onClose} />
  );
  const incoming = screen.getByRole('button', { name: 'Incoming' });
  expect(incoming.props.accessibilityState.selected).toBe(true);
  await fireEvent.press(incoming);
  expect(onNavigate).toHaveBeenCalledWith('auctionManagement');
  expect(onClose).toHaveBeenCalledTimes(1);
});

const completed = { ...available, status: 'sent' as const, claimedByMe: true, workItemId: 'old-work' };

it('retains receipt revision 42 while waiting but lets fresh server revision 43 replace it', () => {
  expect(retainAuctioneerAccessRevision(available, 42).accessRevision).toBe(42);
  expect(retainAuctioneerAccessRevision({ ...available, accessRevision: 43 }, 42).accessRevision).toBe(43);
  expect(retainAuctioneerAccessRevision({ ...available, accessRevision: 0 }, 42).accessRevision).toBe(0);
});
const canReopen = { reopen: { allowed: true, reason: null, reopenUntil: '2026-10-27T15:00:00.000Z' }, accessRevision: 3 };
const showCompleted = async () => {
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await screen.findByText('Completed (1)');
  await fireEvent.press(screen.getByRole('tab', { name: 'Completed contracts' }));
};

it('offers Re-Open for fresh upstream permission even when the local row is still unsent', async () => {
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValue(canReopen);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByRole('button', { name: 'Re-Open contract 93530' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open contract 93530 as Asset' })).toBeTruthy();
  expect(auctioneerService.reopenContract).not.toHaveBeenCalled();
});

it('loads Re-Open permission only for rendered Completed cards and never infers it from the deadline', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([{ ...completed, reopenUntil: '2099-10-27T15:00:00.000Z' }]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  await screen.findByText('Completed (1)');
  expect(auctioneerService.getCapturePermission).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('tab', { name: 'Completed contracts' }));
  await screen.findByText('Contract 93530');
  expect(auctioneerService.getCapturePermission).toHaveBeenCalledWith('contract-1');
  expect(screen.queryByRole('button', { name: 'Re-Open contract 93530' })).toBeNull();
  expect(auctioneerService.reopenContract).not.toHaveBeenCalled();
});

it('rechecks permission, locks duplicate taps and reloads fresh work after confirmed Re-Open', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValueOnce([completed]).mockResolvedValue([{ ...available, cycleKey: 'fresh-cycle', kind: 'unknown', lotCount: 0 }]);
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValue(canReopen);
  let finish!: (value: any) => void;
  jest.mocked(auctioneerService.reopenContract).mockReturnValue(new Promise((done) => { finish = done; }));
  await showCompleted();
  const action = await screen.findByRole('button', { name: 'Re-Open contract 93530' });
  await fireEvent.press(action);
  await fireEvent.press(action);
  expect(auctioneerService.getCapturePermission).toHaveBeenCalledTimes(2);
  expect(auctioneerService.reopenContract).toHaveBeenCalledTimes(1);
  await act(async () => finish({ contractId: 'contract-1', reopened: true, alreadyOpen: false, accessRevision: 4 }));
  expect(await screen.findByText(/Contract re-opened. Choose Asset/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Open contract 93530 as Asset' }));
  expect(auctioneerService.claim).toHaveBeenCalledWith('fresh-cycle', 'asset');
  expect(auctioneerService.getSetup).not.toHaveBeenCalled();
});

it('does not post when fresh permission revokes a previously displayed Re-Open', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([completed]);
  jest.mocked(auctioneerService.getCapturePermission)
    .mockResolvedValueOnce(canReopen)
    .mockResolvedValue({ reopen: { allowed: false, reason: 'LOTS_CLOSING_STARTED', reopenUntil: null } });
  await showCompleted();
  await fireEvent.press(await screen.findByRole('button', { name: 'Re-Open contract 93530' }));
  expect((await screen.findAllByText(/Lots have started closing/)).length).toBeGreaterThan(0);
  expect(auctioneerService.reopenContract).not.toHaveBeenCalled();
  expect(screen.queryByText(/Contract re-opened/)).toBeNull();
});

it('shows a refusal reason, refreshes permission and retains the previous report', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([completed]);
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValueOnce(canReopen).mockResolvedValueOnce(canReopen)
    .mockResolvedValue({ reopen: { allowed: false, reason: 'EVENT_CLOSED', reopenUntil: null } });
  jest.mocked(auctioneerService.reopenContract).mockRejectedValue({ response: { status: 409, data: { code: 'EVENT_CLOSED' } } });
  await showCompleted();
  await fireEvent.press(await screen.findByRole('button', { name: 'Re-Open contract 93530' }));
  expect((await screen.findAllByText(/This event is closed or cancelled/)).length).toBeGreaterThan(0);
  expect(screen.getByText('Contract 93530')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Re-Open contract 93530' })).toBeNull();
  expect(auctioneerService.getCapturePermission).toHaveBeenCalledTimes(3);
  expect(auctioneerService.claim).not.toHaveBeenCalled();
});

it('requires an explicit outcome check after an uncertain POST, even when ordinary permission is now false', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValueOnce([completed]).mockResolvedValue([available]);
  const pending = { reopen: { allowed: false, reason: null, reopenUntil: null }, confirmationPending: true };
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValueOnce(canReopen).mockResolvedValueOnce(canReopen).mockResolvedValue(pending);
  jest.mocked(auctioneerService.reopenContract).mockRejectedValueOnce(new Error('Network Error')).mockResolvedValue({ contractId: 'contract-1', reopened: false, alreadyOpen: true, accessRevision: 4 });
  await showCompleted();
  await fireEvent.press(await screen.findByRole('button', { name: 'Re-Open contract 93530' }));
  const check = await screen.findByRole('button', { name: 'Check Re-Open contract 93530' });
  expect(auctioneerService.reopenContract).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Contract re-opened/)).toBeNull();
  await fireEvent.press(check);
  expect(await screen.findByText(/This contract is already open. Choose Asset/)).toBeTruthy();
  expect(auctioneerService.reopenContract).toHaveBeenCalledTimes(2);
});

it('ignores a late Re-Open success after the sign-in session changes', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([completed]);
  jest.mocked(auctioneerService.getCapturePermission).mockResolvedValue(canReopen);
  let finish!: (value: any) => void;
  jest.mocked(auctioneerService.reopenContract).mockReturnValue(new Promise((done) => { finish = done; }));
  await showCompleted();
  await fireEvent.press(await screen.findByRole('button', { name: 'Re-Open contract 93530' }));
  invalidateAuthOperations();
  await act(async () => finish({ contractId: 'contract-1', reopened: true, accessRevision: 4 }));
  expect(auctioneerService.getIncoming).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Contract re-opened/)).toBeNull();
});

it('does not turn a stale outcome-check action into a new Re-Open intent', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([completed]);
  jest.mocked(auctioneerService.getCapturePermission)
    .mockResolvedValueOnce({ reopen: { allowed: false, reason: null, reopenUntil: null }, confirmationPending: true })
    .mockResolvedValue(canReopen);
  await showCompleted();
  await fireEvent.press(await screen.findByRole('button', { name: 'Check Re-Open contract 93530' }));
  expect(await screen.findByText(/Refresh Incoming to check its status/)).toBeTruthy();
  expect(auctioneerService.reopenContract).not.toHaveBeenCalled();
});

// owner 2026-10-28: a Proposal worked from its list shows how many listed items
// this user still has to capture; any other lots-free row reads as before.
it('labels a Proposal list row with its listed items to capture', async () => {
  jest.mocked(auctioneerService.getIncoming).mockResolvedValue([
    { ...available, kind: 'unknown', lotCount: 3, proposalList: true },
    { ...available, cycleKey: 'cycle-2', contractNo: '93531', kind: 'unknown', lotCount: 1, proposalList: true },
    { ...available, cycleKey: 'cycle-3', contractNo: '93532', kind: 'unknown', lotCount: 0 },
  ]);
  await render(<AuctioneerIncoming onOpenReport={jest.fn()} />);
  expect(await screen.findByText('Proposal list · 3 listed items to capture')).toBeTruthy();
  expect(screen.getByText('Proposal list · 1 listed item to capture')).toBeTruthy();
  expect(screen.getByText('New lot capture')).toBeTruthy();
});
