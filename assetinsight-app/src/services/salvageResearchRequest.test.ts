import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { clearSalvageResearchRequest, salvageResearchRequestId } from './salvageResearchRequest';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true, default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'request-uuid') }));
beforeEach(() => { jest.resetAllMocks(); jest.mocked(Crypto.randomUUID).mockReturnValue('request-uuid'); });

it('persists before returning a new paid request identity and reuses unknown outcomes', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  expect(await salvageResearchRequestId('r1', 4)).toBe('request-uuid');
  expect(AsyncStorage.setItem).toHaveBeenCalledWith('cv:salvage-research:r1:4', 'request-uuid');
  jest.mocked(AsyncStorage.getItem).mockResolvedValue('previous-id');
  expect(await salvageResearchRequestId('r1', 4)).toBe('previous-id');
  expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
});
it('fails closed when an action identity cannot be saved', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('storage unavailable'));
  await expect(salvageResearchRequestId('r1', 4)).rejects.toThrow('storage unavailable');
});
it('does not turn accepted research into an error when local cleanup fails', async () => {
  jest.mocked(AsyncStorage.removeItem).mockRejectedValue(new Error('storage unavailable'));
  await expect(clearSalvageResearchRequest('r1', 4)).resolves.toBeUndefined();
});
