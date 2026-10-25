import { randomUUID } from "node:crypto";
import CrmLead from "../models/crmLead.model.js";

export const CRM_CALENDAR_DELETE_CONFLICT = "Clear the follow-up and confirm its Outlook removal before deleting this lead or batch. Pending calendar changes and existing data have been retained.";

const calendarClear = {
  followUpAt: { $exists: false },
  followUpDate: { $exists: false },
  "followUpOutlook.eventId": { $exists: false },
  "followUpOutlook.syncPending": { $ne: true },
  followUpOutlookOperation: { $exists: false },
};

/** Reserve the exact rows before any media deletion. Failed batch admission
 * releases all reservations before returning; it never deletes a partial batch.
 * No expiry: process loss must not let a new calendar write race late cleanup. */
export async function reserveCrmLeadDeletion(ids: readonly unknown[]): Promise<string | undefined> {
  const token = randomUUID();
  await CrmLead.updateMany({ _id: { $in: ids }, ...calendarClear, crmDeletionToken: { $exists: false } },
    { $set: { crmDeletionToken: token } });
  if (await CrmLead.countDocuments({ _id: { $in: ids }, crmDeletionToken: token }) !== ids.length) {
    await releaseCrmLeadDeletion(token);
    return undefined;
  }
  return token;
}

export async function releaseCrmLeadDeletion(token: string): Promise<void> {
  await CrmLead.updateMany({ crmDeletionToken: token }, { $unset: { crmDeletionToken: 1 } });
}

export async function deleteReservedCrmLeads(ids: readonly unknown[], token: string): Promise<number> {
  const result = await CrmLead.deleteMany({ _id: { $in: ids }, crmDeletionToken: token, ...calendarClear });
  return result.deletedCount;
}
