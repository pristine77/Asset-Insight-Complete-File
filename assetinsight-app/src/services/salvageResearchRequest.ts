import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

export const salvageResearchRequestKey = (reportId: string, revision: number) =>
  `cv:salvage-research:${reportId}:${revision}`;

/** Persist before dispatch so reconnecting/retrying cannot create another paid run. */
export async function salvageResearchRequestId(reportId: string, revision: number): Promise<string> {
  const key = salvageResearchRequestKey(reportId, revision);
  const previous = await AsyncStorage.getItem(key);
  if (previous) return previous;
  const id = Crypto.randomUUID();
  await AsyncStorage.setItem(key, id);
  return id;
}

export async function clearSalvageResearchRequest(reportId: string, revision: number): Promise<void> {
  try { await AsyncStorage.removeItem(salvageResearchRequestKey(reportId, revision)); }
  catch { /* Accepted actions must not appear failed because cleanup failed. */ }
}
