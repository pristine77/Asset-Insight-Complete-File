/**
 * CRM transport and orchestration boundary for agents and administrators.
 *
 * The module spans lead timelines, assignment, imports, automated discovery,
 * calendar integration, and transfers. Authenticated HTTP mutations use the middleware
 * actor; OAuth callbacks use signed state and durable workers use persisted job identity.
 * Reusable workflow, geospatial, notification, and provider behavior lives in services.
 */
import { Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";
import User, { CRM_SPECIALIZATION_VALUES } from "../models/user.model.js";
import CrmLead, { CRM_LEAD_STATUSES } from "../models/crmLead.model.js";
import CrmAutoFindLead from "../models/crmAutoFindLead.model.js";
import CrmAutoFindRun from "../models/crmAutoFindRun.model.js";
import CrmImportJob from "../models/crmImportJob.model.js";
import CrmTaskTransferRequest, { CRM_TRANSFER_STATUSES } from "../models/crmTaskTransfer.model.js";
import { AdminAuthRequest } from "../middleware/admin.middleware.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import {
  deleteFromR2,
  downloadR2ObjectToFile,
  getCurrentR2StorageTarget,
  resolveCurrentR2ObjectLocationFromUrl,
  uploadFilePathToR2,
  uploadToR2,
} from "../utils/r2Storage/r2Upload.js";
import {
  isCurrentCrmImportStorageTarget,
  resolveCrmImportStorageTarget,
  snapshotCurrentCrmImportStorage,
} from "../utils/crmImportStorage.js";
import openai from "../utils/openaiClient.js";
import { toFile } from "openai/uploads";
import { sendCrmAgentAssignedEmail, sendCrmTasksAssignedEmail } from "../service/crmEmailService.js";
import {
  buildLeadGeoSource,
  chooseNearestCrmAssignee,
  normalizeCrmGeoLocation,
  normalizeCrmGeoLocationHeuristic,
  prepareCrmAssignees,
  type CrmAssignmentChoice,
  type CrmGeoLocation,
  type PreparedCrmAssignee,
} from "../service/crmGeoAssignmentService.js";
import { sendCrmAdminMessageNotification, sendCrmNewTaskNotification } from "../service/crmPushService.js";
import { notifyUser } from "../service/notificationService.js";
import { allowedCategories } from "../utils/assetPrompts.js";
import {
  buildAutoFindFingerprint,
  CANADA_PROVINCES,
  CRM_AUTO_FIND_BATCH_COUNT,
  CRM_AUTO_FIND_MAX_RESULTS,
  runCrmAutoFindSearchPlans,
  type CrmAutoFindCountry,
  type CrmAutoFindLeadResult,
  US_STATES,
} from "../service/crmAutoFindService.js";
import {
  buildRevenueRadarSearchKeywords,
  getRevenueRadarSnapshot,
  REVENUE_RADAR_CATEGORY_OPTIONS,
} from "../service/crmRevenueRadarService.js";
import {
  applyCrmStatusChange,
  computeNextCrmReminderDate,
  CRM_OPEN_STATUSES,
  isCrmLostReason,
  isCrmStatus,
  normalizeCrmLeadDocument,
  normalizeCrmStatusValue,
} from "../service/crmWorkflowService.js";
import {
  computeCrmFollowUpSchedule,
  CRM_FOLLOW_UP_DEFAULT_TIME_ZONE,
  CRM_FOLLOW_UP_READ_FIELDS,
  CrmFollowUpInputError,
  type CrmFollowUpIntent,
  hasActiveCrmFollowUp,
  readCrmFollowUpIntent,
  requestCrmFollowUpOutlookSync,
  resolveCrmFollowUpOnTaskUpdate,
} from "../service/crmFollowUpService.js";
import {
  addCalendarDays,
  calendarDaysBetween,
  isCalendarDate,
  isValidTimeZone,
  zonedWallTimeToUtc,
} from "../utils/zonedTime.js";
import {
  formatAxiosErrorForLog,
  getMsOutlookClientId,
  getMsOutlookClientSecret,
  getMsOutlookRedirectUri,
  getMsOutlookScopes,
  getValidMicrosoftAccessTokenForUser,
  isMsOutlookConfigured,
  MS_GRAPH_API_BASE,
  MS_GRAPH_AUTH_BASE,
  MS_GRAPH_TOKEN_BASE,
} from "../service/msOutlookCalendarService.js";
import { syncCrmFollowUpOutlookEvent } from "../service/crmFollowUpOutlookService.js";
import { CRM_CALENDAR_DELETE_CONFLICT, deleteReservedCrmLeads, releaseCrmLeadDeletion, reserveCrmLeadDeletion } from "../service/crmLeadDeletionService.js";
import {
  excelSerialToDate,
  isSpreadsheetImportError,
  SpreadsheetImportError,
  streamFirstWorksheetRowsFromFile,
  validateSpreadsheetFile,
  type ExcelRow,
} from "../utils/excel.js";
import { normalizeCrmPhone } from "../utils/crmPhone.js";
import { createMongoReportJob } from "../utils/reportJobMongoQueue.js";
import type { IReportJob } from "../models/reportJob.model.js";
import { crmLeadCohortFilter, crmUserCohortFilter, isReviewAccount, normalCrmUserFilter, sameCrmCohort } from "../service/reviewAccountPolicy.js";

const PHONE_FALLBACK = "";
const CRM_SPECIALIZATION_SET = new Set<string>(CRM_SPECIALIZATION_VALUES as readonly string[]);
const CRM_TRANSFER_STATUS_SET = new Set<string>(CRM_TRANSFER_STATUSES as readonly string[]);

type ParsedListItems = {
  original: string[];
  normalized: string[];
  hasInlineDuplicates: boolean;
};

export const editCrmTaskUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    const comment = toNonEmptyString((req.body || {}).comment);
    const status = toNonEmptyString((req.body || {}).status);
    const lostReason = toNonEmptyString((req.body || {}).lostReason);

    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Task id and update id are required" });
    }
    if (!comment && !status && !lostReason) {
      return res.status(400).json({ message: "Provide comment, status, and/or lost reason to edit update" });
    }
    if (status && !isCrmStatus(status)) {
      return res.status(400).json({ message: "Invalid CRM status" });
    }
    if (lostReason && !isCrmLostReason(lostReason)) {
      return res.status(400).json({ message: "Invalid CRM lost reason" });
    }

    // Authentication alone is insufficient: CRM entitlement, account status, lead
    // assignment and update authorship form separate authorization boundaries.
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    normalizeCrmLeadDocument(lead);
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit a deleted update" });
    }
    if (!canMutateLeadUpdate(found.update, req.userId)) {
      return res.status(403).json({ message: "You can only edit your own CRM updates" });
    }

    if (comment) {
      (found.update as any).comment = comment;
    }
    const effectiveStatus = status || toNonEmptyString((found.update as any).status) || toNonEmptyString((lead as any).status);
    if (effectiveStatus === "lost" && !lostReason && !toNonEmptyString((found.update as any).lostReason)) {
      return res.status(400).json({ message: "Lost reason is required when status is Lost" });
    }
    if (status || lostReason) {
      const normalized = normalizeCrmStatusValue(effectiveStatus, lostReason || (found.update as any).lostReason);
      (found.update as any).status = normalized.status;
      (found.update as any).lostReason = normalized.lostReason || undefined;
      applyCrmStatusChange(lead, normalized.status, normalized.lostReason, new Date());
    }
    (found.update as any).editedAt = new Date();

    // Timeline edits can change denormalized summary fields used by queue sorting;
    // recompute them from the surviving updates before persisting the lead.
    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId, isReviewAccount(req.user));
    return res.status(200).json({ message: "CRM update edited", item });
  } catch (e: any) {
    console.error("editCrmTaskUpdate error", e);
    return res.status(500).json({ message: e?.message || "Failed to edit CRM update" });
  }
};

export const deleteCrmTaskUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Task id and update id are required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Update is already deleted" });
    }
    if (!canMutateLeadUpdate(found.update, req.userId)) {
      return res.status(403).json({ message: "You can only delete your own CRM updates" });
    }

    const existingAttachments = Array.isArray((found.update as any).attachmentUrls)
      ? ((found.update as any).attachmentUrls as string[])
      : [];
    const recordingUrl = toNonEmptyString((found.update as any).recordingUrl);
    await removeMediaFromR2([...existingAttachments, recordingUrl]);

    (found.update as any).comment = undefined;
    (found.update as any).attachmentUrls = [];
    (found.update as any).recordingUrl = undefined;
    (found.update as any).isDeleted = true;
    (found.update as any).deletedAt = new Date();
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId, isReviewAccount(req.user));
    return res.status(200).json({ message: "CRM update deleted", item });
  } catch (e: any) {
    console.error("deleteCrmTaskUpdate error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM update" });
  }
};

export const deleteCrmTaskUpdateAttachments = async (req: AuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Task id and update id are required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit attachments on a deleted update" });
    }
    if (!canMutateLeadUpdate(found.update, req.userId)) {
      return res.status(403).json({ message: "You can only edit attachments on your own updates" });
    }

    const existingAttachments = Array.isArray((found.update as any).attachmentUrls)
      ? ((found.update as any).attachmentUrls as string[])
      : [];
    if (existingAttachments.length === 0) {
      return res.status(400).json({ message: "This update has no attachments" });
    }

    const requestedUrls = normalizeStringArrayInput((req.body || {}).urls);
    const toRemove = requestedUrls.length > 0
      ? existingAttachments.filter((url) => requestedUrls.includes(url))
      : [...existingAttachments];

    if (toRemove.length === 0) {
      return res.status(400).json({ message: "No matching attachments found to delete" });
    }

    await removeMediaFromR2(toRemove);

    (found.update as any).attachmentUrls = existingAttachments.filter((url) => !toRemove.includes(url));
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId, isReviewAccount(req.user));
    return res.status(200).json({ message: "Attachment(s) deleted", item, deletedCount: toRemove.length });
  } catch (e: any) {
    console.error("deleteCrmTaskUpdateAttachments error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM attachments" });
  }
};

export const deleteCrmTaskUpdateRecording = async (req: AuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Task id and update id are required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit recording on a deleted update" });
    }
    if (!canMutateLeadUpdate(found.update, req.userId)) {
      return res.status(403).json({ message: "You can only edit recording on your own updates" });
    }

    const recordingUrl = toNonEmptyString((found.update as any).recordingUrl);
    if (!recordingUrl) {
      return res.status(400).json({ message: "This update has no recording" });
    }

    await removeMediaFromR2([recordingUrl]);
    (found.update as any).recordingUrl = undefined;
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId, isReviewAccount(req.user));
    return res.status(200).json({ message: "Recording deleted", item });
  } catch (e: any) {
    console.error("deleteCrmTaskUpdateRecording error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM recording" });
  }
};

export const editCrmLeadUpdateForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    const comment = toNonEmptyString((req.body || {}).comment);
    const status = toNonEmptyString((req.body || {}).status);
    const lostReason = toNonEmptyString((req.body || {}).lostReason);

    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Lead id and update id are required" });
    }
    if (!comment && !status && !lostReason) {
      return res.status(400).json({ message: "Provide comment, status, and/or lost reason to edit update" });
    }
    if (status && !isCrmStatus(status)) {
      return res.status(400).json({ message: "Invalid CRM status" });
    }
    if (lostReason && !isCrmLostReason(lostReason)) {
      return res.status(400).json({ message: "Invalid CRM lost reason" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });
    normalizeCrmLeadDocument(lead);

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit a deleted update" });
    }

    if (comment) {
      (found.update as any).comment = comment;
      lead.set("latestComment", comment);
    }
    const effectiveStatus = status || toNonEmptyString((found.update as any).status) || toNonEmptyString((lead as any).status);
    if (effectiveStatus === "lost" && !lostReason && !toNonEmptyString((found.update as any).lostReason)) {
      return res.status(400).json({ message: "Lost reason is required when status is Lost" });
    }
    if (status || lostReason) {
      const normalized = normalizeCrmStatusValue(effectiveStatus, lostReason || (found.update as any).lostReason);
      (found.update as any).status = normalized.status;
      (found.update as any).lostReason = normalized.lostReason || undefined;
      applyCrmStatusChange(lead, normalized.status, normalized.lostReason, new Date());
    }
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "CRM update edited", item });
  } catch (e: any) {
    console.error("editCrmLeadUpdateForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to edit CRM update" });
  }
};

export const deleteCrmLeadUpdateForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Lead id and update id are required" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Update is already deleted" });
    }

    const existingAttachments = Array.isArray((found.update as any).attachmentUrls)
      ? ((found.update as any).attachmentUrls as string[])
      : [];
    const recordingUrl = toNonEmptyString((found.update as any).recordingUrl);

    await removeMediaFromR2([...existingAttachments, recordingUrl]);

    (found.update as any).comment = undefined;
    (found.update as any).attachmentUrls = [];
    (found.update as any).recordingUrl = undefined;
    (found.update as any).isDeleted = true;
    (found.update as any).deletedAt = new Date();
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "CRM update deleted", item });
  } catch (e: any) {
    console.error("deleteCrmLeadUpdateForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM update" });
  }
};

export const deleteCrmLeadUpdateAttachmentsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Lead id and update id are required" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit attachments on a deleted update" });
    }

    const existingAttachments = Array.isArray((found.update as any).attachmentUrls)
      ? ((found.update as any).attachmentUrls as string[])
      : [];
    if (existingAttachments.length === 0) {
      return res.status(400).json({ message: "This update has no attachments" });
    }

    const requestedUrls = normalizeStringArrayInput((req.body || {}).urls);
    const toRemove = requestedUrls.length > 0
      ? existingAttachments.filter((url) => requestedUrls.includes(url))
      : [...existingAttachments];

    if (toRemove.length === 0) {
      return res.status(400).json({ message: "No matching attachments found to delete" });
    }

    await removeMediaFromR2(toRemove);

    (found.update as any).attachmentUrls = existingAttachments.filter((url) => !toRemove.includes(url));
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "Attachment(s) deleted", item, deletedCount: toRemove.length });
  } catch (e: any) {
    console.error("deleteCrmLeadUpdateAttachmentsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM attachments" });
  }
};

export const deleteCrmLeadUpdateRecordingForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const updateId = toNonEmptyString((req.params as any).updateId);
    if (!leadId || !updateId) {
      return res.status(400).json({ message: "Lead id and update id are required" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });

    const found = findLeadUpdateById(lead, updateId);
    if (!found) return res.status(404).json({ message: "CRM update not found" });
    if ((found.update as any).isDeleted) {
      return res.status(400).json({ message: "Cannot edit recording on a deleted update" });
    }

    const recordingUrl = toNonEmptyString((found.update as any).recordingUrl);
    if (!recordingUrl) {
      return res.status(400).json({ message: "This update has no recording" });
    }

    await removeMediaFromR2([recordingUrl]);
    (found.update as any).recordingUrl = undefined;
    (found.update as any).editedAt = new Date();

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "Recording deleted", item });
  } catch (e: any) {
    console.error("deleteCrmLeadUpdateRecordingForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM recording" });
  }
};

export const deleteCrmLeadForAdmin = async (req: AdminAuthRequest, res: Response) => {
  let deletionToken: string | undefined;
  try {
    const leadId = toNonEmptyString(req.params.id);
    if (!leadId) {
      return res.status(400).json({ message: "Lead id is required" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });
    deletionToken = await reserveCrmLeadDeletion([lead._id]);
    if (!deletionToken) return res.status(409).json({ message: CRM_CALENDAR_DELETE_CONFLICT });

    const mediaUrls: string[] = [];
    const updates = getUpdatesList(lead);
    for (const update of updates) {
      const attachments = Array.isArray((update as any).attachmentUrls)
        ? ((update as any).attachmentUrls as string[])
        : [];
      mediaUrls.push(...attachments);
      const rec = toNonEmptyString((update as any).recordingUrl);
      if (rec) mediaUrls.push(rec);
    }

    await removeMediaFromR2(mediaUrls);
    if (await deleteReservedCrmLeads([lead._id], deletionToken) !== 1) {
      return res.status(409).json({ message: CRM_CALENDAR_DELETE_CONFLICT });
    }

    return res.status(200).json({ message: "CRM lead deleted", deletedId: leadId });
  } catch (e: any) {
    console.error("deleteCrmLeadForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM lead" });
  } finally {
    if (deletionToken) await releaseCrmLeadDeletion(deletionToken);
  }
};

type ParsedImportDraft = {
  rowNumber: number;
  title: string;
  clientName: string;
  companyName?: string;
  email?: string;
  phoneRaw?: string;
  phoneFormatted?: string;
  contactPhones: string[];
  companyPhones: string[];
  contactMobilePhones: string[];
  notes?: string;
  contactSocials?: string;
  contactLocation?: string;
  contactLinkedinUrl?: string;
  companyLinkedinUrl?: string;
  companyLocation?: string;
  quadrant?: string;
  specialization?: string;
  category?: string;
  industry?: string;
  website?: string;
  companyWebsiteDomain?: string;
  researchDate?: Date;
  department?: string;
  seniority?: string;
  companyDescription?: string;
  companyAnnualRevenue?: number;
  companyRevenueRange?: string;
  companyStaffCount?: number;
  companyStaffCountRange?: string;
  companyFoundedDate?: Date;
  companyPostCode?: string;
  sicCode?: string;
  naicsCode?: string;
  importData?: Record<string, unknown>;
  listItems: string[];
  listItemsNormalized: string[];
  identityKey: string;
  dedupeFingerprints: string[];
  taskStartDate?: Date;
  dueDate?: Date;
  priority: "low" | "medium" | "high";
};

type CrmImportFileSummary = {
  sourceBatchId: string;
  sourceFileName?: string;
  sourceFileUrl?: string;
  sourceFileKey?: string;
  sourceFileBucket?: string;
  sourceFilePublicBaseUrl?: string;
  importedAt: Date;
  latestLeadAt: Date;
  leadCount: number;
};

type ImportDueDateConfig = {
  defaultDueDate?: Date;
  rowDueDates: Map<number, Date>;
};

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return fallback;
}

function normalizeImportedText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€\x9d/g, '"')
    .replace(/â€\"/g, '"')
    .replace(/â€“/g, "-")
    .replace(/â€”/g, "-")
    .replace(/â€¦/g, "...")
    .replace(/Â/g, "")
    .trim();
}

function toNonEmptyString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return normalizeImportedText(String(value));
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const text = toNonEmptyString(value);
  if (!text) return undefined;

  const normalized = text.replace(/[$,%\s]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseYearOrDateValue(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1000 && value <= 9999) {
    return new Date(Date.UTC(Math.trunc(value), 0, 1));
  }

  const text = toNonEmptyString(value);
  if (/^\d{4}$/.test(text)) {
    return new Date(Date.UTC(Number(text), 0, 1));
  }

  return parseDateValue(value);
}

function extractPrimaryEmail(value: unknown): string {
  const text = toNonEmptyString(value).toLowerCase();
  if (!text) return "";

  const matched = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (matched?.[0]) return matched[0].toLowerCase();

  const firstToken = text
    .split(/[\s,;|/]+/g)
    .map((part) => part.trim())
    .find(Boolean);
  return (firstToken || "").toLowerCase();
}

function extractPrimaryPhone(value: unknown): string {
  const text = toNonEmptyString(value);
  if (!text) return "";
  const firstValid = text
    .split(/[\n,;|/]+/g)
    .map((part) => part.trim())
    .map(normalizeCrmPhone)
    .find(Boolean);
  return firstValid?.raw || "";
}

function deriveClientName(input: {
  providedClientName: string;
  title: string;
  companyName: string;
  email: string;
}): string {
  if (input.providedClientName) return input.providedClientName;
  if (input.title && input.companyName) return `${input.title} - ${input.companyName}`;
  if (input.companyName) return input.companyName;

  const emailLocal = input.email.split("@")[0]?.replace(/[._-]+/g, " ").trim() || "";
  if (emailLocal) return emailLocal;
  if (input.title) return input.title;

  return "Unknown Client";
}

function deriveProvidedClientName(rowLookup: Record<string, unknown>): string {
  const fullName = toNonEmptyString(
    pickField(rowLookup, [
      "contact full name",
      "client name",
      "client_name",
      "client",
      "customer",
      "customer name",
      "name",
      "contact",
      "contact person",
      "contact name",
      "full name",
      "person name",
    ])
  );
  if (fullName) return fullName;

  const firstName = toNonEmptyString(pickField(rowLookup, ["first name", "firstname"]));
  const lastName = toNonEmptyString(pickField(rowLookup, ["last name", "lastname"]));
  return [firstName, lastName].filter(Boolean).join(" ").trim();
}

function composeImportSocials(rowLookup: Record<string, unknown>): string {
  const values: string[] = [];
  const seen = new Set<string>();

  const add = (value: unknown) => {
    const raw = toNonEmptyString(value);
    if (!raw) return;
    const parts = raw
      .split(/[\n,;|]+/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(part);
    }
  };

  add(pickField(rowLookup, ["contact socials", "social", "socials", "social links"]));
  add(pickField(rowLookup, ["contact li profile url", "contact linkedin", "linkedin", "linkedin profile"]));
  add(pickField(rowLookup, ["company li profile url", "company linkedin"]));

  return values.join(", ");
}

function composeImportLocation(rowLookup: Record<string, unknown>): string {
  const direct = toNonEmptyString(
    pickField(rowLookup, ["company location", "contact location", "location", "address"])
  );
  if (direct) return direct;

  const companyCity = toNonEmptyString(pickField(rowLookup, ["company city"]));
  const companyState = toNonEmptyString(pickField(rowLookup, ["company state", "company state abbr"]));
  const companyCountry = toNonEmptyString(
    pickField(rowLookup, ["company country", "company country (alpha 2)", "company country (alpha 3)"])
  );
  const companyLocation = [companyCity, companyState, companyCountry].filter(Boolean).join(", ");
  if (companyLocation) return companyLocation;

  const contactCity = toNonEmptyString(pickField(rowLookup, ["contact city"]));
  const contactState = toNonEmptyString(pickField(rowLookup, ["contact state", "contact state abbr"]));
  const contactCountry = toNonEmptyString(
    pickField(rowLookup, ["contact country", "contact country (alpha 2)", "contact country (alpha 3)"])
  );
  return [contactCity, contactState, contactCountry].filter(Boolean).join(", ");
}

function parseMultiValueTokens(value: unknown): string[] {
  const text = toNonEmptyString(value);
  if (!text) return [];

  const items = text
    .split(/[\n,;|/]+/g)
    .map((part) => toNonEmptyString(part))
    .filter(Boolean);

  return items.length > 0 ? items : [text];
}

function collectPhoneValues(rowLookup: Record<string, unknown>, keys: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const rawValue = rowLookup[key];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") continue;

    const tokens = parseMultiValueTokens(rawValue);
    for (const token of tokens) {
      const phone = normalizeCrmPhone(token);
      if (!phone || seen.has(phone.identity)) continue;
      seen.add(phone.identity);
      result.push(phone.raw);
    }
  }

  return result;
}

function normalizeQuadrant(value: unknown): string {
  const text = normalizeToken(toNonEmptyString(value));
  if (!text) return "";

  const compact = text.replace(/\s+/g, "");
  if (/(northwest|\bnw\b)/.test(text) || compact === "nw") return "nw";
  if (/(northeast|\bne\b)/.test(text) || compact === "ne") return "ne";
  if (/(southwest|\bsw\b)/.test(text) || compact === "sw") return "sw";
  if (/(southeast|\bse\b)/.test(text) || compact === "se") return "se";
  if (/\bnorth\b/.test(text)) return "north";
  if (/\bsouth\b/.test(text)) return "south";
  if (/\beast\b/.test(text)) return "east";
  if (/\bwest\b/.test(text)) return "west";
  if (/\b(central|centre|center|mid)\b/.test(text)) return "central";

  return text;
}

function inferQuadrantFromLocation(locationText: string): string {
  return normalizeQuadrant(locationText);
}

function resolveLeadQuadrant(rowLookup: Record<string, unknown>, companyLocation: string, contactLocation: string): string {
  const explicit = normalizeQuadrant(
    pickField(rowLookup, [
      "quadrant",
      "company quadrant",
      "contact quadrant",
      "location quadrant",
      "company location quadrant",
      "contact location quadrant",
    ])
  );
  if (explicit) return explicit;

  const fromCompanyLocation = inferQuadrantFromLocation(companyLocation);
  if (fromCompanyLocation) return fromCompanyLocation;

  return inferQuadrantFromLocation(contactLocation);
}

function normalizeCrmSpecialization(value: unknown): string {
  const text = normalizeToken(toNonEmptyString(value));
  if (!text) return "";

  const compact = text.replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
  const mapped: Record<string, string> = {
    industrial_construction: "industrial_construction",
    industrial_and_construction: "industrial_construction",
    industrial___construction: "industrial_construction",
    industrialconstruction: "industrial_construction",
    farm_equipment_sales: "farm_equipment_sales",
    farm_and_farm_equipment_sales: "farm_equipment_sales",
    farm___farm_equipment_sales: "farm_equipment_sales",
    farmfarmequipmentsales: "farm_equipment_sales",
    others: "others",
    other: "others",
  };
  const normalized = mapped[compact] || compact;
  return CRM_SPECIALIZATION_SET.has(normalized) ? normalized : "";
}

function crmSpecializationDisplayLabel(value: string): string {
  if (value === "industrial_construction") return "Industrial & Construction";
  if (value === "farm_equipment_sales") return "Farm & Farm Equipment Sales";
  if (value === "others") return "Others";
  return "";
}

function normalizeCrmSpecializations(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => normalizeCrmSpecialization(item))
        .filter(Boolean)
    )
  );
}

function normalizeCrmQuadrants(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => normalizeQuadrant(item))
        .filter(Boolean)
    )
  );
}

function resolveLeadSpecialization(
  rowLookup: Record<string, unknown>,
  input: {
    title?: string;
    companyName?: string;
    industry?: string;
    notes?: string;
    companyDescription?: string;
    website?: string;
    listItems?: string[];
  }
): string {
  const explicit = normalizeCrmSpecialization(
    pickField(rowLookup, [
      "specialization",
      "specialisation",
      "specialty",
      "speciality",
      "crm specialization",
      "crm specialisation",
    ])
  );
  if (explicit) return explicit;

  const haystack = normalizeToken(
    [
      input.title,
      input.companyName,
      input.industry,
      input.notes,
      input.companyDescription,
      input.website,
      ...(Array.isArray(input.listItems) ? input.listItems : []),
    ]
      .filter(Boolean)
      .join(" | ")
  );

  if (!haystack) return "others";

  const farmKeywords = [
    "farm",
    "farming",
    "farms",
    "agri",
    "agric",
    "tractor",
    "harvester",
    "combine",
    "sprayer",
    "seeder",
    "planter",
    "implement",
    "livestock",
  ];
  if (farmKeywords.some((keyword) => haystack.includes(keyword))) {
    return "farm_equipment_sales";
  }

  const industrialKeywords = [
    "industrial",
    "construction",
    "contractor",
    "contracting",
    "builder",
    "building",
    "manufactur",
    "fabricat",
    "engineering",
    "infrastructure",
    "mining",
    "civil",
    "electrical",
    "mechanical",
    "plumbing",
    "heavy equipment",
  ];
  if (industrialKeywords.some((keyword) => haystack.includes(keyword))) {
    return "industrial_construction";
  }

  return "others";
}

async function resolveQuadrantViaOpenAI(addressText: string): Promise<string> {
  if (!addressText.trim()) return "";
  if (!process.env.OPENAI_API_KEY) return "";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 30,
      messages: [
        {
          role: "system",
          content:
            "You are a geography assistant. Given an address or location, determine which geographic quadrant it falls in relative to the city center. " +
            "Respond with ONLY one of these values: NW, NE, SW, SE, North, South, East, West, Central. " +
            "If you cannot determine the quadrant, respond with UNKNOWN. No other text.",
        },
        {
          role: "user",
          content: `Address: ${addressText.trim()}`,
        },
      ],
    });

    const raw = (completion.choices?.[0]?.message?.content || "").trim().toLowerCase();
    const mapped: Record<string, string> = {
      nw: "nw", northwest: "nw",
      ne: "ne", northeast: "ne",
      sw: "sw", southwest: "sw",
      se: "se", southeast: "se",
      north: "north", south: "south", east: "east", west: "west",
      central: "central", centre: "central", center: "central",
    };
    return mapped[raw] || "";
  } catch (e) {
    console.error("[resolveQuadrantViaOpenAI] error for address:", addressText, e);
    return "";
  }
}

function buildImportDataSnapshot(rawRow: ExcelRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(rawRow || {})) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") continue;

    if (rawValue instanceof Date) {
      snapshot[key] = rawValue.toISOString();
      continue;
    }

    if (typeof rawValue === "string") {
      snapshot[key] = normalizeImportedText(rawValue);
      continue;
    }

    snapshot[key] = rawValue;
  }
  return snapshot;
}

function composeImportNotes(rowLookup: Record<string, unknown>): string {
  const values: string[] = [];
  const seen = new Set<string>();

  const addRaw = (value: unknown) => {
    const text = toNonEmptyString(value);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(text);
  };

  const addLabel = (label: string, candidates: string[]) => {
    const text = toNonEmptyString(pickField(rowLookup, candidates));
    if (!text) return;
    const entry = `${label}: ${text}`;
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(entry);
  };

  addRaw(pickField(rowLookup, ["notes", "note", "comments", "comment", "remarks"]));
  addLabel("Research Date", ["research date"]);
  addLabel("Department", ["department"]);
  addLabel("Seniority", ["seniority"]);
  addLabel("Company Description", ["company description", "description"]);
  addLabel("Company Annual Revenue", ["company annual revenue"]);
  addLabel("Company Revenue Range", ["company revenue range"]);
  addLabel("Company Staff Count", ["company staff count"]);
  addLabel("Company Staff Count Range", ["company staff count range"]);
  addLabel("Company Founded Date", ["company founded date"]);
  addLabel("Company Post Code", ["company post code"]);
  addLabel("SIC Code", ["sic code"]);
  addLabel("NAICS Code", ["naics code"]);

  return values.join(" | ");
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => toNonEmptyString(v)).filter(Boolean);
  }
  const txt = toNonEmptyString(value);
  if (!txt) return [];
  try {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => toNonEmptyString(v)).filter(Boolean);
    }
  } catch {
    // ignore non-json list values
  }
  return txt
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseDateValue(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }

  if (typeof value === "number") {
    return excelSerialToDate(value);
  }

  const str = toNonEmptyString(value);
  if (!str) return undefined;

  const dt = new Date(str);
  if (Number.isFinite(dt.getTime())) return dt;
  return undefined;
}

function parseImportDueDateValue(value: unknown): Date | undefined {
  const raw = toNonEmptyString(value);
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dateOnly = new Date(`${raw}T23:59:59.999Z`);
    return Number.isFinite(dateOnly.getTime()) ? dateOnly : undefined;
  }
  return parseDateValue(value);
}

function parseImportDueDateConfig(body: any): ImportDueDateConfig {
  const rowDueDates = new Map<number, Date>();
  const defaultDueDate = parseImportDueDateValue(body?.defaultDueDate || body?.dueDate || body?.importDueDate);
  const rawOverrides = body?.dueDateOverrides || body?.rowDueDates;
  if (!rawOverrides) return { defaultDueDate, rowDueDates };

  let parsed: unknown = rawOverrides;
  if (typeof rawOverrides === "string") {
    try {
      parsed = JSON.parse(rawOverrides);
    } catch {
      parsed = undefined;
    }
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const rowNumber = Number((entry as any)?.rowNumber);
      const dueDate = parseImportDueDateValue((entry as any)?.dueDate);
      if (Number.isInteger(rowNumber) && rowNumber > 1 && dueDate) {
        rowDueDates.set(rowNumber, dueDate);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rowNumber = Number(key);
      const dueDate = parseImportDueDateValue(value);
      if (Number.isInteger(rowNumber) && rowNumber > 1 && dueDate) {
        rowDueDates.set(rowNumber, dueDate);
      }
    }
  }

  return { defaultDueDate, rowDueDates };
}

function parseDateFilterBoundary(value: unknown, boundary: "start" | "end"): Date | undefined {
  const raw = toNonEmptyString(value);
  if (!raw) return undefined;
  const dt = new Date(raw);
  if (!Number.isFinite(dt.getTime())) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (boundary === "start") dt.setHours(0, 0, 0, 0);
    else dt.setHours(23, 59, 59, 999);
  }

  return dt;
}

function parseMonthQueryValues(value: unknown): number[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .flatMap((entry) => String(entry ?? "").split(","))
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry, index, source) => Number.isFinite(entry) && entry >= 1 && entry <= 12 && source.indexOf(entry) === index)
    .sort((a, b) => a - b);
}

function buildNormalizedCrmStatusExpression(statusField: string = "$status") {
  return {
    $switch: {
      branches: [
        { case: { $eq: [statusField, "new_lead"] }, then: "new_lead" },
        { case: { $eq: [statusField, "contacted"] }, then: "contacted" },
        { case: { $eq: [statusField, "inspection_required"] }, then: "inspection_required" },
        { case: { $eq: [statusField, "inspection_complete"] }, then: "inspection_complete" },
        { case: { $eq: [statusField, "proposal_submitted"] }, then: "proposal_submitted" },
        { case: { $eq: [statusField, "decision_pending"] }, then: "decision_pending" },
        { case: { $eq: [statusField, "won"] }, then: "won" },
        { case: { $eq: [statusField, "lost"] }, then: "lost" },
        { case: { $eq: [statusField, "pending"] }, then: "new_lead" },
        { case: { $eq: [statusField, "in_progress"] }, then: "contacted" },
        { case: { $eq: [statusField, "no_answer"] }, then: "contacted" },
        { case: { $eq: [statusField, "completed"] }, then: "won" },
        { case: { $eq: [statusField, "not_interested"] }, then: "lost" },
      ],
      default: "new_lead",
    },
  };
}

function buildNormalizedStatusMatch(desiredStatus: string) {
  return {
    $expr: {
      $eq: [buildNormalizedCrmStatusExpression(), desiredStatus],
    },
  };
}

function toKeyLookup(row: ExcelRow): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row || {})) {
    mapped[key.trim().toLowerCase()] = value;
  }
  return mapped;
}

function pickField(rowLookup: Record<string, unknown>, candidates: string[]): unknown {
  for (const key of candidates) {
    const value = rowLookup[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function formatCanadaPhone(raw: unknown): { raw: string; formatted: string } {
  const phone = normalizeCrmPhone(raw);
  return phone
    ? { raw: phone.raw, formatted: phone.formatted }
    : { raw: "", formatted: PHONE_FALLBACK };
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const LOCATION_ALIAS_GROUPS: string[][] = [
  ["alabama", "al"],
  ["alaska", "ak"],
  ["arizona", "az"],
  ["arkansas", "ar"],
  ["california", "ca"],
  ["colorado", "co"],
  ["connecticut", "ct"],
  ["delaware", "de"],
  ["florida", "fl"],
  ["georgia", "ga"],
  ["hawaii", "hi"],
  ["idaho", "id"],
  ["illinois", "il"],
  ["indiana", "in"],
  ["iowa", "ia"],
  ["kansas", "ks"],
  ["kentucky", "ky"],
  ["louisiana", "la"],
  ["maine", "me"],
  ["maryland", "md"],
  ["massachusetts", "ma"],
  ["michigan", "mi"],
  ["minnesota", "mn"],
  ["mississippi", "ms"],
  ["missouri", "mo"],
  ["montana", "mt"],
  ["nebraska", "ne"],
  ["nevada", "nv"],
  ["new hampshire", "nh"],
  ["new jersey", "nj"],
  ["new mexico", "nm"],
  ["new york", "ny"],
  ["north carolina", "nc"],
  ["north dakota", "nd"],
  ["ohio", "oh"],
  ["oklahoma", "ok"],
  ["oregon", "or"],
  ["pennsylvania", "pa"],
  ["rhode island", "ri"],
  ["south carolina", "sc"],
  ["south dakota", "sd"],
  ["tennessee", "tn"],
  ["texas", "tx"],
  ["utah", "ut"],
  ["vermont", "vt"],
  ["virginia", "va"],
  ["washington", "wa"],
  ["west virginia", "wv"],
  ["wisconsin", "wi"],
  ["wyoming", "wy"],
  ["district of columbia", "dc"],
  ["american samoa", "as"],
  ["guam", "gu"],
  ["northern mariana islands", "mp"],
  ["puerto rico", "pr"],
  ["u.s. virgin islands", "virgin islands", "vi"],
  ["alberta", "ab"],
  ["british columbia", "bc"],
  ["manitoba", "mb"],
  ["new brunswick", "nb"],
  ["newfoundland and labrador", "nl"],
  ["nova scotia", "ns"],
  ["ontario", "on"],
  ["prince edward island", "pe"],
  ["quebec", "qc"],
  ["saskatchewan", "sk"],
  ["northwest territories", "nt"],
  ["nunavut", "nu"],
  ["yukon", "yt"],
  ["canada"],
  ["united states", "united states of america", "usa", "us"],
];

const LOCATION_ALIAS_MAP = LOCATION_ALIAS_GROUPS.reduce<Record<string, string[]>>((acc, group) => {
  const normalizedGroup = Array.from(new Set(group.map((entry) => normalizeToken(entry)).filter(Boolean)));
  for (const entry of normalizedGroup) {
    acc[entry] = normalizedGroup;
  }
  return acc;
}, {});

const WEAK_LOCATION_TOKENS = new Set<string>([
  "canada",
  "united states",
  "united states of america",
  "usa",
  "us",
  "north",
  "south",
  "east",
  "west",
  "central",
  "nw",
  "ne",
  "sw",
  "se",
]);

function expandLocationAliases(token: string): string[] {
  const normalized = normalizeToken(token);
  if (!normalized) return [];
  return LOCATION_ALIAS_MAP[normalized] || [normalized];
}

function extractLocationCoverageTokens(...values: Array<unknown>): Set<string> {
  const tokens = new Set<string>();

  for (const value of values) {
    const raw = normalizeToken(toNonEmptyString(value));
    if (!raw) continue;

    const phraseParts = raw
      .split(/[\n,;|]+/g)
      .map((part) => normalizeToken(part))
      .filter(Boolean);

    for (const phrase of phraseParts) {
      for (const alias of expandLocationAliases(phrase)) {
        tokens.add(alias);
      }
    }

    const wordParts = raw
      .split(/[^a-z0-9]+/g)
      .map((part) => normalizeToken(part))
      .filter(Boolean);

    for (const word of wordParts) {
      for (const alias of expandLocationAliases(word)) {
        tokens.add(alias);
      }
    }
  }

  return tokens;
}

function locationCoverageScore(
  leadValues: Array<unknown>,
  userValues: Array<unknown>
): number {
  const leadTokens = extractLocationCoverageTokens(...leadValues);
  const userTokens = extractLocationCoverageTokens(...userValues);

  if (leadTokens.size === 0 || userTokens.size === 0) return 3;

  let hasAnyOverlap = false;
  for (const token of leadTokens) {
    if (!userTokens.has(token)) continue;
    hasAnyOverlap = true;
    if (!WEAK_LOCATION_TOKENS.has(token)) {
      return 0;
    }
  }

  return hasAnyOverlap ? 1 : 3;
}

function normalizePhoneForIdentity(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

function parseListItems(value: unknown): ParsedListItems {
  if (value === undefined || value === null || value === "") {
    return { original: [], normalized: [], hasInlineDuplicates: false };
  }

  let candidates: string[] = [];

  if (Array.isArray(value)) {
    candidates = value.map((v) => toNonEmptyString(v));
  } else {
    const text = toNonEmptyString(value);
    if (!text) return { original: [], normalized: [], hasInlineDuplicates: false };

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        candidates = parsed.map((v) => toNonEmptyString(v));
      }
    } catch {
      // ignore non-json list values
    }

    if (candidates.length === 0) {
      candidates = text
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }

  const original: string[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  let hasInlineDuplicates = false;

  for (const item of candidates) {
    const cleaned = toNonEmptyString(item);
    if (!cleaned) continue;

    const key = normalizeToken(cleaned);
    if (!key) continue;

    if (seen.has(key)) {
      hasInlineDuplicates = true;
      continue;
    }

    seen.add(key);
    original.push(cleaned);
    normalized.push(key);
  }

  return { original, normalized, hasInlineDuplicates };
}

function buildIdentityKey(input: {
  email?: string;
  phoneRaw?: string;
  clientName: string;
  companyName?: string;
}): string {
  const emailKey = normalizeToken(input.email || "");
  if (emailKey) return `email:${emailKey}`;

  const phoneKey = normalizePhoneForIdentity(input.phoneRaw || "");
  if (phoneKey) return `phone:${phoneKey}`;

  const clientKey = normalizeToken(input.clientName || "") || "unknown-client";
  const companyKey = normalizeToken(input.companyName || "") || "unknown-company";
  return `name:${clientKey}|company:${companyKey}`;
}

function buildDedupeFingerprints(identityKey: string, listItemsNormalized: string[]): string[] {
  const listKeys = listItemsNormalized.length > 0 ? listItemsNormalized : ["__no_list__"];
  return listKeys.map((listKey) => `${identityKey}::${listKey}`);
}

function addRowIssue(issueMap: Map<number, string[]>, rowNumber: number, reason: string): void {
  const reasons = issueMap.get(rowNumber) || [];
  reasons.push(reason);
  issueMap.set(rowNumber, reasons);
}

function uniqueReasons(values: string[]): string[] {
  return Array.from(new Set(values));
}

function quadrantDistanceScore(leadQuadrant: string, userQuadrant: string): number {
  if (!leadQuadrant || !userQuadrant) return 3;
  if (leadQuadrant === userQuadrant) return 0;

  const pointMap: Record<string, [number, number]> = {
    nw: [-1, 1],
    ne: [1, 1],
    sw: [-1, -1],
    se: [1, -1],
  };

  const leadPoint = pointMap[leadQuadrant];
  const userPoint = pointMap[userQuadrant];
  if (leadPoint && userPoint) {
    const dx = Math.abs(leadPoint[0] - userPoint[0]);
    const dy = Math.abs(leadPoint[1] - userPoint[1]);
    return dx + dy;
  }

  if (leadQuadrant === "central" || userQuadrant === "central") return 1;

  if (leadQuadrant.includes(userQuadrant) || userQuadrant.includes(leadQuadrant)) return 1;
  return 2;
}

function chooseAssigneeForLead(
  leadQuadrant: string,
  leadSpecialization: string,
  leadCoverageValues: Array<unknown>,
  crmUsers: any[],
  assigneeLoadMap: Map<string, number>
): any {
  const specializationPool = leadSpecialization
    ? crmUsers.filter((user) => normalizeCrmSpecializations((user as any)?.crmSpecializations).includes(leadSpecialization))
    : [];
  const assignmentPool = specializationPool.length > 0 ? specializationPool : crmUsers;

  let bestScore = Number.POSITIVE_INFINITY;
  let bestLocationScore = Number.POSITIVE_INFINITY;
  const candidates: any[] = [];

  for (const user of assignmentPool) {
    const userQuadrants = normalizeCrmQuadrants((user as any)?.crmQuadrant);
    const score = userQuadrants.length
      ? Math.min(...userQuadrants.map((userQuadrant) => quadrantDistanceScore(leadQuadrant, userQuadrant)))
      : quadrantDistanceScore(leadQuadrant, "");
    const userLocationScore = locationCoverageScore(leadCoverageValues, [
      (user as any)?.crmAddress,
    ]);

    if (score < bestScore || (score === bestScore && userLocationScore < bestLocationScore)) {
      bestScore = score;
      bestLocationScore = userLocationScore;
      candidates.length = 0;
      candidates.push(user);
    } else if (score === bestScore && userLocationScore === bestLocationScore) {
      candidates.push(user);
    }
  }

  const fallback = assignmentPool[0] || crmUsers[0];
  if (candidates.length === 0) return fallback;

  let chosen = candidates[0];
  let minLoad = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateId = String((candidate as any)?._id || "");
    const load = assigneeLoadMap.get(candidateId) || 0;
    if (load < minLoad) {
      minLoad = load;
      chosen = candidate;
      continue;
    }

    if (load === minLoad) {
      const chosenId = String((chosen as any)?._id || "");
      if (candidateId && chosenId && candidateId < chosenId) {
        chosen = candidate;
      }
    }
  }

  return chosen;
}

function buildLeadDoc(
  draft: ParsedImportDraft,
  assignedTo: any,
  assignedBy: any,
  sourceBatchId: string,
  sourceFileName: string | undefined,
  sourceSheetName: string,
  quadrantPending: boolean,
  assignment?: CrmAssignmentChoice
): Record<string, any> {
  const createdAt = new Date();
  return {
    title: draft.title,
    clientName: draft.clientName,
    companyName: draft.companyName,
    email: draft.email,
    phoneRaw: draft.phoneRaw,
    phoneFormatted: draft.phoneFormatted,
    contactPhones: draft.contactPhones,
    companyPhones: draft.companyPhones,
    contactMobilePhones: draft.contactMobilePhones,
    notes: draft.notes,
    contactSocials: draft.contactSocials,
    contactLocation: draft.contactLocation,
    contactLinkedinUrl: draft.contactLinkedinUrl,
    companyLinkedinUrl: draft.companyLinkedinUrl,
    companyLocation: draft.companyLocation,
    quadrant: draft.quadrant,
    specialization: draft.specialization,
    category: draft.category || draft.specialization,
    quadrantPending,
    industry: draft.industry,
    website: draft.website,
    companyWebsiteDomain: draft.companyWebsiteDomain,
    researchDate: draft.researchDate,
    department: draft.department,
    seniority: draft.seniority,
    companyDescription: draft.companyDescription,
    companyAnnualRevenue: draft.companyAnnualRevenue,
    companyRevenueRange: draft.companyRevenueRange,
    companyStaffCount: draft.companyStaffCount,
    companyStaffCountRange: draft.companyStaffCountRange,
    companyFoundedDate: draft.companyFoundedDate,
    companyPostCode: draft.companyPostCode,
    leadGeo: assignment?.leadGeo,
    assignedUserGeo: assignment?.assigneeGeo,
    assignmentMethod: assignment?.method,
    assignmentDistanceKm: assignment?.distanceKm,
    assignmentMatchedRegion: assignment?.matchedRegion,
    assignmentReason: assignment?.reason,
    sicCode: draft.sicCode,
    naicsCode: draft.naicsCode,
    importData: draft.importData,
    listItems: draft.listItems,
    listItemsNormalized: draft.listItemsNormalized,
    identityKey: draft.identityKey,
    dedupeFingerprints: draft.dedupeFingerprints,
    sourceBatchId,
    sourceFileName,
    sourceSheetName,
    sourceRowNumber: draft.rowNumber,
    leadSource: "generic",
    assignedTo,
    assignedBy,
    status: "new_lead",
    statusChangedAt: createdAt,
    taskStartDate: createdAt,
    dueDate: draft.dueDate,
    priority: draft.priority,
  };
}

type CrmLeadSourceCounts = {
  total: number;
  generic: number;
  organic: number;
};

function buildCrmLeadSourceExpression() {
  return {
    $cond: [
      {
        $or: [
          { $eq: ["$leadSource", "organic"] },
          { $regexMatch: { input: { $ifNull: ["$title", ""] }, regex: /^Quick Add/i } },
        ],
      },
      "organic",
      "generic",
    ],
  };
}

async function getCrmLeadSourceCounts(filter: Record<string, any>): Promise<CrmLeadSourceCounts> {
  const rows = await CrmLead.aggregate([
    { $match: normalizeCrmAggregateMatchFilter(filter) },
    {
      $group: {
        _id: buildCrmLeadSourceExpression(),
        count: { $sum: 1 },
      },
    },
  ]);

  const counts: CrmLeadSourceCounts = { total: 0, generic: 0, organic: 0 };
  for (const row of rows as Array<{ _id?: string; count?: number }>) {
    const key = row?._id === "organic" ? "organic" : "generic";
    const count = Number(row?.count || 0);
    counts[key] += count;
    counts.total += count;
  }

  return counts;
}

function normalizeCrmAggregateMatchFilter(filter: Record<string, any>): Record<string, any> {
  const match = { ...(filter || {}) };
  if (
    typeof match.assignedTo === "string" &&
    mongoose.Types.ObjectId.isValid(match.assignedTo)
  ) {
    match.assignedTo = new mongoose.Types.ObjectId(match.assignedTo);
  }
  return match;
}

async function createQuickCrmLead(input: {
  assignedTo: string;
  assignedBy: string;
  name: unknown;
  phone: unknown;
  notes?: unknown;
  category?: unknown;
  specialization?: unknown;
  dueDate?: unknown;
  reviewSelfCapture?: boolean;
}) {
  const clientName = toNonEmptyString(input.name);
  const phoneInput = toNonEmptyString(input.phone);
  const notes = toNonEmptyString(input.notes);
  const specialization = normalizeCrmSpecialization(input.specialization || input.category);
  const specializationLabel = crmSpecializationDisplayLabel(specialization);
  const category = toNonEmptyString(input.category) || specializationLabel;
  const dueDate = parseDateValue(input.dueDate);

  if (!clientName) throw new Error("Name is required");
  if (!phoneInput) throw new Error("Phone number is required");
  if (!specialization || !category) throw new Error("CRM specialization is required");

  const assignee = await User.findOne({
    _id: input.assignedTo,
    role: "user",
    isBlocked: { $ne: true },
    isCrmAgent: true,
    ...(input.reviewSelfCapture ? {} : normalCrmUserFilter()),
  }).select("_id email username expoPushTokens isReviewAccount");
  if (!assignee) throw new Error("Select an active CRM agent");
  if (isReviewAccount(assignee) && (!input.reviewSelfCapture || input.assignedTo !== input.assignedBy)) {
    throw new Error("Select an active CRM agent");
  }

  const phoneInfo = formatCanadaPhone(phoneInput);
  const listItems = [category];
  const listItemsNormalized = parseListItems(category).normalized;
  const identityKey = buildIdentityKey({
    phoneRaw: phoneInfo.raw,
    clientName,
    companyName: category,
  });

  const createdAt = new Date();
  const lead = await CrmLead.create({
    isReviewData: isReviewAccount(assignee),
    title: `Quick Add - ${category}`,
    clientName,
    phoneRaw: phoneInfo.raw || phoneInput,
    phoneFormatted: phoneInfo.formatted || phoneInput,
    notes: notes || undefined,
    latestComment: notes || undefined,
    category,
    specialization,
    listItems,
    listItemsNormalized,
    identityKey,
    dedupeFingerprints: buildDedupeFingerprints(identityKey, listItemsNormalized),
    leadSource: "organic",
    assignedTo: assignee._id,
    assignedBy: input.assignedBy,
    status: "new_lead",
    statusChangedAt: createdAt,
    taskStartDate: createdAt,
    dueDate,
    priority: "medium",
  });

  await sendCrmNewTaskNotification({
    userId: String((assignee as any)._id),
    leadId: String((lead as any)._id),
    clientName,
    title: String((lead as any).title || "Quick Add"),
    count: 1,
    reason: "assignment",
  }).catch((err) => {
    console.error("createQuickCrmLead notification error", err);
  });

  return loadLeadWithUpdatesForResponse(String((lead as any)._id), isReviewAccount(assignee));
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

async function uploadCrmFile(file: Express.Multer.File, folder: string): Promise<string> {
  const uploaded = await uploadCrmFileWithKey(file, folder);
  return uploaded.url;
}

async function uploadCrmFileWithKey(
  file: Express.Multer.File,
  folder: string
): Promise<{ url: string; key: string }> {
  const storage = getCurrentR2StorageTarget();
  if (!storage.bucketName) {
    throw new Error("R2_BUCKET_NAME is required for CRM attachments");
  }
  const safe = sanitizeFileName(file.originalname || "file");
  const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${safe}`;
  const url = await uploadToR2(file, storage.bucketName, key);
  return { url, key };
}

async function uploadCrmImportSource(
  file: Express.Multer.File,
  folder: string
): Promise<{
  url: string;
  key: string;
  sourceFileBucket: string;
  sourceFilePublicBaseUrl: string;
}> {
  if (!file.path) {
    throw new Error("CRM import file was not persisted to temporary storage");
  }
  const storage = snapshotCurrentCrmImportStorage();
  if (!storage.sourceFileBucket) {
    throw new Error("R2_BUCKET_NAME is required for CRM imports");
  }
  const safe = sanitizeFileName(file.originalname || "crm-import.xlsx");
  const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${safe}`;
  const url = await uploadFilePathToR2(
    file.path,
    file.mimetype || "application/octet-stream",
    storage.sourceFileBucket,
    key,
    file.size
  );
  return { url, key, ...storage };
}

type CrmImportAssignmentContext = {
  crmUsers: any[];
  preparedAssignees: PreparedCrmAssignee[];
  assigneeLoadMap: Map<string, number>;
};

/**
 * Prepare assignment data once for a bulk import. Reusing this context across
 * batches avoids repeating user, geo, and CRM load queries for every batch.
 */
async function createCrmImportAssignmentContext(
  selectedUserIds: string[]
): Promise<CrmImportAssignmentContext> {
  if (selectedUserIds.length && await User.exists({ _id: { $in: selectedUserIds }, isReviewAccount: true })) {
    throw new Error("Review accounts cannot receive production CRM imports");
  }
  const crmUserFilter: Record<string, any> = {
    role: "user",
    isBlocked: { $ne: true },
    isCrmAgent: true,
    ...normalCrmUserFilter(),
  };
  if (selectedUserIds.length > 0) {
    crmUserFilter._id = { $in: selectedUserIds };
  }

  const crmUsers = await User.find(crmUserFilter).select(
    "_id email username isCrmAgent crmAddress crmQuadrant crmSpecializations expoPushTokens isReviewAccount"
  );
  if (crmUsers.length === 0) {
    throw new Error("No active CRM users available for assignment");
  }

  const assigneeLoadMap = new Map<string, number>();
  const existingLoadCounts = await CrmLead.aggregate([
    { $match: { assignedTo: { $in: crmUsers.map((user) => (user as any)._id) }, isReviewData: { $ne: true } } },
    { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
  ]);
  for (const entry of existingLoadCounts) {
    assigneeLoadMap.set(String(entry._id), Number(entry.count || 0));
  }

  return {
    crmUsers: crmUsers as any[],
    preparedAssignees: await prepareCrmAssignees(crmUsers as any[]),
    assigneeLoadMap,
  };
}

async function assignAndInsertCrmDrafts(input: {
  parsedDrafts: ParsedImportDraft[];
  selectedUserIds: string[];
  assignedBy: any;
  sourceBatchId: string;
  sourceFileName?: string;
  sourceFileUrl?: string;
  sourceFileKey?: string;
  sourceFileBucket?: string;
  sourceFilePublicBaseUrl?: string;
  sourceSheetName: string;
  rowIssues?: Map<number, string[]>;
  notifyReason?: "assignment" | "reassignment";
  failOnDuplicate?: boolean;
  insertMode?: "bulk" | "incremental";
  geoMode?: "full" | "heuristic";
  notifyAssignments?: boolean;
  assignmentContext?: CrmImportAssignmentContext;
  onProgress?: (state: {
    processedRows: number;
    importedCount: number;
    duplicateCount: number;
    errorCount: number;
    totalRows: number;
    message?: string;
  }) => Promise<void> | void;
}): Promise<{
  inserted: any[];
  duplicateRows: Array<{ rowNumber: number; reasons: string[] }>;
  duplicateCount: number;
  quadrantPendingCount: number;
  errorCount: number;
  assignedUsers: Array<{ _id: any; email?: string; username?: string }>;
  aborted?: boolean;
}> {
  const assignmentContext =
    input.assignmentContext || (await createCrmImportAssignmentContext(input.selectedUserIds));
  const crmUsers = assignmentContext.crmUsers;

  const parsedDrafts = input.parsedDrafts;
  const rowIssues = input.rowIssues || new Map<number, string[]>();

  const seenIdentityRow = new Map<string, number>();
  const seenFingerprintRow = new Map<string, number>();
  for (const draft of parsedDrafts) {
    const firstIdentityRow = seenIdentityRow.get(draft.identityKey);
    if (typeof firstIdentityRow === "number") {
      addRowIssue(rowIssues, draft.rowNumber, `Duplicate lead already appears in row ${firstIdentityRow}`);
    } else {
      seenIdentityRow.set(draft.identityKey, draft.rowNumber);
    }

    for (const fingerprint of draft.dedupeFingerprints) {
      const firstRow = seenFingerprintRow.get(fingerprint);
      if (typeof firstRow === "number") {
        addRowIssue(rowIssues, draft.rowNumber, `Duplicate list/lead combination already appears in row ${firstRow}`);
        continue;
      }
      seenFingerprintRow.set(fingerprint, draft.rowNumber);
    }
  }

  const allFingerprints = Array.from(new Set(parsedDrafts.flatMap((draft) => draft.dedupeFingerprints)));
  const allIdentityKeys = Array.from(new Set(parsedDrafts.map((draft) => draft.identityKey).filter(Boolean)));
  const allSourceRowNumbers = Array.from(
    new Set(parsedDrafts.map((draft) => draft.rowNumber).filter((rowNumber) => Number.isFinite(rowNumber)))
  );
  const currentSourceRowNumberSet = new Set(allSourceRowNumbers);
  const alreadyImportedSourceRows = new Set<number>();
  const existingIdentityKeySet = new Set<string>();
  const existingFingerprintSet = new Set<string>();
  const chunkSize = 500;

  // A durable import may restart after batches committed. Those rows are
  // successful work from this job and must not be inserted a second time.
  for (let index = 0; index < allSourceRowNumbers.length; index += chunkSize) {
    const chunk = allSourceRowNumbers.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const existing = await CrmLead.find(
      { sourceBatchId: input.sourceBatchId, sourceRowNumber: { $in: chunk }, isReviewData: { $ne: true } },
      { sourceRowNumber: 1 }
    ).lean();
    for (const lead of existing) {
      const sourceRowNumber = Number((lead as any).sourceRowNumber);
      if (Number.isFinite(sourceRowNumber)) alreadyImportedSourceRows.add(sourceRowNumber);
    }
  }

  for (let index = 0; index < allIdentityKeys.length; index += chunkSize) {
    const chunk = allIdentityKeys.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const existing = await CrmLead.find(
      { identityKey: { $in: chunk }, isReviewData: { $ne: true } },
      { identityKey: 1, sourceBatchId: 1, sourceRowNumber: 1 }
    ).lean();
    for (const lead of existing) {
      const identityKey = toNonEmptyString((lead as any).identityKey);
      const isCommittedRetryRow =
        toNonEmptyString((lead as any).sourceBatchId) === input.sourceBatchId &&
        currentSourceRowNumberSet.has(Number((lead as any).sourceRowNumber));
      if (identityKey && !isCommittedRetryRow) existingIdentityKeySet.add(identityKey);
    }
  }

  for (let index = 0; index < allFingerprints.length; index += chunkSize) {
    const chunk = allFingerprints.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const existing = await CrmLead.find(
      { dedupeFingerprints: { $in: chunk }, isReviewData: { $ne: true } },
      { dedupeFingerprints: 1, sourceBatchId: 1, sourceRowNumber: 1 }
    ).lean();
    for (const lead of existing) {
      const isCommittedRetryRow =
        toNonEmptyString((lead as any).sourceBatchId) === input.sourceBatchId &&
        currentSourceRowNumberSet.has(Number((lead as any).sourceRowNumber));
      if (isCommittedRetryRow) continue;
      const values = Array.isArray((lead as any).dedupeFingerprints)
        ? ((lead as any).dedupeFingerprints as string[])
        : [];
      for (const value of values) {
        if (value) existingFingerprintSet.add(value);
      }
    }
  }

  const docs: Array<Record<string, any>> = [];
  const inserted: any[] = [];
  const taskAssignmentsByUser = new Map<string, Array<{ title: string; clientName: string; dueDate?: Date }>>();
  const duplicateRows: Array<{ rowNumber: number; reasons: string[] }> = [];
  const acceptedDrafts: typeof parsedDrafts = [];
  let processedRows = 0;
  let errorCount = 0;
  const reportProgress = async (message?: string) => {
    if (!input.onProgress) return;
    await input.onProgress({
      processedRows,
      importedCount: inserted.length,
      duplicateCount: duplicateRows.length,
      errorCount,
      totalRows: parsedDrafts.length,
      message,
    });
  };
  const assigneeLoadMap = assignmentContext.assigneeLoadMap;

  for (const draft of parsedDrafts) {
    if (alreadyImportedSourceRows.has(draft.rowNumber)) continue;

    const reasons = rowIssues.get(draft.rowNumber) ? [...(rowIssues.get(draft.rowNumber) as string[])] : [];
    if (existingIdentityKeySet.has(draft.identityKey)) reasons.push("Lead already exists in CRM");
    if (draft.dedupeFingerprints.some((fingerprint) => existingFingerprintSet.has(fingerprint))) {
      reasons.push("Lead/list combination already exists in CRM");
    }

    if (reasons.length > 0) {
      duplicateRows.push({ rowNumber: draft.rowNumber, reasons: uniqueReasons(reasons) });
      continue;
    }

    existingIdentityKeySet.add(draft.identityKey);
    for (const fingerprint of draft.dedupeFingerprints) {
      existingFingerprintSet.add(fingerprint);
    }

    acceptedDrafts.push(draft);
  }

  const assignedUsers = crmUsers.map((u) => ({
    _id: u._id,
    email: toNonEmptyString((u as any).email) || undefined,
    username: toNonEmptyString((u as any).username) || undefined,
    crmAddress: toNonEmptyString((u as any).crmAddress) || undefined,
  }));

  if (input.failOnDuplicate && duplicateRows.length > 0) {
    return {
      inserted: [],
      duplicateRows,
      duplicateCount: duplicateRows.length,
      quadrantPendingCount: 0,
      errorCount,
      assignedUsers,
      aborted: true,
    };
  }

  const preparedAssignees = assignmentContext.preparedAssignees;

  const pushAssignedDoc = async (draft: ParsedImportDraft) => {
    const geoSource = buildLeadGeoSource({
      companyLocation: draft.companyLocation,
      contactLocation: draft.contactLocation,
      companyPostCode: draft.companyPostCode,
    });
    const leadGeo =
      input.geoMode === "heuristic"
        ? normalizeCrmGeoLocationHeuristic(geoSource)
        : await normalizeCrmGeoLocation(geoSource);
    const assignment = chooseNearestCrmAssignee({
      leadGeo,
      leadSpecialization: normalizeCrmSpecialization(draft.specialization),
      assignees: preparedAssignees,
      assigneeLoadMap,
    });
    const assignee = assignment.assignee;
    const assigneeId = String((assignee as any)?._id || "");

    const quadrantPending = !assignment.leadGeo.regionCode && assignment.leadGeo.lat === undefined && assignment.leadGeo.lng === undefined;
    const doc = buildLeadDoc(
      draft,
      assignee._id,
      input.assignedBy,
      input.sourceBatchId,
      input.sourceFileName,
      input.sourceSheetName,
      quadrantPending,
      assignment
    );
    if (input.sourceFileUrl) doc.sourceFileUrl = input.sourceFileUrl;
    if (input.sourceFileKey) doc.sourceFileKey = input.sourceFileKey;
    if (input.sourceFileBucket) doc.sourceFileBucket = input.sourceFileBucket;
    if (input.sourceFilePublicBaseUrl) {
      doc.sourceFilePublicBaseUrl = input.sourceFilePublicBaseUrl;
    }
    if (input.insertMode === "incremental") {
      const [created] = await CrmLead.insertMany([doc]);
      inserted.push(created);
    } else {
      docs.push(doc);
    }
    if (assigneeId) {
      assigneeLoadMap.set(assigneeId, (assigneeLoadMap.get(assigneeId) || 0) + 1);
      const bucket = taskAssignmentsByUser.get(assigneeId) || [];
      bucket.push({ title: draft.title, clientName: draft.clientName, dueDate: draft.dueDate });
      taskAssignmentsByUser.set(assigneeId, bucket);
    }
  };

  for (const draft of acceptedDrafts) {
    try {
      await pushAssignedDoc(draft);
    } catch (e) {
      errorCount += 1;
      console.error("assignAndInsertCrmDrafts row import error", e);
    } finally {
      processedRows += 1;
      await reportProgress(`Processed ${processedRows} of ${acceptedDrafts.length} ready rows`);
    }
  }

  if (input.insertMode !== "incremental" && docs.length === 0) {
    return {
      inserted: [],
      duplicateRows,
      duplicateCount: duplicateRows.length,
      quadrantPendingCount: 0,
      errorCount,
      assignedUsers,
    };
  }

  if (input.insertMode !== "incremental") {
    inserted.push(...(await CrmLead.insertMany(docs)));
  }

  if (input.notifyAssignments !== false && taskAssignmentsByUser.size > 0) {
    const settled = await Promise.allSettled(
      Array.from(taskAssignmentsByUser.entries()).map(async ([userId, tasks]) => {
        const targetUser = crmUsers.find((u) => String((u as any)?._id || "") === userId);
        if (!targetUser) return;

        if (targetUser.email) {
          await sendCrmTasksAssignedEmail(
            {
              email: targetUser.email,
              username: targetUser.username || undefined,
            },
            tasks
          );
        }

        const singleAssignedLead =
          tasks.length === 1 ? inserted.find((doc: any) => String((doc as any)?.assignedTo || "") === userId) : null;

        await sendCrmNewTaskNotification({
          userId,
          tokens: ((targetUser as any).expoPushTokens || []) as string[],
          leadId: singleAssignedLead ? String((singleAssignedLead as any)?._id || "") : undefined,
          clientName: toNonEmptyString((singleAssignedLead as any)?.clientName || tasks[0]?.clientName || ""),
          title: toNonEmptyString((singleAssignedLead as any)?.title || tasks[0]?.title || ""),
          count: tasks.length,
          reason: input.notifyReason || "assignment",
        }).catch((err) => {
          console.error("assignAndInsertCrmDrafts task assignment push error", err);
        });
      })
    );

    for (const result of settled) {
      if (result.status === "rejected") {
        console.error("assignAndInsertCrmDrafts task assignment email error", result.reason);
      }
    }
  }

  const pendingLeadIds = inserted.filter((doc: any) => doc.quadrantPending === true).map((doc: any) => String(doc._id));

  return {
    inserted,
    duplicateRows,
    duplicateCount: duplicateRows.length,
    quadrantPendingCount: pendingLeadIds.length,
    errorCount,
    assignedUsers,
  };
}

function normalizeCountry(value: unknown): CrmAutoFindCountry | "" {
  const text = toNonEmptyString(value).toLowerCase();
  if (text === "canada" || text === "ca") return "Canada";
  if (text === "united states" || text === "us" || text === "usa" || text === "u.s.") return "United States";
  return "";
}

function normalizeAllowedList(values: unknown, allowed: readonly string[]): string[] {
  const allowedMap = new Map(allowed.map((value) => [normalizeToken(value), value]));
  const raw = parseStringArray(values);
  return Array.from(
    new Set(
      raw
        .map((value) => allowedMap.get(normalizeToken(value)))
        .filter((value): value is string => Boolean(value))
    )
  );
}

function normalizeAutoFindRegions(country: CrmAutoFindCountry, values: unknown): string[] {
  return normalizeAllowedList(values, country === "Canada" ? CANADA_PROVINCES : US_STATES);
}

function normalizeAutoFindCategories(values: unknown): string[] {
  return normalizeAllowedList(values, allowedCategories);
}

function isWebSearchBillingOrLimitError(error: any): boolean {
  const status = Number(error?.status || error?.response?.status || error?.code || 0);
  const text = [
    error?.message,
    error?.error?.message,
    error?.response?.data?.message,
    error?.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    status === 402 ||
    status === 429 ||
    text.includes("quota") ||
    text.includes("billing") ||
    text.includes("rate limit") ||
    text.includes("insufficient_quota")
  );
}

async function getCrmAutoFindExclusionFingerprints(): Promise<string[]> {
  const existingCrmLeads = await CrmLead.find({ isReviewData: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(1000)
    .select("identityKey dedupeFingerprints companyName website companyWebsiteDomain companyLocation")
    .lean();
  const crmExclusionSet = new Set<string>();
  for (const lead of existingCrmLeads) {
    const identityKey = toNonEmptyString((lead as any).identityKey);
    if (identityKey) crmExclusionSet.add(identityKey);

    const fingerprints = Array.isArray((lead as any).dedupeFingerprints)
      ? ((lead as any).dedupeFingerprints as string[])
      : [];
    for (const fingerprint of fingerprints) {
      const value = toNonEmptyString(fingerprint);
      if (value) crmExclusionSet.add(value);
    }

    const autoFindFingerprint = buildAutoFindFingerprint({
      companyName: toNonEmptyString((lead as any).companyName),
      website: toNonEmptyString((lead as any).website) || toNonEmptyString((lead as any).companyWebsiteDomain),
      companyLocation: toNonEmptyString((lead as any).companyLocation),
    });
    if (autoFindFingerprint) crmExclusionSet.add(autoFindFingerprint);
  }
  return Array.from(crmExclusionSet).slice(0, 500);
}

async function buildAndSaveAutoFindItems(input: {
  found: CrmAutoFindLeadResult[];
  searchMeta: Record<string, unknown>;
  country: CrmAutoFindCountry;
  regions: string[];
  categories: string[];
  keywords: string;
  foundBy?: string;
}) {
  const { found, searchMeta, country, regions, categories, keywords, foundBy } = input;
  const drafts = found.map((lead, index) => autoFindLeadToDraft(lead, index + 1, searchMeta));
  const duplicateState = await getDuplicateStateForDrafts(drafts);
  const items: any[] = [];

  for (let index = 0; index < found.length; index += 1) {
    const lead = found[index];
    const draft = drafts[index];
    const fingerprint = buildAutoFindFingerprint({
      companyName: lead.companyName,
      website: lead.website,
      sourceUrl: lead.sourceUrl,
      companyLocation: lead.companyLocation,
    });
    const duplicateReasons = uniqueReasons(duplicateState.get(draft.rowNumber) || []);

    const saved = await CrmAutoFindLead.findOneAndUpdate(
      { fingerprint },
      {
        $set: {
          identityKey: draft.identityKey,
          country,
          regions,
          categories,
          keywords,
          lead,
          sourceUrl: lead.sourceUrl,
          sourceTitle: lead.sourceTitle,
          sourcePlatform: lead.sourcePlatform,
          confidence: lead.confidence,
          searchQuery: lead.queryUsed,
          foundBy,
        },
        $setOnInsert: {
          fingerprint,
          status: "previewed",
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    items.push({
      searchResultId: String((saved as any)?._id || ""),
      fingerprint,
      duplicate: duplicateReasons.length > 0,
      duplicateReasons,
      lead,
      draftPreview: {
        rowNumber: draft.rowNumber,
        clientName: draft.clientName,
        companyName: draft.companyName,
        email: draft.email,
        phoneRaw: draft.phoneRaw,
        website: draft.website,
        companyLocation: draft.companyLocation,
        industry: draft.industry,
        specialization: draft.specialization,
        notes: draft.notes,
        listItems: draft.listItems,
      },
    });
  }

  return {
    items,
    rawJson: { leads: found, searchMeta },
    searched: found.length,
    duplicateCount: items.filter((item) => item.duplicate).length,
  };
}

function composeAutoFindNotes(lead: CrmAutoFindLeadResult, searchMeta: Record<string, unknown>): string {
  const parts = [
    lead.evidence ? `Evidence: ${lead.evidence}` : "",
    lead.sourceTitle ? `Source: ${lead.sourceTitle}` : "",
    lead.sourceUrl ? `URL: ${lead.sourceUrl}` : "",
    lead.sourcePlatform ? `Platform: ${lead.sourcePlatform}` : "",
    lead.confidence ? `Confidence: ${Math.round(lead.confidence * 100)}%` : "",
    `Auto Find Search: ${JSON.stringify(searchMeta)}`,
  ].filter(Boolean);
  return parts.join(" | ");
}

function autoFindLeadToDraft(
  lead: CrmAutoFindLeadResult,
  rowNumber: number,
  searchMeta: Record<string, unknown>
): ParsedImportDraft {
  const rowLookup: Record<string, unknown> = {
    "crm specialization": lead.suggestedSpecialization,
    industry: lead.industry,
    website: lead.website,
    notes: lead.evidence,
  };
  const phoneInfo = formatCanadaPhone(lead.phoneRaw);
  const companyName = toNonEmptyString(lead.companyName);
  const clientName = toNonEmptyString(lead.clientName) || companyName || "Auto-found CRM lead";
  const listItems = Array.from(new Set(["Auto Find", ...lead.categories].filter(Boolean)));
  const listItemsNormalized = listItems.map((item) => normalizeToken(item)).filter(Boolean);
  const specialization =
    normalizeCrmSpecialization(lead.suggestedSpecialization) ||
    resolveLeadSpecialization(rowLookup, {
      title: "CRM Auto Find Client",
      companyName,
      industry: lead.industry,
      notes: lead.evidence,
      website: lead.website,
      listItems,
    });
  const identityKey = buildIdentityKey({
    email: lead.email,
    phoneRaw: phoneInfo.raw,
    clientName,
    companyName,
  });
  const companyLocation = toNonEmptyString(lead.companyLocation);
  const contactLocation = toNonEmptyString(lead.contactLocation);
  const quadrant = resolveLeadQuadrant({}, companyLocation, contactLocation);

  return {
    rowNumber,
    title: "CRM Auto Find Client",
    clientName,
    companyName: companyName || undefined,
    email: extractPrimaryEmail(lead.email) || undefined,
    phoneRaw: phoneInfo.raw || undefined,
    phoneFormatted: phoneInfo.formatted || undefined,
    contactPhones: phoneInfo.raw ? [phoneInfo.raw] : [],
    companyPhones: [],
    contactMobilePhones: [],
    notes: composeAutoFindNotes(lead, searchMeta),
    contactSocials: lead.contactSocials || undefined,
    contactLocation: contactLocation || undefined,
    contactLinkedinUrl: lead.contactLinkedinUrl || undefined,
    companyLinkedinUrl: lead.companyLinkedinUrl || undefined,
    companyLocation: companyLocation || undefined,
    quadrant: quadrant || undefined,
    specialization: specialization || undefined,
    industry: lead.industry || undefined,
    website: lead.website || lead.sourceUrl || undefined,
    companyWebsiteDomain: lead.website || undefined,
    researchDate: new Date(),
    companyDescription: lead.evidence || undefined,
    importData: {
      source: "crm_auto_find",
      sourceUrl: lead.sourceUrl,
      sourceTitle: lead.sourceTitle,
      sourcePlatform: lead.sourcePlatform,
      confidence: lead.confidence,
      categories: lead.categories,
      searchMeta,
      queryUsed: lead.queryUsed,
    },
    listItems,
    listItemsNormalized,
    identityKey,
    dedupeFingerprints: buildDedupeFingerprints(identityKey, listItemsNormalized),
    priority: lead.confidence >= 0.75 ? "high" : "medium",
  };
}

async function getDuplicateStateForDrafts(drafts: ParsedImportDraft[]): Promise<Map<number, string[]>> {
  const rowIssues = new Map<number, string[]>();
  const identityKeys = Array.from(new Set(drafts.map((draft) => draft.identityKey).filter(Boolean)));
  const fingerprints = Array.from(new Set(drafts.flatMap((draft) => draft.dedupeFingerprints)));

  if (identityKeys.length > 0) {
    const existing = await CrmLead.find({ identityKey: { $in: identityKeys }, isReviewData: { $ne: true } }, { identityKey: 1 }).lean();
    const existingSet = new Set(existing.map((lead) => toNonEmptyString((lead as any).identityKey)).filter(Boolean));
    for (const draft of drafts) {
      if (existingSet.has(draft.identityKey)) addRowIssue(rowIssues, draft.rowNumber, "Lead already exists in CRM");
    }
  }

  if (fingerprints.length > 0) {
    const existing = await CrmLead.find({ dedupeFingerprints: { $in: fingerprints }, isReviewData: { $ne: true } }, { dedupeFingerprints: 1 }).lean();
    const existingSet = new Set<string>();
    for (const lead of existing) {
      const values = Array.isArray((lead as any).dedupeFingerprints) ? ((lead as any).dedupeFingerprints as string[]) : [];
      values.forEach((value) => {
        if (value) existingSet.add(value);
      });
    }
    for (const draft of drafts) {
      if (draft.dedupeFingerprints.some((fingerprint) => existingSet.has(fingerprint))) {
        addRowIssue(rowIssues, draft.rowNumber, "Lead/list combination already exists in CRM");
      }
    }
  }

  return rowIssues;
}

function isAdminRole(role: unknown): boolean {
  const value = toNonEmptyString(role).toLowerCase();
  return value === "admin" || value === "superadmin";
}

function normalizeStringArrayInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => toNonEmptyString(entry)).filter(Boolean);
  }
  if (typeof value === "string") {
    return parseStringArray(value);
  }
  return [];
}

function getUpdatesList(lead: any): any[] {
  return Array.isArray((lead as any)?.updates) ? ((lead as any).updates as any[]) : [];
}

function normalizeIdLike(value: unknown, _depth = 0): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }

  if (typeof value === "object") {
    const maybeHex = (value as any)?.toHexString;
    if (typeof maybeHex === "function") {
      const output = toNonEmptyString(maybeHex.call(value));
      if (output) return output;
    }

    const maybeOid = toNonEmptyString((value as any)?.$oid);
    if (maybeOid) return maybeOid;

    if (_depth < 2) {
      const nestedId = (value as any)?._id;
      if (nestedId !== value) {
        const maybeNestedId = normalizeIdLike(nestedId, _depth + 1);
        if (maybeNestedId) return maybeNestedId;
      }
    }

    const maybeToString = (value as any)?.toString;
    if (typeof maybeToString === "function") {
      const output = toNonEmptyString(maybeToString.call(value));
      if (output && output !== "[object Object]") return output;
    }
  }

  return toNonEmptyString(value);
}

function findLeadUpdateById(lead: any, updateId: string): { updates: any[]; update: any; index: number } | null {
  const updates = getUpdatesList(lead);
  const normalizedTarget = normalizeIdLike(updateId);
  if (!normalizedTarget) return null;

  const index = updates.findIndex((entry) => {
    const normalizedEntryId = normalizeIdLike((entry as any)?._id) || normalizeIdLike((entry as any)?.id);
    return normalizedEntryId === normalizedTarget;
  });

  if (index < 0) return null;
  return { updates, update: updates[index], index };
}

function canMutateLeadUpdate(update: any, actorUserId?: string, allowAdmin = false, actorRole?: unknown): boolean {
  if (allowAdmin && isAdminRole(actorRole)) return true;
  return String((update as any)?.createdBy || "") === String(actorUserId || "");
}

async function removeMediaFromR2(urls: string[]): Promise<void> {
  const unique = Array.from(new Set(urls.map((value) => toNonEmptyString(value)).filter(Boolean)));
  if (unique.length === 0) return;

  await Promise.allSettled(
    unique.map(async (url) => {
      const location = resolveCurrentR2ObjectLocationFromUrl(url);
      if (!location?.bucketName) return;
      await deleteFromR2(location.bucketName, location.key);
    })
  );
}

function syncLeadLatestActivityFields(lead: any): void {
  const updates = getUpdatesList(lead).filter((entry) => !(entry as any)?.isDeleted);
  const latest = updates.length > 0 ? updates[updates.length - 1] : null;

  const latestComment = toNonEmptyString((latest as any)?.comment);
  const latestAttachmentUrls = Array.isArray((latest as any)?.attachmentUrls)
    ? ((latest as any).attachmentUrls as string[]).filter(Boolean)
    : [];
  const latestRecordingUrl = toNonEmptyString((latest as any)?.recordingUrl);
  const latestStatus = toNonEmptyString((latest as any)?.status);
  const latestLostReason = toNonEmptyString((latest as any)?.lostReason);

  lead.set("latestComment", latestComment || undefined);
  lead.set("latestAttachmentUrls", latestAttachmentUrls);
  lead.set("latestRecordingUrl", latestRecordingUrl || undefined);

  if (latestStatus && isCrmStatus(latestStatus)) {
    const normalized = normalizeCrmStatusValue(latestStatus, latestLostReason);
    lead.set("status", normalized.status);
    lead.set("lostReason", normalized.lostReason || undefined);
  }

  normalizeCrmLeadDocument(lead);
}

async function loadLeadWithUpdatesForResponse(leadId: string, reviewActor = false) {
  const match = reviewActor ? { isReviewAccount: true } : undefined;
  const item = await CrmLead.findById(leadId);

  if (item && normalizeCrmLeadDocument(item)) {
    await item.save();
  }

  if (item) await item.populate([
    { path: "assignedTo", select: "email username role", match },
    { path: "assignedBy", select: "email username role", match },
    { path: "updates.createdBy", select: "email username role", match },
  ]);

  return item;
}

export const listCrmUsers = async (req: Request, res: Response) => {
  try {
    const { q, isCrmAgent } = req.query as Record<string, string | undefined>;
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "25", 10) || 25, 1), 200);

    const filter: Record<string, any> = { role: "user" };
    if (typeof isCrmAgent === "string" && isCrmAgent.trim() !== "") {
      filter.isCrmAgent = parseBoolean(isCrmAgent);
    }
    if (q) {
      const regex = new RegExp(q, "i");
      filter.$or = [
        { email: regex },
        { username: regex },
        { companyName: regex },
        { contactPhone: regex },
        { crmAddress: regex },
        { crmQuadrant: regex },
      ];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .select("email username companyName contactPhone crmAddress crmQuadrant crmSpecializations isBlocked isCrmAgent crmAssignedAt createdAt")
        .sort({ isCrmAgent: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    return res.status(200).json({ items, total, page, limit });
  } catch (e: any) {
    console.error("listCrmUsers error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM users" });
  }
};

export const setCrmAgentStatus = async (req: AdminAuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const isCrmAgent = Boolean(req.body?.isCrmAgent);

    const user = await User.findById(id).select(
      "email username role isBlocked isCrmAgent crmAssignedAt crmAssignedBy expoPushTokens"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Only regular users can be assigned as CRM agents" });
    }

    const wasCrmAgent = Boolean((user as any).isCrmAgent);
    (user as any).isCrmAgent = isCrmAgent;

    if (isCrmAgent) {
      if (!(user as any).crmAssignedAt) {
        (user as any).crmAssignedAt = new Date();
      }
      if (req.userId) {
        (user as any).crmAssignedBy = req.userId;
      }
    } else {
      (user as any).crmAssignedAt = undefined;
      (user as any).crmAssignedBy = undefined;
    }

    await user.save();

    // Welcome notifications are transition-triggered and best effort. Retried writes
    // to an already-enabled agent must not produce duplicate email/push messages.
    if (isCrmAgent && !wasCrmAgent) {
      await sendCrmAgentAssignedEmail({
        email: (user as any).email,
        username: (user as any).username,
      }).catch((err) => {
        console.error("setCrmAgentStatus assignment email error", err);
      });

      await notifyUser({
        userId: String((user as any)._id || id),
        tokens: ((user as any).expoPushTokens || []) as string[],
        category: "crm",
        type: "crm_agent_enabled",
        title: "CRM Access Enabled",
        body: "Your account now has CRM agent access.",
        data: { type: "crm_agent_enabled" },
      }).catch((err) => {
        console.error("setCrmAgentStatus assignment push error", err);
      });
    }

    const safe = await User.findById(id)
      .select("email username companyName contactPhone crmAddress crmQuadrant crmSpecializations role isBlocked isCrmAgent crmAssignedAt createdAt")
      .populate("crmAssignedBy", "email username");

    return res.status(200).json({
      message: isCrmAgent ? "CRM role assigned" : "CRM role removed",
      user: safe,
    });
  } catch (e: any) {
    console.error("setCrmAgentStatus error", e);
    return res.status(500).json({ message: e?.message || "Failed to update CRM role" });
  }
};

export const quickAddCrmLeadForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const requestedAssignee = toNonEmptyString(req.body?.assignedToUserId || req.body?.assignedTo);
    let assignedTo = requestedAssignee;

    if (!assignedTo) {
      const fallback = await User.findOne({
        role: "user",
        isBlocked: { $ne: true },
        isCrmAgent: true,
        ...normalCrmUserFilter(),
      })
        .sort({ crmAssignedAt: 1, createdAt: 1 })
        .select("_id");
      assignedTo = String((fallback as any)?._id || "");
    }

    const item = await createQuickCrmLead({
      assignedTo,
      assignedBy: String(req.userId || ""),
      name: req.body?.name || req.body?.clientName,
      phone: req.body?.phone || req.body?.phoneNumber,
      notes: req.body?.notes,
      category: req.body?.category,
      specialization: req.body?.specialization,
      dueDate: req.body?.dueDate,
    });

    return res.status(201).json({ message: "Quick lead created", item });
  } catch (e: any) {
    console.error("quickAddCrmLeadForAdmin error", e);
    const message = e?.message || "Failed to create quick lead";
    const status = ["Name is required", "Phone number is required", "CRM specialization is required", "Select an active CRM agent"].includes(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
};

export const quickAddMyCrmLead = async (req: AuthRequest, res: Response) => {
  try {
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const item = await createQuickCrmLead({
      assignedTo: String(req.userId || ""),
      assignedBy: String(req.userId || ""),
      reviewSelfCapture: isReviewAccount(req.user),
      name: req.body?.name || req.body?.clientName,
      phone: req.body?.phone || req.body?.phoneNumber,
      notes: req.body?.notes,
      category: req.body?.category,
      specialization: req.body?.specialization,
      dueDate: req.body?.dueDate,
    });

    return res.status(201).json({ message: "Quick lead created", item });
  } catch (e: any) {
    console.error("quickAddMyCrmLead error", e);
    const message = e?.message || "Failed to create quick lead";
    const status = ["Name is required", "Phone number is required", "CRM specialization is required", "Select an active CRM agent"].includes(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
};

export const getCrmLeadDetailsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    if (!leadId) {
      return res.status(400).json({ message: "Lead id is required" });
    }

    const item = await loadLeadWithUpdatesForResponse(leadId);
    if (!item) {
      return res.status(404).json({ message: "CRM lead not found" });
    }

    return res.status(200).json({ item });
  } catch (e: any) {
    console.error("getCrmLeadDetailsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM lead details" });
  }
};

export const updateCrmLeadForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const status = toNonEmptyString(req.body?.status);
    const lostReason = toNonEmptyString(req.body?.lostReason);

    if (!leadId) {
      return res.status(400).json({ message: "Lead id is required" });
    }
    if (!status || !isCrmStatus(status)) {
      return res.status(400).json({ message: "Valid CRM status is required" });
    }
    if (lostReason && !isCrmLostReason(lostReason)) {
      return res.status(400).json({ message: "Invalid CRM lost reason" });
    }
    if (status === "lost" && !lostReason) {
      return res.status(400).json({ message: "Lost reason is required when status is Lost" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });
    normalizeCrmLeadDocument(lead);

    const previousStatus = toNonEmptyString((lead as any).status);
    const previousLostReason = toNonEmptyString((lead as any).lostReason);
    const normalized = normalizeCrmStatusValue(status, lostReason);

    applyCrmStatusChange(lead, normalized.status, normalized.lostReason, new Date());

    const statusChanged =
      previousStatus !== normalized.status ||
      previousLostReason !== (normalized.lostReason || "");

    if (statusChanged) {
      const updates = getUpdatesList(lead);
      updates.push({
        comment: `Status updated by admin to ${normalized.status.replace(/_/g, " ")}`,
        status: normalized.status,
        lostReason: normalized.lostReason,
        createdBy: req.userId,
        createdAt: new Date(),
      });
      lead.set("updates", updates);
    }

    syncLeadLatestActivityFields(lead);
    await lead.save();

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "CRM lead updated", item });
  } catch (e: any) {
    console.error("updateCrmLeadForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to update CRM lead" });
  }
};

export const addCrmLeadReplyForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const comment = toNonEmptyString(req.body?.comment);
    const status = toNonEmptyString(req.body?.status);
    const lostReason = toNonEmptyString(req.body?.lostReason);

    if (!leadId) {
      return res.status(400).json({ message: "Lead id is required" });
    }
    if (!comment) {
      return res.status(400).json({ message: "Reply comment is required" });
    }
    if (status && !isCrmStatus(status)) {
      return res.status(400).json({ message: "Invalid CRM status" });
    }
    if (lostReason && !isCrmLostReason(lostReason)) {
      return res.status(400).json({ message: "Invalid CRM lost reason" });
    }

    const lead = await CrmLead.findById(leadId);
    if (!lead) return res.status(404).json({ message: "CRM lead not found" });
    normalizeCrmLeadDocument(lead);

    const nextStatus = status || toNonEmptyString((lead as any).status) || "new_lead";
    if ((status || lostReason) && nextStatus === "lost" && !lostReason && !toNonEmptyString((lead as any).lostReason)) {
      return res.status(400).json({ message: "Lost reason is required when status is Lost" });
    }
    if ((status || lostReason) && isCrmStatus(nextStatus)) {
      const normalized = normalizeCrmStatusValue(nextStatus, lostReason || (lead as any).lostReason);
      applyCrmStatusChange(lead, normalized.status, normalized.lostReason, new Date());
    }

    const updates = getUpdatesList(lead);
    updates.push({
      comment,
      status: (lead as any).status,
      lostReason: (lead as any).lostReason,
      createdBy: req.userId,
      createdAt: new Date(),
    });
    lead.set("updates", updates);
    syncLeadLatestActivityFields(lead);
    await lead.save();

    await sendCrmAdminMessageNotification({
      userId: String((lead as any).assignedTo || ""),
      leadId: String((lead as any)._id || leadId),
      clientName: toNonEmptyString((lead as any).clientName),
      title: toNonEmptyString((lead as any).title),
      comment,
    }).catch((err) => {
      console.error("addCrmLeadReplyForAdmin push error", err);
    });

    const item = await loadLeadWithUpdatesForResponse(leadId);
    return res.status(200).json({ message: "CRM reply added", item });
  } catch (e: any) {
    console.error("addCrmLeadReplyForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to submit admin CRM reply" });
  }
};

export const getCrmAutoFindOptionsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  return res.status(200).json({
    countries: ["Canada", "United States"],
    canadaProvinces: CANADA_PROVINCES,
    usStates: US_STATES,
    categories: allowedCategories,
    maxResults: CRM_AUTO_FIND_MAX_RESULTS,
  });
};

function deriveRevenueRadarAutoFindCategories(radarCategories: string[]): string[] {
  const text = radarCategories
    .map((id) => REVENUE_RADAR_CATEGORY_OPTIONS.find((entry) => entry.id === id)?.keywords.join(" ") || id)
    .join(" ")
    .toLowerCase();

  const preferred = allowedCategories.filter((category) => {
    const normalized = category.toLowerCase();
    return (
      /auction|liquidation|salvage|insurance|equipment|fleet|farm|agric|tractor|construction|industrial|municipal|surplus|repossession|storage|appraisal|valuation|vehicle|truck|trailer|machinery/.test(normalized) ||
      text.split(/\s+/).some((token) => token.length >= 5 && normalized.includes(token))
    );
  });

  return Array.from(new Set(preferred)).slice(0, 8);
}

export const getRevenueRadarForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const country = normalizeCountry(req.query?.country);
    const regions = parseStringArray(req.query?.regions);
    const categories = parseStringArray(req.query?.categories);
    const timeframeDays = Number(req.query?.timeframeDays || 90);

    const snapshot = await getRevenueRadarSnapshot({
      country,
      regions,
      categories,
      timeframeDays,
    });

    return res.status(200).json(snapshot);
  } catch (e: any) {
    console.error("getRevenueRadarForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load Revenue Radar" });
  }
};

export const startRevenueRadarSearchForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const country = normalizeCountry(req.body?.country);
    if (!country) {
      return res.status(400).json({ message: "Country must be Canada or United States" });
    }

    const regions = normalizeAutoFindRegions(country, req.body?.regions);
    const radarCategories = parseStringArray(req.body?.categories)
      .filter((category) => REVENUE_RADAR_CATEGORY_OPTIONS.some((entry) => entry.id === category))
      .slice(0, 8);
    const directAutoFindCategories = normalizeAutoFindCategories(req.body?.autoFindCategories);
    const fallbackAutoFindCategories = deriveRevenueRadarAutoFindCategories(radarCategories);
    const categories = directAutoFindCategories.length
      ? directAutoFindCategories
      : fallbackAutoFindCategories.length
        ? fallbackAutoFindCategories
        : allowedCategories.slice(0, 8);
    const keywords = buildRevenueRadarSearchKeywords({
      categories: radarCategories,
      keywords: toNonEmptyString(req.body?.keywords),
    });
    const maxResults = Math.min(
      Math.max(Number(req.body?.maxResults || 30) || 30, 1),
      Math.min(CRM_AUTO_FIND_MAX_RESULTS, 100)
    );

    if (categories.length === 0) {
      return res.status(400).json({ message: "No valid prospect categories are available for Revenue Radar search" });
    }

    // Persist the run before launching background work so polling has an authoritative
    // record even if the search outlives the initiating HTTP request.
    const run = await CrmAutoFindRun.create({
      status: "queued",
      criteria: {
        source: "revenue-radar",
        country,
        regions,
        radarCategories,
        categories,
        keywords,
        maxResults,
      },
      totalBatches: CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: 0,
      failedBatches: 0,
      progress: 0,
      message: "Revenue Radar prospect search queued",
      items: [],
      rawJson: {},
      searched: 0,
      duplicateCount: 0,
      createdBy: req.userId,
    });

    void runCrmAutoFindRun(String((run as any)._id), {
      country,
      regions,
      categories,
      keywords,
      maxResults,
      userId: req.userId,
    });

    return res.status(202).json({
      message: "Revenue Radar prospect search started",
      runId: String((run as any)._id),
      status: "queued",
      progress: 0,
      totalBatches: CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: 0,
      failedBatches: 0,
    });
  } catch (e: any) {
    console.error("startRevenueRadarSearchForAdmin error", e);
    if (isWebSearchBillingOrLimitError(e)) {
      return res.status(429).json({ message: "Please check billing or usage limits of the Web Search API." });
    }
    return res.status(500).json({ message: e?.message || "Failed to start Revenue Radar search" });
  }
};

async function runCrmAutoFindRun(
  runId: string,
  input: {
    country: CrmAutoFindCountry;
    regions: string[];
    categories: string[];
    keywords: string;
    maxResults: number;
    userId?: string;
  }
) {
  let completedBatches = 0;
  let failedBatches = 0;
  let accumulated: CrmAutoFindLeadResult[] = [];
  const isStopRequested = async () => {
    const run = await CrmAutoFindRun.findById(runId).select("status").lean();
    const status = String((run as any)?.status || "");
    return status === "stopping" || status === "cancelled";
  };

  try {
    const startedRun = await CrmAutoFindRun.findOneAndUpdate(
      { _id: runId, status: { $nin: ["stopping", "cancelled"] } },
      {
        $set: {
          status: "running",
          startedAt: new Date(),
          progress: 2,
          message: "Preparing CRM duplicate exclusions",
        },
      },
      { new: true }
    ).lean();
    if (!startedRun) {
      await CrmAutoFindRun.findByIdAndUpdate(runId, {
        $set: {
          status: "cancelled",
          progress: 100,
          message: "Search stopped. 0 leads available to import.",
          cancelledAt: new Date(),
          completedAt: new Date(),
        },
      });
      return;
    }

    const excludeFingerprints = await getCrmAutoFindExclusionFingerprints();
    const searchMeta = {
      country: input.country,
      regions: input.regions,
      categories: input.categories,
      keywords: input.keywords,
      maxResults: input.maxResults,
      searchedAt: new Date().toISOString(),
      runId,
    };

    const result = await runCrmAutoFindSearchPlans({
      country: input.country,
      regions: input.regions,
      categories: input.categories,
      keywords: input.keywords,
      maxResults: input.maxResults,
      excludeFingerprints,
      shouldStop: isStopRequested,
      onBatchComplete: async ({ batchIndex, leads, error }) => {
        completedBatches += 1;
        if (error) failedBatches += 1;
        accumulated = [...accumulated, ...leads].slice(0, input.maxResults);

        const built = await buildAndSaveAutoFindItems({
          found: accumulated,
          searchMeta: {
            ...searchMeta,
            completedBatches,
            failedBatches,
          },
          country: input.country,
          regions: input.regions,
          categories: input.categories,
          keywords: input.keywords,
          foundBy: input.userId,
        });
        const stopping = await isStopRequested();

        await CrmAutoFindRun.findByIdAndUpdate(runId, {
          $set: {
            status: stopping ? "stopping" : "running",
            completedBatches,
            failedBatches,
            progress: Math.min(99, Math.max(5, Math.round((completedBatches / CRM_AUTO_FIND_BATCH_COUNT) * 100))),
            message: stopping
              ? `Stopping search. ${built.items.length} lead${built.items.length === 1 ? "" : "s"} available to import.`
              : error
                ? `Search batch ${batchIndex} failed; continuing with other searches`
                : `Completed search batch ${batchIndex} of ${CRM_AUTO_FIND_BATCH_COUNT}`,
            items: built.items,
            rawJson: built.rawJson,
            searched: built.searched,
            duplicateCount: built.duplicateCount,
            error: failedBatches > 0 ? `${failedBatches} search batch${failedBatches === 1 ? "" : "es"} failed` : undefined,
          },
        });
      },
    });

    const stopped = await isStopRequested();
    const built = await buildAndSaveAutoFindItems({
      found: result.leads,
      searchMeta: {
        ...searchMeta,
        completedBatches: CRM_AUTO_FIND_BATCH_COUNT,
        failedBatches: result.failedBatches,
      },
      country: input.country,
      regions: input.regions,
      categories: input.categories,
      keywords: input.keywords,
      foundBy: input.userId,
    });

    if (stopped) {
      await CrmAutoFindRun.findByIdAndUpdate(runId, {
        $set: {
          status: "cancelled",
          completedBatches,
          failedBatches: result.failedBatches,
          progress: 100,
          message: `Search stopped. ${built.items.length} lead${built.items.length === 1 ? "" : "s"} available to import.`,
          items: built.items,
          rawJson: built.rawJson,
          searched: built.searched,
          duplicateCount: built.duplicateCount,
          error: result.failedBatches > 0 ? `${result.failedBatches} search batch${result.failedBatches === 1 ? "" : "es"} failed` : undefined,
          cancelledAt: new Date(),
          completedAt: new Date(),
        },
      });
      return;
    }

    if (result.failedBatches >= CRM_AUTO_FIND_BATCH_COUNT && result.leads.length === 0) {
      await CrmAutoFindRun.findByIdAndUpdate(runId, {
        $set: {
          status: "failed",
          completedBatches: CRM_AUTO_FIND_BATCH_COUNT,
          failedBatches: result.failedBatches,
          progress: 100,
          items: built.items,
          rawJson: built.rawJson,
          searched: built.searched,
          duplicateCount: built.duplicateCount,
          error: "All auto-find search batches failed",
          message: "Auto-find search failed",
          completedAt: new Date(),
        },
      });
      return;
    }

    await CrmAutoFindRun.findByIdAndUpdate(runId, {
      $set: {
        status: "completed",
        completedBatches: CRM_AUTO_FIND_BATCH_COUNT,
        failedBatches: result.failedBatches,
        progress: 100,
        message: `CRM client search complete: ${built.items.length} lead${built.items.length === 1 ? "" : "s"} found`,
        items: built.items,
        rawJson: built.rawJson,
        searched: built.searched,
        duplicateCount: built.duplicateCount,
        error: result.failedBatches > 0 ? `${result.failedBatches} search batch${result.failedBatches === 1 ? "" : "es"} failed` : undefined,
        completedAt: new Date(),
      },
    });
  } catch (e: any) {
    console.error("runCrmAutoFindRun error", e);
    await CrmAutoFindRun.findByIdAndUpdate(runId, {
      $set: {
        status: "failed",
        progress: 100,
        message: isWebSearchBillingOrLimitError(e)
          ? "Please check billing or usage limits of the Web Search API."
          : "Auto-find search failed",
        error: e?.message || "Failed to auto find CRM clients",
        completedAt: new Date(),
      },
    }).catch((updateError) => {
      console.error("runCrmAutoFindRun failed status update error", updateError);
    });
  }
}

export const autoFindCrmClientsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const country = normalizeCountry(req.body?.country);
    if (!country) {
      return res.status(400).json({ message: "Country must be Canada or United States" });
    }

    const regions = normalizeAutoFindRegions(country, req.body?.regions);
    const categories = normalizeAutoFindCategories(req.body?.categories);
    const keywords = toNonEmptyString(req.body?.keywords).slice(0, 300);
    const maxResults = Math.min(
      Math.max(Number(req.body?.maxResults || CRM_AUTO_FIND_MAX_RESULTS) || CRM_AUTO_FIND_MAX_RESULTS, 1),
      CRM_AUTO_FIND_MAX_RESULTS
    );

    if (categories.length === 0) {
      return res.status(400).json({ message: "Select at least one category" });
    }

    const run = await CrmAutoFindRun.create({
      status: "queued",
      criteria: { country, regions, categories, keywords, maxResults },
      totalBatches: CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: 0,
      failedBatches: 0,
      progress: 0,
      message: "Queued",
      items: [],
      rawJson: {},
      searched: 0,
      duplicateCount: 0,
      createdBy: req.userId,
    });

    // Search progress is recorded on the run; 202 means accepted, not completed.
    void runCrmAutoFindRun(String((run as any)._id), {
      country,
      regions,
      categories,
      keywords,
      maxResults,
      userId: req.userId,
    });

    return res.status(202).json({
      message: "CRM client search started",
      runId: String((run as any)._id),
      status: "queued",
      progress: 0,
      totalBatches: CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: 0,
      failedBatches: 0,
    });
  } catch (e: any) {
    console.error("autoFindCrmClientsForAdmin error", e);
    if (isWebSearchBillingOrLimitError(e)) {
      return res.status(429).json({ message: "Please check billing or usage limits of the Web Search API." });
    }
    return res.status(500).json({ message: e?.message || "Failed to auto find CRM clients" });
  }
};

export const getCrmAutoFindRunForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const runId = toNonEmptyString(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) {
      return res.status(400).json({ message: "Valid auto-find run id is required" });
    }

    // Run ownership prevents one administrator from inspecting another administrator's
    // in-progress search using a guessed Mongo id.
    const run = await CrmAutoFindRun.findOne({
      _id: runId,
      createdBy: req.userId,
    }).lean();
    if (!run) {
      return res.status(404).json({ message: "Auto-find run not found" });
    }

    return res.status(200).json({
      runId: String((run as any)._id),
      status: (run as any).status,
      criteria: (run as any).criteria || {},
      totalBatches: (run as any).totalBatches || CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: (run as any).completedBatches || 0,
      failedBatches: (run as any).failedBatches || 0,
      progress: (run as any).progress || 0,
      message: (run as any).message || "",
      items: Array.isArray((run as any).items) ? (run as any).items : [],
      rawJson: (run as any).rawJson || {},
      searched: (run as any).searched || 0,
      duplicateCount: (run as any).duplicateCount || 0,
      error: (run as any).error || "",
      createdAt: (run as any).createdAt,
      updatedAt: (run as any).updatedAt,
      startedAt: (run as any).startedAt,
      completedAt: (run as any).completedAt,
      cancelRequestedAt: (run as any).cancelRequestedAt,
      cancelledAt: (run as any).cancelledAt,
      cancelledBy: (run as any).cancelledBy,
    });
  } catch (e: any) {
    console.error("getCrmAutoFindRunForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load auto-find run" });
  }
};

export const stopCrmAutoFindRunForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const runId = toNonEmptyString(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) {
      return res.status(400).json({ message: "Valid auto-find run id is required" });
    }

    const run = await CrmAutoFindRun.findOne({
      _id: runId,
      createdBy: req.userId,
    });
    if (!run) {
      return res.status(404).json({ message: "Auto-find run not found" });
    }

    const status = String((run as any).status || "");
    if (["completed", "failed", "cancelled"].includes(status)) {
      return res.status(200).json({
        runId: String((run as any)._id),
        status: (run as any).status,
        criteria: (run as any).criteria || {},
        totalBatches: (run as any).totalBatches || CRM_AUTO_FIND_BATCH_COUNT,
        completedBatches: (run as any).completedBatches || 0,
        failedBatches: (run as any).failedBatches || 0,
        progress: (run as any).progress || 0,
        message: (run as any).message || "",
        items: Array.isArray((run as any).items) ? (run as any).items : [],
        rawJson: (run as any).rawJson || {},
        searched: (run as any).searched || 0,
        duplicateCount: (run as any).duplicateCount || 0,
        error: (run as any).error || "",
        createdAt: (run as any).createdAt,
        updatedAt: (run as any).updatedAt,
        startedAt: (run as any).startedAt,
        completedAt: (run as any).completedAt,
        cancelRequestedAt: (run as any).cancelRequestedAt,
        cancelledAt: (run as any).cancelledAt,
        cancelledBy: (run as any).cancelledBy,
      });
    }

    (run as any).status = "stopping";
    (run as any).cancelRequestedAt = new Date();
    (run as any).cancelledBy = req.userId;
    (run as any).message = "Stopping search after the current batch finishes";
    await run.save();

    return res.status(202).json({
      runId: String((run as any)._id),
      status: (run as any).status,
      criteria: (run as any).criteria || {},
      totalBatches: (run as any).totalBatches || CRM_AUTO_FIND_BATCH_COUNT,
      completedBatches: (run as any).completedBatches || 0,
      failedBatches: (run as any).failedBatches || 0,
      progress: (run as any).progress || 0,
      message: (run as any).message || "",
      items: Array.isArray((run as any).items) ? (run as any).items : [],
      rawJson: (run as any).rawJson || {},
      searched: (run as any).searched || 0,
      duplicateCount: (run as any).duplicateCount || 0,
      error: (run as any).error || "",
      createdAt: (run as any).createdAt,
      updatedAt: (run as any).updatedAt,
      startedAt: (run as any).startedAt,
      completedAt: (run as any).completedAt,
      cancelRequestedAt: (run as any).cancelRequestedAt,
      cancelledAt: (run as any).cancelledAt,
      cancelledBy: (run as any).cancelledBy,
    });
  } catch (e: any) {
    console.error("stopCrmAutoFindRunForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to stop auto-find run" });
  }
};

export const importAutoFoundCrmClientsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const resultIds = parseStringArray(req.body?.resultIds)
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .slice(0, 50);
    if (resultIds.length === 0) {
      return res.status(400).json({ message: "Select at least one auto-found lead to import" });
    }

    const selectedIds = parseStringArray(req.body?.assignedToUserIds);
    const records = await CrmAutoFindLead.find({
      _id: { $in: resultIds },
      status: { $ne: "imported" },
      ...(req.user?.role === "superadmin" ? {} : { foundBy: req.userId }),
    }).lean();
    const recordById = new Map(records.map((record: any) => [String(record._id), record]));
    const orderedRecords = resultIds.map((id) => recordById.get(id)).filter(Boolean);
    if (orderedRecords.length === 0) {
      return res.status(400).json({ message: "No selected auto-found leads are available to import" });
    }

    const sourceBatchId = `crm-auto-find-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const searchMeta = {
      sourceBatchId,
      importedAt: new Date().toISOString(),
    };
    const parsedDrafts = orderedRecords.map((record: any, index) =>
      autoFindLeadToDraft(record.lead as CrmAutoFindLeadResult, index + 1, {
        ...(record.lead?.searchMeta || {}),
        country: record.country,
        regions: record.regions,
        categories: record.categories,
        keywords: record.keywords,
        ...searchMeta,
      })
    );

    const result = await assignAndInsertCrmDrafts({
      parsedDrafts,
      selectedUserIds: selectedIds,
      assignedBy: req.userId,
      sourceBatchId,
      sourceFileName: "CRM Auto Find Clients",
      sourceSheetName: "Auto Find",
      notifyReason: "assignment",
    });

    const insertedByIdentity = new Map<string, any>();
    for (const lead of result.inserted) {
      const key = toNonEmptyString((lead as any).identityKey);
      if (key) insertedByIdentity.set(key, lead);
    }

    await Promise.allSettled(
      orderedRecords.map(async (record: any, index) => {
        const draft = parsedDrafts[index];
        const inserted = insertedByIdentity.get(draft.identityKey);
        if (inserted) {
          await CrmAutoFindLead.updateOne(
            { _id: record._id },
            {
              $set: {
                status: "imported",
                importedLeadId: (inserted as any)._id,
                importedBy: req.userId,
                importedAt: new Date(),
              },
            }
          );
          return;
        }

        await CrmAutoFindLead.updateOne(
          { _id: record._id },
          {
            $set: {
              status: "skipped",
            },
          }
        );
      })
    );

    return res.status(201).json({
      message: result.inserted.length > 0 ? "Auto-found CRM leads imported" : "No selected leads were imported",
      sourceBatchId,
      imported: result.inserted.length,
      duplicateCount: result.duplicateCount,
      duplicateRows: result.duplicateRows.slice(0, 100),
      quadrantPendingCount: result.quadrantPendingCount,
      assignedUsers: result.assignedUsers,
    });
  } catch (e: any) {
    console.error("importAutoFoundCrmClientsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to import auto-found CRM clients" });
  }
};

export const listCrmImportFilesForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "25", 10) || 25, 1), 200);

    const grouped = await CrmLead.aggregate([
      { $match: { sourceBatchId: { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: "$sourceBatchId",
          sourceFileName: { $first: "$sourceFileName" },
          sourceFileUrl: { $first: "$sourceFileUrl" },
          sourceFileKey: { $first: "$sourceFileKey" },
          sourceFileBucket: { $first: "$sourceFileBucket" },
          sourceFilePublicBaseUrl: { $first: "$sourceFilePublicBaseUrl" },
          importedAt: { $min: "$createdAt" },
          latestLeadAt: { $max: "$createdAt" },
          leadCount: { $sum: 1 },
        },
      },
      { $sort: { importedAt: -1 } },
      {
        $project: {
          _id: 0,
          sourceBatchId: "$_id",
          sourceFileName: 1,
          sourceFileUrl: 1,
          sourceFileKey: 1,
          sourceFileBucket: 1,
          sourceFilePublicBaseUrl: 1,
          importedAt: 1,
          latestLeadAt: 1,
          leadCount: 1,
        },
      },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]);

    const totalRows = await CrmLead.aggregate([
      { $match: { sourceBatchId: { $exists: true, $ne: "" } } },
      { $group: { _id: "$sourceBatchId" } },
      { $count: "total" },
    ]);

    return res.status(200).json({
      items: grouped,
      total: Number(totalRows?.[0]?.total || 0),
      page,
      limit,
    });
  } catch (e: any) {
    console.error("listCrmImportFilesForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM import files" });
  }
};

export const listCrmImportJobsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "25", 10) || 25, 1), 100);
    const [items, total] = await Promise.all([
      CrmImportJob.find({})
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CrmImportJob.countDocuments({}),
    ]);
    return res.status(200).json({ items, total, page, limit });
  } catch (e: any) {
    console.error("listCrmImportJobsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM import jobs" });
  }
};

export const getCrmImportJobForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const jobId = toNonEmptyString(req.params.jobId);
    const item = await CrmImportJob.findOne({ jobId }).lean();
    if (!item) return res.status(404).json({ message: "CRM import job not found" });
    return res.status(200).json({ item });
  } catch (e: any) {
    console.error("getCrmImportJobForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM import job" });
  }
};

export const listCrmAssignmentsByUpload = async (req: AdminAuthRequest, res: Response) => {
  try {
    const items = await CrmLead.aggregate([
      { $match: { sourceBatchId: { $exists: true, $ne: "" } } },
      {
        $lookup: {
          from: "users",
          localField: "assignedTo",
          foreignField: "_id",
          as: "assignedUser",
        },
      },
      { $unwind: { path: "$assignedUser", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            sourceBatchId: "$sourceBatchId",
            agentId: "$assignedTo",
          },
          sourceFileName: { $first: "$sourceFileName" },
          importedAt: { $min: "$createdAt" },
          leadCount: { $sum: 1 },
          overdueCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: [{ $in: ["$status", ["won", "lost", "completed", "not_interested"]] }] },
                    { $ne: ["$dueDate", null] },
                    { $lt: ["$dueDate", new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          agentEmail: { $first: "$assignedUser.email" },
          agentUsername: { $first: "$assignedUser.username" },
        },
      },
      {
        $project: {
          _id: 0,
          sourceBatchId: "$_id.sourceBatchId",
          sourceFileName: 1,
          importedAt: 1,
          leadCount: 1,
          overdueCount: 1,
          agentId: "$_id.agentId",
          agentEmail: 1,
          agentUsername: 1,
        },
      },
      { $sort: { importedAt: -1, agentUsername: 1, agentEmail: 1 } },
    ]);

    return res.status(200).json({ items });
  } catch (e: any) {
    console.error("listCrmAssignmentsByUpload error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM assignments by upload" });
  }
};

export const listCrmAssignmentUploadLeadsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const sourceBatchId = toNonEmptyString(req.params.sourceBatchId);
    if (!sourceBatchId) {
      return res.status(400).json({ message: "Upload batch id is required" });
    }

    const crmUsers = await User.find({
      role: "user",
      isBlocked: { $ne: true },
      isCrmAgent: true,
      ...normalCrmUserFilter(),
    }).select("_id email username crmAddress crmQuadrant crmSpecializations expoPushTokens isReviewAccount");
    if (crmUsers.length === 0) {
      return res.status(400).json({ message: "No active CRM users available for assignment" });
    }

    const leads = await CrmLead.find({ sourceBatchId, isReviewData: { $ne: true } })
      .sort({ createdAt: 1 })
      .populate("assignedTo", "email username crmAddress")
      .lean();

    const assigneeLoadMap = new Map<string, number>();
    const existingLoadCounts = await CrmLead.aggregate([
      { $match: { assignedTo: { $in: crmUsers.map((u) => (u as any)._id) }, isReviewData: { $ne: true } } },
      { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    ]);
    for (const entry of existingLoadCounts) {
      assigneeLoadMap.set(String(entry._id), entry.count);
    }

    const preparedAssignees = await prepareCrmAssignees(crmUsers as any[]);
    const items = [];

    for (const lead of leads) {
      const location = buildLeadGeoSource({
        companyLocation: toNonEmptyString((lead as any).companyLocation),
        contactLocation: toNonEmptyString((lead as any).contactLocation),
        companyPostCode: toNonEmptyString((lead as any).companyPostCode),
      });
      const leadGeo = await normalizeCrmGeoLocation(location);
      const assignment = chooseNearestCrmAssignee({
        leadGeo,
        leadSpecialization: normalizeCrmSpecialization((lead as any).specialization),
        assignees: preparedAssignees,
        assigneeLoadMap,
      });
      const currentAssignee = (lead as any).assignedTo;
      const currentAssigneeId = String(currentAssignee?._id || currentAssignee || "");
      const proposedAssigneeId = String((assignment.assignee as any)?._id || "");

      items.push({
        leadId: String((lead as any)._id || ""),
        title: toNonEmptyString((lead as any).title),
        clientName: toNonEmptyString((lead as any).clientName),
        companyName: toNonEmptyString((lead as any).companyName),
        email: toNonEmptyString((lead as any).email),
        phone: toNonEmptyString((lead as any).phoneFormatted || (lead as any).phoneRaw),
        status: toNonEmptyString((lead as any).status),
        dueDate: (lead as any).dueDate,
        location,
        currentAssignee: currentAssigneeId
          ? {
              _id: currentAssigneeId,
              email: toNonEmptyString(currentAssignee?.email),
              username: toNonEmptyString(currentAssignee?.username),
              crmAddress: toNonEmptyString(currentAssignee?.crmAddress),
            }
          : null,
        proposedAssignee: {
          _id: proposedAssigneeId,
          email: toNonEmptyString((assignment.assignee as any)?.email),
          username: toNonEmptyString((assignment.assignee as any)?.username),
          crmAddress: toNonEmptyString((assignment.assignee as any)?.crmAddress),
        },
        changedToNearest: Boolean(proposedAssigneeId && proposedAssigneeId !== currentAssigneeId),
        method: assignment.method,
        distanceKm: assignment.distanceKm,
        matchedRegion: assignment.matchedRegion,
        reason: assignment.reason,
      });
    }

    const firstLead = leads[0] as any;
    return res.status(200).json({
      sourceBatchId,
      sourceFileName: toNonEmptyString(firstLead?.sourceFileName),
      importedAt: firstLead?.createdAt,
      leadCount: leads.length,
      agents: crmUsers.map((user: any) => ({
        _id: String(user._id || ""),
        email: toNonEmptyString(user.email),
        username: toNonEmptyString(user.username),
        crmAddress: toNonEmptyString(user.crmAddress),
      })),
      items,
    });
  } catch (e: any) {
    console.error("listCrmAssignmentUploadLeadsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM upload assignments" });
  }
};

export const reassignCrmAssignmentUploadLeadsForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const sourceBatchId = toNonEmptyString(req.params.sourceBatchId);
    if (!sourceBatchId) {
      return res.status(400).json({ message: "Upload batch id is required" });
    }

    const rawAssignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    const notify = parseBoolean(req.body?.notify, true);
    const requestedAssignments = new Map<string, string>();
    for (const entry of rawAssignments) {
      const leadId = toNonEmptyString((entry as any)?.leadId);
      const assignedTo = toNonEmptyString((entry as any)?.assignedTo);
      if (mongoose.Types.ObjectId.isValid(leadId) && mongoose.Types.ObjectId.isValid(assignedTo)) {
        requestedAssignments.set(leadId, assignedTo);
      }
    }

    if (requestedAssignments.size === 0) {
      return res.status(400).json({ message: "At least one lead assignment is required" });
    }

    const [leads, crmUsers] = await Promise.all([
      CrmLead.find({ sourceBatchId, isReviewData: { $ne: true }, _id: { $in: Array.from(requestedAssignments.keys()) } }),
      User.find({
        role: "user",
        isBlocked: { $ne: true },
        isCrmAgent: true,
        ...normalCrmUserFilter(),
        _id: { $in: Array.from(new Set(requestedAssignments.values())) },
      }).select("_id email username crmAddress crmQuadrant crmSpecializations expoPushTokens"),
    ]);

    if (leads.length !== requestedAssignments.size) {
      return res.status(400).json({ message: "One or more selected leads do not belong to this upload" });
    }

    const userById = new Map(crmUsers.map((user: any) => [String(user._id || ""), user]));
    for (const assignedTo of requestedAssignments.values()) {
      if (!userById.has(assignedTo)) {
        return res.status(400).json({ message: "One or more selected agents are not active CRM agents" });
      }
    }

    const preparedAssignees = await prepareCrmAssignees(crmUsers as any[]);
    const preparedByUserId = new Map(preparedAssignees.map((entry) => [String((entry.user as any)?._id || ""), entry]));
    const taskAssignmentsByUser = new Map<string, Array<{ title: string; clientName: string; dueDate?: Date }>>();
    const changedItems: any[] = [];

    for (const lead of leads) {
      const leadId = String((lead as any)._id || "");
      const targetUserId = requestedAssignments.get(leadId) || "";
      const currentUserId = String((lead as any).assignedTo || "");
      if (!targetUserId || targetUserId === currentUserId) continue;

      const targetUser = userById.get(targetUserId);
      const preparedTarget = preparedByUserId.get(targetUserId);
      const leadGeo = await normalizeCrmGeoLocation(
        buildLeadGeoSource({
          companyLocation: toNonEmptyString((lead as any).companyLocation),
          contactLocation: toNonEmptyString((lead as any).contactLocation),
          companyPostCode: toNonEmptyString((lead as any).companyPostCode),
        })
      );
      const matchedRegion =
        leadGeo.countryCode &&
        leadGeo.regionCode &&
        preparedTarget?.geo?.countryCode === leadGeo.countryCode &&
        preparedTarget?.geo?.regionCode === leadGeo.regionCode
          ? `${leadGeo.countryCode}-${leadGeo.regionCode}`
          : "";

      (lead as any).assignedTo = (targetUser as any)._id;
      (lead as any).assignedBy = req.userId;
      (lead as any).leadGeo = leadGeo;
      (lead as any).assignedUserGeo = preparedTarget?.geo;
      (lead as any).assignmentMethod = "manual_upload_repair";
      (lead as any).assignmentMatchedRegion = matchedRegion;
      (lead as any).assignmentReason = "Upload assignment repair by admin";
      (lead as any).assignmentDistanceKm = undefined;
      (lead as any).quadrantPending = !leadGeo.regionCode && leadGeo.lat === undefined && leadGeo.lng === undefined;
      (lead as any).dueSoonPushSentAt = undefined;
      (lead as any).overduePushSentAt = undefined;
      await lead.save();

      const bucket = taskAssignmentsByUser.get(targetUserId) || [];
      bucket.push({
        title: toNonEmptyString((lead as any).title),
        clientName: toNonEmptyString((lead as any).clientName),
        dueDate: (lead as any).dueDate,
      });
      taskAssignmentsByUser.set(targetUserId, bucket);

      changedItems.push({
        leadId,
        assignedTo: targetUserId,
        previousAssignedTo: currentUserId,
      });
    }

    if (notify && taskAssignmentsByUser.size > 0) {
      const settled = await Promise.allSettled(
        Array.from(taskAssignmentsByUser.entries()).map(async ([userId, tasks]) => {
          const targetUser = userById.get(userId);
          if (!targetUser) return;

          if ((targetUser as any).email) {
            await sendCrmTasksAssignedEmail(
              {
                email: (targetUser as any).email,
                username: (targetUser as any).username || undefined,
              },
              tasks
            );
          }

          const singleChangedLead =
            tasks.length === 1 ? changedItems.find((item) => String(item.assignedTo || "") === userId) : null;
          await sendCrmNewTaskNotification({
            userId,
            tokens: ((targetUser as any).expoPushTokens || []) as string[],
            leadId: singleChangedLead?.leadId,
            clientName: toNonEmptyString(tasks[0]?.clientName),
            title: toNonEmptyString(tasks[0]?.title),
            count: tasks.length,
            reason: "reassignment",
          }).catch((err) => {
            console.error("reassignCrmAssignmentUploadLeadsForAdmin push error", err);
          });
        })
      );

      for (const result of settled) {
        if (result.status === "rejected") {
          console.error("reassignCrmAssignmentUploadLeadsForAdmin notification error", result.reason);
        }
      }
    }

    return res.status(200).json({
      message: changedItems.length > 0 ? "CRM upload assignments updated" : "No assignment changes to save",
      sourceBatchId,
      changedCount: changedItems.length,
      items: changedItems,
    });
  } catch (e: any) {
    console.error("reassignCrmAssignmentUploadLeadsForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to save CRM upload assignments" });
  }
};

export const deleteCrmImportFileAndLeads = async (req: AdminAuthRequest, res: Response) => {
  let deletionToken: string | undefined;
  try {
    const batchId = toNonEmptyString(req.params.batchId);
    if (!batchId) {
      return res.status(400).json({ message: "Batch id is required" });
    }

    const leads = await CrmLead.find({ sourceBatchId: batchId });
    if (leads.length === 0) {
      return res.status(404).json({ message: "Imported CRM file batch not found" });
    }
    const leadIds = leads.map(lead => lead._id);
    deletionToken = await reserveCrmLeadDeletion(leadIds);
    if (!deletionToken) return res.status(409).json({ message: CRM_CALENDAR_DELETE_CONFLICT });

    const mediaUrls: string[] = [];
    const currentSourceFiles = new Map<
      string,
      { bucketName: string; key: string }
    >();
    for (const lead of leads) {
      const sourceFileKey = toNonEmptyString((lead as any).sourceFileKey);
      if (
        sourceFileKey &&
        isCurrentCrmImportStorageTarget({
          sourceFileBucket: (lead as any).sourceFileBucket,
          sourceFilePublicBaseUrl: (lead as any).sourceFilePublicBaseUrl,
        })
      ) {
        const storage = resolveCrmImportStorageTarget({
          sourceFileBucket: (lead as any).sourceFileBucket,
          sourceFilePublicBaseUrl: (lead as any).sourceFilePublicBaseUrl,
        });
        currentSourceFiles.set(`${storage.bucketName}:${sourceFileKey}`, {
          bucketName: storage.bucketName,
          key: sourceFileKey,
        });
      }

      const updates = getUpdatesList(lead);
      for (const update of updates) {
        const attachments = Array.isArray((update as any).attachmentUrls)
          ? ((update as any).attachmentUrls as string[])
          : [];
        mediaUrls.push(...attachments);
        const rec = toNonEmptyString((update as any).recordingUrl);
        if (rec) mediaUrls.push(rec);
      }
    }

    await removeMediaFromR2(mediaUrls);
    await Promise.allSettled(
      Array.from(currentSourceFiles.values()).map(async ({ bucketName, key }) => {
        await deleteFromR2(bucketName, key);
      })
    );
    const deletedLeads = await deleteReservedCrmLeads(leadIds, deletionToken);

    return res.status(200).json({
      message: "Imported CRM file batch deleted",
      sourceBatchId: batchId,
      deletedLeads,
    });
  } catch (e: any) {
    console.error("deleteCrmImportFileAndLeads error", e);
    return res.status(500).json({ message: e?.message || "Failed to delete CRM import batch" });
  } finally {
    if (deletionToken) await releaseCrmLeadDeletion(deletionToken);
  }
};

export const transcribeCrmCommentAudio = async (req: AuthRequest, res: Response) => {
  try {
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const file = (req as any)?.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ message: "Audio file is required" });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: await toFile(file.buffer, file.originalname || "crm-comment-audio.webm", {
        type: file.mimetype || "audio/webm",
      }),
      model: "gpt-4o-mini-transcribe",
    });

    return res.status(200).json({ text: toNonEmptyString((transcription as any)?.text) });
  } catch (e: any) {
    console.error("transcribeCrmCommentAudio error", e);
    return res.status(500).json({ message: e?.message || "Failed to transcribe CRM audio" });
  }
};

export const updateCrmUserProfile = async (req: AdminAuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { crmAddress, crmQuadrant, crmSpecializations } = req.body || {};

    const user = await User.findById(id).select(
      "email username role isCrmAgent crmAddress crmQuadrant crmSpecializations"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Only regular users can have CRM profiles updated" });
    }

    const update: Record<string, any> = {};

    if (crmAddress !== undefined) {
      const address = toNonEmptyString(crmAddress);
      update.crmAddress = address;
      update.crmGeo = address ? await normalizeCrmGeoLocation(address) : undefined;
    }

    if (crmQuadrant !== undefined) {
      update.crmQuadrant = normalizeCrmQuadrants(crmQuadrant)
        .map((value) => value.toUpperCase())
        .join(",");
    }

    if (crmSpecializations !== undefined) {
      update.crmSpecializations = normalizeCrmSpecializations(crmSpecializations);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    await User.findByIdAndUpdate(id, { $set: update });

    const safe = await User.findById(id)
      .select("email username companyName contactEmail contactPhone crmAddress crmQuadrant crmSpecializations role isBlocked isVerified isCrmAgent crmAssignedAt crmAssignedBy createdAt")
      .populate("crmAssignedBy", "email username");

    return res.status(200).json({ user: safe });
  } catch (e) {
    console.error("updateCrmUserProfile error", e);
    return res.status(500).json({ message: "Failed to update CRM profile" });
  }
};

export const reassignCrmLeadsNearestForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const apply = parseBoolean(req.body?.apply);
    const includeClosed = parseBoolean(req.body?.includeClosed);
    const limit = Math.min(Math.max(Number(req.body?.limit || 100) || 100, 1), 500);
    const leadIds = parseStringArray(req.body?.leadIds).filter((id) => mongoose.Types.ObjectId.isValid(id));

    const crmUsers = await User.find({
      role: "user",
      isBlocked: { $ne: true },
      isCrmAgent: true,
      ...normalCrmUserFilter(),
    }).select("_id email username crmAddress crmQuadrant crmSpecializations expoPushTokens");
    if (crmUsers.length === 0) {
      return res.status(400).json({ message: "No active CRM users available for assignment" });
    }

    const filter: Record<string, any> = { isReviewData: { $ne: true } };
    if (leadIds.length > 0) {
      filter._id = { $in: leadIds };
    } else if (!includeClosed) {
      filter.status = { $nin: ["won", "lost"] };
    }

    const leadsToReview = await CrmLead.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("assignedTo", "email username crmAddress")
      .lean();

    const assigneeLoadMap = new Map<string, number>();
    const existingLoadCounts = await CrmLead.aggregate([
      { $match: { assignedTo: { $in: crmUsers.map((u) => (u as any)._id) }, isReviewData: { $ne: true } } },
      { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    ]);
    for (const entry of existingLoadCounts) {
      assigneeLoadMap.set(String(entry._id), entry.count);
    }

    const preparedAssignees = await prepareCrmAssignees(crmUsers as any[]);
    const items: any[] = [];
    let changedCount = 0;
    let appliedCount = 0;

    for (const lead of leadsToReview) {
      const leadGeo = await normalizeCrmGeoLocation(
        buildLeadGeoSource({
          companyLocation: toNonEmptyString((lead as any).companyLocation),
          contactLocation: toNonEmptyString((lead as any).contactLocation),
          companyPostCode: toNonEmptyString((lead as any).companyPostCode),
        })
      );
      const assignment = chooseNearestCrmAssignee({
        leadGeo,
        leadSpecialization: normalizeCrmSpecialization((lead as any).specialization),
        assignees: preparedAssignees,
        assigneeLoadMap,
      });

      const currentAssignee = (lead as any).assignedTo;
      const currentAssigneeId = String(currentAssignee?._id || currentAssignee || "");
      const proposedAssigneeId = String((assignment.assignee as any)?._id || "");
      const changed = Boolean(proposedAssigneeId && proposedAssigneeId !== currentAssigneeId);
      if (changed) changedCount += 1;

      if (apply) {
        const updateFields: Record<string, any> = {
          leadGeo: assignment.leadGeo,
          assignedUserGeo: assignment.assigneeGeo,
          assignmentMethod: assignment.method,
          assignmentDistanceKm: assignment.distanceKm,
          assignmentMatchedRegion: assignment.matchedRegion,
          assignmentReason: assignment.reason,
          quadrantPending: !assignment.leadGeo.regionCode && assignment.leadGeo.lat === undefined && assignment.leadGeo.lng === undefined,
        };
        if (changed) {
          updateFields.assignedTo = (assignment.assignee as any)._id;
          updateFields.assignedBy = req.userId;
          updateFields.dueSoonPushSentAt = undefined;
          updateFields.overduePushSentAt = undefined;
        }

        await CrmLead.updateOne({ _id: (lead as any)._id }, { $set: updateFields });
        appliedCount += 1;

        if (changed) {
          if (currentAssigneeId) {
            assigneeLoadMap.set(currentAssigneeId, Math.max(0, (assigneeLoadMap.get(currentAssigneeId) || 0) - 1));
          }
          assigneeLoadMap.set(proposedAssigneeId, (assigneeLoadMap.get(proposedAssigneeId) || 0) + 1);
        }
      }

      items.push({
        leadId: String((lead as any)._id || ""),
        clientName: toNonEmptyString((lead as any).clientName),
        companyName: toNonEmptyString((lead as any).companyName),
        location: buildLeadGeoSource({
          companyLocation: toNonEmptyString((lead as any).companyLocation),
          contactLocation: toNonEmptyString((lead as any).contactLocation),
          companyPostCode: toNonEmptyString((lead as any).companyPostCode),
        }),
        currentAssignee: currentAssigneeId
          ? {
              _id: currentAssigneeId,
              email: toNonEmptyString(currentAssignee?.email),
              username: toNonEmptyString(currentAssignee?.username),
            }
          : null,
        proposedAssignee: {
          _id: proposedAssigneeId,
          email: toNonEmptyString((assignment.assignee as any)?.email),
          username: toNonEmptyString((assignment.assignee as any)?.username),
          crmAddress: toNonEmptyString((assignment.assignee as any)?.crmAddress),
        },
        changed,
        method: assignment.method,
        distanceKm: assignment.distanceKm,
        matchedRegion: assignment.matchedRegion,
        reason: assignment.reason,
        leadGeo: assignment.leadGeo,
      });
    }

    return res.status(200).json({
      apply,
      reviewed: items.length,
      changedCount,
      appliedCount,
      items,
    });
  } catch (e: any) {
    console.error("reassignCrmLeadsNearestForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to recompute CRM lead assignment" });
  }
};

function parseCrmImportDraftRow(
  rawRow: ExcelRow,
  rowNumber: number,
  importDueDates: ImportDueDateConfig,
  rowIssues: Map<number, string[]>
): ParsedImportDraft | null {
  const row = toKeyLookup(rawRow);
  const providedTitle = toNonEmptyString(
    pickField(row, ["title", "task", "task title", "designation", "role", "job title", "position"])
  );
  const title = providedTitle || "CRM Follow-up";
  const companyName = toNonEmptyString(
    pickField(row, ["company name - cleaned", "company", "company name", "business", "organization"])
  );
  const providedClientName = deriveProvidedClientName(row);
  const emailPrimary = toNonEmptyString(pickField(row, ["email 1"])).toLowerCase();
  const emailSecondary = toNonEmptyString(pickField(row, ["email 2"])).toLowerCase();
  const personalEmail = toNonEmptyString(pickField(row, ["personal email"])).toLowerCase();
  const email = extractPrimaryEmail(
    [emailPrimary, emailSecondary, personalEmail].filter(Boolean).join(" ") ||
      (pickField(row, ["email", "emails", "email address", "mail", "e-mail"]) as any)
  );

  const contactPhones = collectPhoneValues(row, ["contact phone 1", "contact phone 2", "contact phone 3"]);
  const contactMobilePhones = collectPhoneValues(row, [
    "contact mobile phone",
    "contact mobile phone 2",
    "contact mobile phone 3",
  ]);
  const companyPhones = collectPhoneValues(row, ["company phone 1", "company phone 2", "company phone 3"]);
  const primaryPhoneCandidate =
    contactPhones[0] ||
    contactMobilePhones[0] ||
    companyPhones[0] ||
    extractPrimaryPhone(
      pickField(row, ["phone", "phones", "phone number", "number", "mobile", "contact number", "telephone"])
    );
  const phoneInfo = formatCanadaPhone(toNonEmptyString(primaryPhoneCandidate));
  const clientName = deriveClientName({
    providedClientName,
    title: providedTitle,
    companyName,
    email,
  });
  const notes = toNonEmptyString(pickField(row, ["notes", "note", "comments", "comment", "remarks"]));
  const contactSocials = composeImportSocials(row);
  const companyLocation = composeImportLocation(row);
  const contactLocation = toNonEmptyString(pickField(row, ["contact location", "location", "address"]));
  const contactLinkedinUrl = toNonEmptyString(
    pickField(row, ["contact li profile url", "contact linkedin", "linkedin", "linkedin profile"])
  );
  const companyLinkedinUrl = toNonEmptyString(
    pickField(row, ["company li profile url", "company linkedin"])
  );
  const industry = toNonEmptyString(pickField(row, ["company industry", "industry", "sector"]));
  const website = toNonEmptyString(pickField(row, ["website", "company website domain", "site", "url", "web"]));
  const companyWebsiteDomain = toNonEmptyString(pickField(row, ["company website domain", "website"]));
  const quadrant = resolveLeadQuadrant(row, companyLocation, contactLocation);
  const researchDate = parseDateValue(pickField(row, ["research date"]));
  const rowDueDate =
    importDueDates.rowDueDates.get(rowNumber) ||
    importDueDates.defaultDueDate ||
    parseImportDueDateValue(pickField(row, ["due date", "due", "task due date", "deadline", "follow up date"]));
  const department = toNonEmptyString(pickField(row, ["department"]));
  const seniority = toNonEmptyString(pickField(row, ["seniority"]));
  const companyDescription = toNonEmptyString(pickField(row, ["company description", "description"]));
  const companyAnnualRevenue = parseOptionalNumber(pickField(row, ["company annual revenue"]));
  const companyRevenueRange = toNonEmptyString(pickField(row, ["company revenue range"]));
  const companyStaffCount = parseOptionalNumber(pickField(row, ["company staff count"]));
  const companyStaffCountRange = toNonEmptyString(pickField(row, ["company staff count range"]));
  const companyFoundedDate = parseYearOrDateValue(pickField(row, ["company founded date"]));
  const companyPostCode = toNonEmptyString(pickField(row, ["company post code"]));
  const sicCode = toNonEmptyString(pickField(row, ["sic code"]));
  const naicsCode = toNonEmptyString(pickField(row, ["naics code"]));
  const importData = buildImportDataSnapshot(rawRow);
  const parsedLists = parseListItems(
    pickField(row, ["list", "lists", "list name", "lead list", "segment", "tags"])
  );
  if (parsedLists.hasInlineDuplicates) {
    addRowIssue(rowIssues, rowNumber, "Duplicate list items inside the same row");
  }
  const priorityRaw = toNonEmptyString(pickField(row, ["priority"])).toLowerCase();
  const priority =
    priorityRaw === "high" || priorityRaw === "low" || priorityRaw === "medium"
      ? priorityRaw
      : "medium";
  const hasAnyRowSignal = Boolean(
    providedClientName ||
      providedTitle ||
      companyName ||
      email ||
      phoneInfo.raw ||
      contactPhones.length > 0 ||
      companyPhones.length > 0 ||
      contactMobilePhones.length > 0 ||
      notes ||
      contactSocials ||
      companyLocation ||
      contactLocation ||
      quadrant ||
      industry ||
      website ||
      parsedLists.original.length > 0
  );
  if (!hasAnyRowSignal) return null;

  const specialization = resolveLeadSpecialization(row, {
    title,
    companyName,
    industry,
    notes,
    companyDescription,
    website,
    listItems: parsedLists.original,
  });
  const category = toNonEmptyString(
    pickField(row, ["category", "categories", "lead category", "crm category"])
  );
  const identityKey = buildIdentityKey({
    email,
    phoneRaw: phoneInfo.raw,
    clientName,
    companyName,
  });

  return {
    rowNumber,
    title,
    clientName,
    companyName: companyName || undefined,
    email: email || undefined,
    phoneRaw: phoneInfo.raw || undefined,
    phoneFormatted: phoneInfo.formatted || undefined,
    contactPhones,
    companyPhones,
    contactMobilePhones,
    notes: notes || undefined,
    contactSocials: contactSocials || undefined,
    contactLocation: contactLocation || undefined,
    contactLinkedinUrl: contactLinkedinUrl || undefined,
    companyLinkedinUrl: companyLinkedinUrl || undefined,
    companyLocation: companyLocation || undefined,
    quadrant: quadrant || undefined,
    specialization: specialization || undefined,
    category: category || specialization || undefined,
    industry: industry || undefined,
    website: website || undefined,
    companyWebsiteDomain: companyWebsiteDomain || undefined,
    researchDate,
    department: department || undefined,
    seniority: seniority || undefined,
    companyDescription: companyDescription || undefined,
    companyAnnualRevenue,
    companyRevenueRange: companyRevenueRange || undefined,
    companyStaffCount,
    companyStaffCountRange: companyStaffCountRange || undefined,
    companyFoundedDate,
    companyPostCode: companyPostCode || undefined,
    sicCode: sicCode || undefined,
    naicsCode: naicsCode || undefined,
    importData,
    listItems: parsedLists.original,
    listItemsNormalized: parsedLists.normalized,
    identityKey,
    dedupeFingerprints: buildDedupeFingerprints(identityKey, parsedLists.normalized),
    taskStartDate: undefined,
    dueDate: rowDueDate,
    priority,
  };
}

type DurableCrmImportPayload = {
  jobId: string;
  sourceBatchId: string;
  sourceFileName: string;
  sourceFileUrl: string;
  sourceFileKey: string;
  sourceFileBucket?: string;
  sourceFilePublicBaseUrl?: string;
  selectedUserIds: string[];
  assignedBy: string;
  duplicateMode: "skip" | "error";
  defaultDueDate?: string;
  dueDateOverrides?: Array<{ rowNumber: number; dueDate: string }>;
};

function importDueDateConfigFromPayload(payload: DurableCrmImportPayload): ImportDueDateConfig {
  const rowDueDates = new Map<number, Date>();
  for (const override of payload.dueDateOverrides || []) {
    const dueDate = parseImportDueDateValue(override.dueDate);
    if (Number.isInteger(override.rowNumber) && override.rowNumber > 1 && dueDate) {
      rowDueDates.set(override.rowNumber, dueDate);
    }
  }
  return {
    defaultDueDate: parseImportDueDateValue(payload.defaultDueDate),
    rowDueDates,
  };
}

/**
 * Process a CRM spreadsheet from its durable R2 source in bounded batches.
 * The worker never retains the entire worksheet, which keeps memory stable for
 * six-figure row counts and makes retries safe after a process restart.
 */
export async function runDurableCrmImportJob(job: IReportJob): Promise<void> {
  const payload = (job.payload || {}) as Partial<DurableCrmImportPayload>;
  const jobId = toNonEmptyString(payload.jobId || job.progressId);
  const sourceFileKey = toNonEmptyString(payload.sourceFileKey);
  const sourceFileName = toNonEmptyString(payload.sourceFileName) || "crm-import.xlsx";
  const sourceBatchId = toNonEmptyString(payload.sourceBatchId);
  const storage = resolveCrmImportStorageTarget({
    sourceFileBucket: payload.sourceFileBucket,
    sourceFilePublicBaseUrl: payload.sourceFilePublicBaseUrl,
  });
  const bucketName = toNonEmptyString(storage.bucketName);
  if (!jobId || !sourceFileKey || !sourceBatchId || !bucketName) {
    throw new Error("CRM import job is missing its durable source metadata");
  }

  const tempDirectory = path.join(os.tmpdir(), "asset-insight-crm-import-worker");
  await fs.promises.mkdir(tempDirectory, { recursive: true });
  const extension = path.extname(sourceFileName).toLowerCase() || ".xlsx";
  const tempFilePath = path.join(tempDirectory, `${jobId}-${Date.now()}${extension}`);
  const batchSize = Math.max(100, Math.min(5000, Number(process.env.CRM_IMPORT_BATCH_SIZE || 1000)));
  const importDueDates = importDueDateConfigFromPayload(payload as DurableCrmImportPayload);
  const selectedUserIds = Array.isArray(payload.selectedUserIds)
    ? payload.selectedUserIds.map((value) => toNonEmptyString(value)).filter(Boolean)
    : [];
  const assignmentContext = await createCrmImportAssignmentContext(selectedUserIds);

  let scannedRows = 0;
  let validRows = 0;
  // A stable source batch id is the retry boundary. Already committed rows contribute
  // to progress instead of being recreated when a worker resumes after interruption.
  let importedCount = await CrmLead.countDocuments({ sourceBatchId });
  let duplicateCount = 0;
  let errorCount = 0;
  let sourceSheetName = "Imported Sheet";
  let batch: ParsedImportDraft[] = [];
  let batchIssues = new Map<number, string[]>();
  const duplicateRows: Array<{ rowNumber: number; reasons: string[] }> = [];

  const updateProgress = async (message: string, progress?: number) => {
    const boundedProgress = Math.max(1, Math.min(95, progress ?? 5 + Math.floor(scannedRows / 2000)));
    await CrmImportJob.updateOne(
      { jobId },
      {
        $set: {
          status: "processing",
          processedRows: scannedRows,
          importedCount,
          duplicateCount,
          errorCount,
          progress: boundedProgress,
          message,
        },
      }
    );
  };

  const flushBatch = async () => {
    if (!batch.length) return;
    const currentBatch = batch;
    const currentIssues = batchIssues;
    batch = [];
    batchIssues = new Map<number, string[]>();

    const result = await assignAndInsertCrmDrafts({
      parsedDrafts: currentBatch,
      selectedUserIds,
      assignedBy: payload.assignedBy,
      sourceBatchId,
      sourceFileName,
      sourceFileUrl: payload.sourceFileUrl,
      sourceFileKey,
      sourceFileBucket: storage.bucketName,
      sourceFilePublicBaseUrl: storage.publicBaseUrl,
      sourceSheetName,
      rowIssues: currentIssues,
      notifyReason: "assignment",
      failOnDuplicate: payload.duplicateMode === "error",
      insertMode: "bulk",
      geoMode: "heuristic",
      // A 150k-row import must not emit one email/push per batch. The job table
      // is the authoritative progress surface for bulk imports.
      notifyAssignments: false,
      assignmentContext,
    });
    if (result.aborted) {
      throw new Error("Duplicate CRM rows were found and duplicate mode is set to fail");
    }
    importedCount += result.inserted.length;
    duplicateCount += result.duplicateCount;
    errorCount += result.errorCount;
    if (duplicateRows.length < 100) {
      duplicateRows.push(...result.duplicateRows.slice(0, 100 - duplicateRows.length));
    }
    await updateProgress(`Processed ${scannedRows.toLocaleString()} spreadsheet rows`);
  };

  try {
    await updateProgress("Downloading the uploaded spreadsheet", 2);
    await downloadR2ObjectToFile(bucketName, sourceFileKey, tempFilePath);
    await updateProgress("Reading and importing spreadsheet rows", 5);

    const streamed = await streamFirstWorksheetRowsFromFile(
      tempFilePath,
      sourceFileName,
      async (rawRow, rowNumber) => {
        scannedRows += 1;
        const parsed = parseCrmImportDraftRow(rawRow, rowNumber, importDueDates, batchIssues);
        if (parsed) {
          validRows += 1;
          batch.push(parsed);
        }
        if (batch.length >= batchSize) await flushBatch();
      }
    );
    sourceSheetName = streamed.sheetName;
    await flushBatch();
    if (!validRows) {
      throw new SpreadsheetImportError(
        "EMPTY_WORKBOOK",
        "No valid CRM rows were found."
      );
    }

    // XLSX streaming discovers the worksheet name while reading. Normalize
    // rows committed by earlier batches once that authoritative name is known.
    await CrmLead.updateMany(
      { sourceBatchId, sourceSheetName: { $ne: sourceSheetName } },
      { $set: { sourceSheetName } }
    );

    // On retry, rows already committed under this source batch are counted as
    // imported rather than duplicated so the final result remains idempotent.
    importedCount = await CrmLead.countDocuments({ sourceBatchId });
    await CrmImportJob.updateOne(
      { jobId },
      {
        $set: {
          status: "completed",
          sourceSheetName,
          totalRows: streamed.rowCount,
          processedRows: streamed.rowCount,
          importedCount,
          duplicateCount,
          errorCount,
          progress: 100,
          message: importedCount > 0 ? "CRM import completed" : "CRM import completed with no new leads",
          duplicateRows,
          completedAt: new Date(),
        },
        $unset: { error: 1 },
      }
    );
  } finally {
    await fs.promises.unlink(tempFilePath).catch(() => undefined);
  }
}

/**
 * Accept the upload, persist it to R2, and enqueue a Mongo-backed worker job.
 * Parsing is intentionally excluded from the request lifecycle.
 */
export const importCrmLeadsFromExcel = async (req: AdminAuthRequest, res: Response) => {
  const file = (req as any)?.file as Express.Multer.File | undefined;
  let queuedImportJobId = "";
  try {
    if (!file?.path) {
      return res.status(400).json({ message: "Spreadsheet file is required" });
    }

    const fileType = await validateSpreadsheetFile(file.path, file.originalname || "crm-import.xlsx");
    const selectedIds = parseStringArray((req.body as any)?.assignedToUserIds);
    if (selectedIds.length && await User.exists({ _id: { $in: selectedIds }, isReviewAccount: true })) {
      return res.status(400).json({ message: "Review accounts cannot receive production CRM imports" });
    }
    const duplicateModeRaw = toNonEmptyString((req.body as any)?.duplicateMode).toLowerCase();
    const duplicateMode: "skip" | "error" =
      duplicateModeRaw === "error" || duplicateModeRaw === "fail" ? "error" : "skip";
    const dueDates = parseImportDueDateConfig(req.body);
    const sourceBatchId = `crm-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jobId = `crm-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceUpload = await uploadCrmImportSource(file, "crm/imports");
    const dueDateOverrides = Array.from(dueDates.rowDueDates.entries()).map(([rowNumber, dueDate]) => ({
      rowNumber,
      dueDate: dueDate.toISOString(),
    }));

    await CrmImportJob.create({
      jobId,
      sourceBatchId,
      sourceFileName: file.originalname || undefined,
      sourceFileUrl: sourceUpload.url,
      sourceFileKey: sourceUpload.key,
      sourceFileBucket: sourceUpload.sourceFileBucket,
      sourceFilePublicBaseUrl: sourceUpload.sourceFilePublicBaseUrl,
      fileType,
      status: "queued",
      totalRows: 0,
      processedRows: 0,
      importedCount: 0,
      duplicateCount: 0,
      errorCount: 0,
      progress: 0,
      message: "Uploaded; waiting for the CRM import worker",
      selectedAssigneeIds: selectedIds,
      duplicateMode,
      defaultDueDate: dueDates.defaultDueDate,
      dueDateOverrides,
      createdBy: req.userId,
    });
    queuedImportJobId = jobId;

    const durableJob = await createMongoReportJob({
      type: "crm-import",
      progressId: jobId,
      payload: {
        jobId,
        sourceBatchId,
        sourceFileName: file.originalname || "crm-import.xlsx",
        sourceFileUrl: sourceUpload.url,
        sourceFileKey: sourceUpload.key,
        sourceFileBucket: sourceUpload.sourceFileBucket,
        sourceFilePublicBaseUrl: sourceUpload.sourceFilePublicBaseUrl,
        selectedUserIds: selectedIds,
        assignedBy: String(req.userId || ""),
        duplicateMode,
        defaultDueDate: dueDates.defaultDueDate?.toISOString(),
        dueDateOverrides,
      } satisfies DurableCrmImportPayload,
      maxAttempts: 3,
      idempotencyKey: `crm-import:${sourceBatchId}`,
    });
    await CrmImportJob.updateOne({ jobId }, { $set: { durableJobId: durableJob?._id } });

    return res.status(202).json({
      message: "CRM spreadsheet uploaded and queued for server processing",
      jobId,
      sourceBatchId,
      status: "queued",
      totalRows: 0,
      processedRows: 0,
      importedCount: 0,
      duplicateCount: 0,
      errorCount: 0,
      progress: 0,
    });
  } catch (error: any) {
    console.error("importCrmLeadsFromExcel error", error);
    if (queuedImportJobId) {
      await CrmImportJob.updateOne(
        { jobId: queuedImportJobId, status: "queued" },
        {
          $set: {
            status: "failed",
            message: "The CRM import could not be queued. Please upload the file again.",
            error: error?.message || "Failed to create the durable import job",
            completedAt: new Date(),
          },
        }
      ).catch((updateError) => {
        console.error("Failed to mark orphaned CRM import as failed", updateError);
      });
    }
    if (error instanceof SpreadsheetImportError) {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    return res.status(500).json({ message: error?.message || "Failed to queue CRM spreadsheet import" });
  } finally {
    if (file?.path) await fs.promises.unlink(file.path).catch(() => undefined);
  }
};

async function resolveQuadrantsPendingInBackground(leadIds: string[]): Promise<void> {
  if (!leadIds.length) return;

  console.log(`[QuadrantResolver] Starting background resolution for ${leadIds.length} leads`);

  const crmUsers = await User.find({
    role: "user",
    isBlocked: { $ne: true },
    isCrmAgent: true,
    ...normalCrmUserFilter(),
  }).select("_id email username crmAddress crmQuadrant crmSpecializations isReviewAccount");

  if (crmUsers.length === 0) {
    console.warn("[QuadrantResolver] No CRM agents available for reassignment");
    return;
  }

  const assigneeLoadMap = new Map<string, number>();
  const existingCounts = await CrmLead.aggregate([
    { $match: { assignedTo: { $in: crmUsers.map((u) => (u as any)._id) }, isReviewData: { $ne: true } } },
    { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
  ]);
  for (const entry of existingCounts) {
    assigneeLoadMap.set(String(entry._id), entry.count);
  }

  let resolved = 0;
  let reassigned = 0;

  for (const leadId of leadIds) {
    try {
      const lead = await CrmLead.findOne({ _id: leadId, isReviewData: { $ne: true } });
      if (!lead) continue;
      if (!(lead as any).quadrantPending) continue;

      const addressParts: string[] = [];
      const companyLocation = toNonEmptyString((lead as any).companyLocation);
      const contactLocation = toNonEmptyString((lead as any).contactLocation);
      const companyPostCode = toNonEmptyString((lead as any).companyPostCode);
      if (companyLocation) addressParts.push(companyLocation);
      if (contactLocation && contactLocation !== companyLocation) addressParts.push(contactLocation);
      if (companyPostCode) addressParts.push(companyPostCode);

      const addressText = addressParts.join(", ").trim();

      let quadrant = "";
      if (addressText) {
        quadrant = await resolveQuadrantViaOpenAI(addressText);
      }

      const updateFields: Record<string, any> = { quadrantPending: false };
      if (quadrant) {
        updateFields.quadrant = quadrant;
      }

      let reassignedAgentId = "";

      if (quadrant) {
        const bestAgent = chooseAssigneeForLead(
          quadrant,
          normalizeCrmSpecialization((lead as any).specialization),
          [companyLocation, contactLocation, companyPostCode, quadrant],
          crmUsers as any[],
          assigneeLoadMap
        );
        const bestAgentId = String((bestAgent as any)?._id || "");
        const currentAssignee = String((lead as any).assignedTo || "");

        if (bestAgentId && bestAgentId !== currentAssignee) {
          updateFields.assignedTo = bestAgent._id;
          updateFields.dueSoonPushSentAt = undefined;
          updateFields.overduePushSentAt = undefined;
          reassignedAgentId = bestAgentId;
          if (currentAssignee) {
            const oldLoad = assigneeLoadMap.get(currentAssignee) || 0;
            assigneeLoadMap.set(currentAssignee, Math.max(0, oldLoad - 1));
          }
          assigneeLoadMap.set(bestAgentId, (assigneeLoadMap.get(bestAgentId) || 0) + 1);
          reassigned += 1;
        }
      }

      await CrmLead.updateOne({ _id: lead._id }, { $set: updateFields });

      if (reassignedAgentId) {
        await sendCrmNewTaskNotification({
          userId: reassignedAgentId,
          leadId: String((lead as any)._id || leadId),
          clientName: toNonEmptyString((lead as any).clientName),
          title: toNonEmptyString((lead as any).title),
          count: 1,
          reason: "reassignment",
        }).catch((err) => {
          console.error("resolveQuadrantsPendingInBackground push error", err);
        });
      }

      resolved += 1;
    } catch (leadErr) {
      console.error(`[QuadrantResolver] Failed for lead ${leadId}`, leadErr);
    }
  }

  console.log(`[QuadrantResolver] Completed. Resolved=${resolved}, Reassigned=${reassigned}`);
}

 export const listCrmLeadsForAdmin = async (req: Request, res: Response) => {
   try {
     const { q, status, assignedTo, from, to, year } = req.query as Record<string, string | undefined>;
    const selectedMonths = parseMonthQueryValues((req.query as Record<string, unknown>).months);
    const parsedYear = Number.parseInt(String(year || ""), 10);
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "25", 10) || 25, 1), 200);

    const filter: Record<string, any> = {};
    const andFilters: Record<string, any>[] = [];

    if (status === "archived") {
      andFilters.push(buildNormalizedStatusMatch("won"));
    } else if (status && isCrmStatus(status)) {
      andFilters.push(buildNormalizedStatusMatch(status));
    }

    if (assignedTo) {
      filter.assignedTo = assignedTo;
    }

    if (from || to) {
      const createdAtFilter: Record<string, Date> = {};
      const fromDate = parseDateFilterBoundary(from, "start");
      const toDate = parseDateFilterBoundary(to, "end");
      if (fromDate) createdAtFilter.$gte = fromDate;
      if (toDate) createdAtFilter.$lte = toDate;
      if (Object.keys(createdAtFilter).length > 0) {
        andFilters.push({ createdAt: createdAtFilter });
      }
    } else if (selectedMonths.length > 0 && Number.isFinite(parsedYear) && parsedYear >= 1970 && parsedYear <= 9999) {
      andFilters.push({
        $or: selectedMonths.map((month) => {
          const start = new Date(Date.UTC(parsedYear, month - 1, 1, 0, 0, 0, 0));
          const end = new Date(Date.UTC(parsedYear, month, 0, 23, 59, 59, 999));
          return { createdAt: { $gte: start, $lte: end } };
        }),
      });
    }

    if (q) {
      const regex = new RegExp(q, "i");
      andFilters.push({
        $or: [
          { clientName: regex },
          { email: regex },
          { phoneFormatted: regex },
          { companyName: regex },
          { companyLocation: regex },
          { category: regex },
          { industry: regex },
          { website: regex },
          { contactSocials: regex },
          { listItems: regex },
          { notes: regex },
          { latestComment: regex },
        ],
      });
    }

    if (andFilters.length > 0) {
      filter.$and = andFilters;
    }

    const normalizedFilteredStatus =
      status === "archived" ? "won" : status && isCrmStatus(status) ? status : "";
    const overduePromise =
      normalizedFilteredStatus === "won" || normalizedFilteredStatus === "lost"
        ? Promise.resolve(0)
        : CrmLead.aggregate([
            {
              $match: {
                ...filter,
                dueDate: { $lt: new Date() },
              },
            },
            {
              $addFields: {
                normalizedStatus: buildNormalizedCrmStatusExpression(),
              },
            },
            ...(normalizedFilteredStatus
              ? []
              : [
                  {
                    $match: {
                      normalizedStatus: { $nin: ["won", "lost"] },
                    },
                  },
                ]),
            { $count: "count" },
          ]).then((rows: Array<{ count?: number }>) => Number(rows?.[0]?.count || 0));

    const [items, total, rawStatusCounts, overdueCount, leadSourceCounts] = await Promise.all([
      CrmLead.find(filter)
        .sort({ dueDate: 1, taskStartDate: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("assignedTo", "email username")
        .populate("assignedBy", "email username")
        .populate("updates.createdBy", "email username role"),
      CrmLead.countDocuments(filter),
      CrmLead.aggregate([
        { $match: filter },
        {
          $addFields: {
            normalizedStatus: buildNormalizedCrmStatusExpression(),
          },
        },
        {
          $group: {
            _id: "$normalizedStatus",
            count: { $sum: 1 },
          },
        },
      ]),
      overduePromise,
      getCrmLeadSourceCounts(filter),
    ]);

    let shouldPersistNormalizedItems = false;
    for (const item of items) {
      shouldPersistNormalizedItems = normalizeCrmLeadDocument(item) || shouldPersistNormalizedItems;
    }
    if (shouldPersistNormalizedItems) {
      await Promise.all(items.map((item) => item.save()));
    }

    const statusCounts = CRM_LEAD_STATUSES.map((crmStatus) => ({
      _id: crmStatus,
      count:
        Number(
          (rawStatusCounts as Array<{ _id?: string; count?: number }>).find((entry) => entry?._id === crmStatus)?.count || 0
        ) || 0,
    })).filter((entry) => entry.count > 0);

    return res.status(200).json({
      items,
      total,
      page,
      limit,
      statusCounts,
      overdueCount,
      leadSourceCounts,
    });
  } catch (e) {
    console.error("listCrmLeadsForAdmin error", e);
    return res.status(500).json({ message: "Failed to fetch CRM leads" });
  }
};

const CRM_TASK_SUMMARY_FIELDS = [
  "_id", "title", "clientName", "companyName", "email", "phoneRaw", "phoneFormatted",
  "status", "lostReason", "leadSource", "priority", "dueDate", "taskStartDate",
  "latestComment", "callAttempts", "lastCalledAt", "statusChangedAt", "createdAt",
  "updatedAt", "updateCount", "assignedTo", "assignedBy", ...CRM_FOLLOW_UP_READ_FIELDS,
];

// Project before returning rows from Mongo so lists never materialize every
// timeline/media entry in the API process. Hydration normalizes the projected
// presentation fields without ever saving a partial row.
async function loadCrmTaskReadRows(
  filter: Record<string, any>,
  options: { summary: boolean; page?: number; limit?: number }
) {
  const pipeline: mongoose.PipelineStage[] = [{ $match: normalizeCrmAggregateMatchFilter(filter) }];
  if (options.page !== undefined && options.limit !== undefined) {
    pipeline.push(
      { $sort: { dueDate: 1, taskStartDate: 1, createdAt: -1 } },
      { $skip: (options.page - 1) * options.limit },
      { $limit: options.limit },
    );
  }
  pipeline.push(
    { $addFields: { updateCount: { $size: { $ifNull: ["$updates", []] } } } },
    options.summary
      ? { $project: Object.fromEntries(CRM_TASK_SUMMARY_FIELDS.map(field => [field, 1])) }
      : { $unset: ["updates", "followUpOutlookOperation", "crmDeletionToken"] },
  );
  const rows = await CrmLead.aggregate(pipeline);
  const items = rows.map((row) => {
    const lead = CrmLead.hydrate(row);
    normalizeCrmLeadDocument(lead);
    const item: Record<string, any> = { ...lead.toObject(), updateCount: row.updateCount };
    if (options.summary) return Object.fromEntries(CRM_TASK_SUMMARY_FIELDS.map(field => [field, item[field]]));
    delete item.updates;
    return item;
  });
  const match = filter.isReviewData === true ? { isReviewAccount: true } : undefined;
  return CrmLead.populate(items, options.summary
    ? [{ path: "assignedBy", select: "email username", match }]
    : [
      { path: "assignedBy", select: "email username role", match },
      { path: "assignedTo", select: "email username role", match },
    ]);
}

async function hasCrmTaskReadAccess(req: AuthRequest, res: Response): Promise<boolean> {
  const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
  if (!me) res.status(404).json({ message: "User not found" });
  else if ((me as any).isBlocked) res.status(403).json({ message: "Account is blocked" });
  else if (!(me as any).isCrmAgent) res.status(403).json({ message: "CRM access is not enabled for this account" });
  else return true;
  return false;
}

export const getMyCrmDashboard = async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!await hasCrmTaskReadAccess(req, res)) return;
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ message: "CRM dashboard does not accept query parameters" });
    }

    const asOf = new Date();
    const upcomingCutoff = new Date(asOf.getTime() + 7 * 24 * 60 * 60 * 1000);
    const isOpen = { $not: [{ $in: ["$status", ["won", "lost"]] }] };
    const hasDueDate = { $eq: [{ $type: "$dueDate" }, "date"] };
    const overdue = { $and: [isOpen, hasDueDate, { $lt: ["$dueDate", asOf] }] };
    const upcoming = { $and: [isOpen, hasDueDate, { $gte: ["$dueDate", asOf] }, { $lte: ["$dueDate", upcomingCutoff] }] };
    const previewFields = {
      _id: 1, title: 1, clientName: 1, companyName: 1, status: 1, lostReason: 1, dueDate: 1, taskStartDate: 1,
      followUpDate: 1, followUpTime: 1, followUpTimeZone: 1,
    };
    const dueRows = (predicate: Record<string, any>): mongoose.PipelineStage.FacetPipelineStage[] => [
      { $match: { $expr: predicate } },
      { $sort: { dueDate: 1, taskStartDate: 1, createdAt: -1, _id: 1 } },
      { $limit: 5 },
      { $project: previewFields },
    ];

    // Read only scalar dashboard fields before the facets: no embedded history,
    // imports, media, population, or sampled-page count reconstruction is needed.
    const [result] = await CrmLead.aggregate([
      { $match: { assignedTo: new mongoose.Types.ObjectId(req.userId), ...crmLeadCohortFilter(req.user) } },
      { $project: {
        ...previewFields,
        createdAt: 1,
        status: buildNormalizedCrmStatusExpression(),
        leadSource: buildCrmLeadSourceExpression(),
      } },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          generic: { $sum: { $cond: [{ $eq: ["$leadSource", "generic"] }, 1, 0] } },
          organic: { $sum: { $cond: [{ $eq: ["$leadSource", "organic"] }, 1, 0] } },
          overdue: { $sum: { $cond: [overdue, 1, 0] } },
          upcoming: { $sum: { $cond: [upcoming, 1, 0] } },
        } }],
        statusCounts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        overdueTasks: dueRows(overdue),
        upcomingTasks: dueRows(upcoming),
      } },
    ]);
    const totals = result?.totals?.[0] || { total: 0, generic: 0, organic: 0, overdue: 0, upcoming: 0 };
    const statusCounts = CRM_LEAD_STATUSES.map(status => ({
      _id: status,
      count: result?.statusCounts?.find((entry: { _id: string }) => entry._id === status)?.count || 0,
    }));
    const normalizeRows = (items: Record<string, any>[] = []) => items.map(item => {
      const { status, lostReason } = normalizeCrmStatusValue(item.status, item.lostReason);
      return { ...item, status, lostReason };
    });

    return res.status(200).json({
      asOf: asOf.toISOString(),
      total: totals.total,
      statusCounts,
      leadSourceCounts: { total: totals.total, generic: totals.generic, organic: totals.organic },
      dueCounts: { overdue: totals.overdue, upcoming: totals.upcoming },
      overdueTasks: normalizeRows(result?.overdueTasks),
      upcomingTasks: normalizeRows(result?.upcomingTasks),
    });
  } catch (error) {
    console.error("getMyCrmDashboard error", error);
    return res.status(500).json({ message: "Failed to fetch CRM dashboard" });
  }
};

/** Longest range the follow-up calendar reads at once (a month view plus its edges). */
const CRM_FOLLOW_UP_CALENDAR_MAX_DAYS = 62;
const CRM_FOLLOW_UP_CALENDAR_FIELDS =
  "_id title clientName companyName phoneRaw phoneFormatted status lostReason leadSource dueDate latestComment " +
  CRM_FOLLOW_UP_READ_FIELDS.join(" ");

/**
 * The agent's follow-up calendar (owner decision 2026-10-11): their open leads
 * with a follow-up date from `from` to `to` (calendar dates in `timeZone`, at
 * most 62 days), plus every follow-up that has already passed ("overdue",
 * oldest first). GET /api/crm/tasks/follow-ups?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=IANA
 */
export const getMyCrmFollowUps = async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!await hasCrmTaskReadAccess(req, res)) return;
    const timeZone = toNonEmptyString(req.query.timeZone) || CRM_FOLLOW_UP_DEFAULT_TIME_ZONE;
    if (!isValidTimeZone(timeZone)) return res.status(400).json({ message: "Unknown time zone" });
    const from = toNonEmptyString(req.query.from);
    const to = toNonEmptyString(req.query.to);
    if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) {
      return res.status(400).json({ message: "from and to must be dates (YYYY-MM-DD), from first" });
    }
    if (calendarDaysBetween(from, to) > CRM_FOLLOW_UP_CALENDAR_MAX_DAYS) {
      return res.status(400).json({ message: `Ask for at most ${CRM_FOLLOW_UP_CALENDAR_MAX_DAYS} days at a time` });
    }

    const asOf = new Date();
    const rangeStart = zonedWallTimeToUtc(from, 0, 0, timeZone);
    const rangeEnd = zonedWallTimeToUtc(addCalendarDays(to, 1), 0, 0, timeZone);
    const owned = {
      assignedTo: new mongoose.Types.ObjectId(req.userId),
      ...crmLeadCohortFilter(req.user),
      status: { $in: CRM_OPEN_STATUSES },
    };
    const [items, overdue] = await Promise.all([
      CrmLead.find({ ...owned, followUpAt: { $gte: rangeStart, $lt: rangeEnd } })
        .select(CRM_FOLLOW_UP_CALENDAR_FIELDS).sort({ followUpAt: 1, _id: 1 }).limit(1000).lean(),
      CrmLead.find({ ...owned, followUpAt: { $exists: true }, dueDate: { $lt: asOf } })
        .select(CRM_FOLLOW_UP_CALENDAR_FIELDS).sort({ dueDate: 1, _id: 1 }).limit(200).lean(),
    ]);
    const normalizeRows = (rows: Record<string, any>[]) => rows.map(row => {
      const { status, lostReason } = normalizeCrmStatusValue(row.status, row.lostReason);
      return { ...row, status, lostReason };
    });

    return res.status(200).json({
      asOf: asOf.toISOString(),
      from,
      to,
      timeZone,
      items: normalizeRows(items),
      overdue: normalizeRows(overdue),
    });
  } catch (error) {
    console.error("getMyCrmFollowUps error", error);
    return res.status(500).json({ message: "Failed to fetch CRM follow-ups" });
  }
};

export const getMyCrmTaskDetails = async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = req.params.id;
    if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid CRM task id" });
    }
    if (!await hasCrmTaskReadAccess(req, res)) return;
    const [item] = await loadCrmTaskReadRows({
      _id: new mongoose.Types.ObjectId(id), assignedTo: req.userId,
      ...crmLeadCohortFilter(req.user),
    }, { summary: false });
    if (!item) return res.status(404).json({ message: "CRM task not found" });
    return res.status(200).json({ item });
  } catch (error) {
    console.error("getMyCrmTaskDetails error", error);
    return res.status(500).json({ message: "Failed to fetch CRM task" });
  }
};

export const getMyCrmTaskUpdates = async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = req.params.id;
    if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid CRM task id" });
    }
    const rawPage = req.query.page ?? "1";
    const rawLimit = req.query.limit ?? "20";
    const page = typeof rawPage === "string" ? Number(rawPage) : Number.NaN;
    const limit = typeof rawLimit === "string" ? Number(rawLimit) : Number.NaN;
    if (typeof rawPage !== "string" || !/^[1-9]\d*$/.test(rawPage)
      || typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)
      || !Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit > 50
      || !Number.isSafeInteger((page - 1) * limit)) {
      return res.status(400).json({ message: "page must be a positive integer and limit must be between 1 and 50" });
    }
    if (!await hasCrmTaskReadAccess(req, res)) return;
    // Both branches start from the same owner-filtered document. History is
    // sorted/paged in Mongo, including deleted entries, before API materialization.
    const [result] = await CrmLead.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id), assignedTo: new mongoose.Types.ObjectId(req.userId), ...crmLeadCohortFilter(req.user) } },
      { $project: { updates: 1 } },
      { $facet: {
        lead: [{ $project: { total: { $size: { $ifNull: ["$updates", []] } } } }],
        items: [
          { $unwind: "$updates" },
          { $sort: { "updates.createdAt": -1, "updates._id": -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $replaceRoot: { newRoot: "$updates" } },
        ],
      } },
    ]);
    if (!result?.lead?.length) return res.status(404).json({ message: "CRM task not found" });
    const lead = CrmLead.hydrate({ updates: result.items });
    normalizeCrmLeadDocument(lead);
    await lead.populate({ path: "updates.createdBy", select: "email username role", match: isReviewAccount(req.user) ? { isReviewAccount: true } : undefined });
    return res.status(200).json({ items: lead.toObject().updates, total: result.lead[0].total, page, limit });
  } catch (error) {
    console.error("getMyCrmTaskUpdates error", error);
    return res.status(500).json({ message: "Failed to fetch CRM task updates" });
  }
};

export const getMyCrmTasks = async (req: AuthRequest, res: Response) => {
  try {
    const { q, status, from, to, leadSource, due } = req.query as Record<string, string | undefined>;
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10) || 20, 1), 200);
    const includeAllStatuses = status === "all";
    const hasExplicitStatus =
      status === "archived" || (!includeAllStatuses && !!status && isCrmStatus(status));

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const filter: Record<string, any> = { assignedTo: req.userId, ...crmLeadCohortFilter(req.user) };
    const andFilters: Record<string, any>[] = [];

    if (status === "archived") {
      andFilters.push({ $expr: {
        $eq: [buildNormalizedCrmStatusExpression(), "won"],
      } });
    } else if (status && !includeAllStatuses && isCrmStatus(status)) {
      andFilters.push({ $expr: {
        $eq: [buildNormalizedCrmStatusExpression(), status],
      } });
    }

    if (leadSource === "organic") {
      andFilters.push({
        $or: [
          { leadSource: "organic" },
          { title: /^Quick Add/i },
        ],
      });
    } else if (leadSource === "generic") {
      andFilters.push({
        leadSource: { $ne: "organic" },
        title: { $not: /^Quick Add/i },
      });
    }

    if (from || to) {
      filter.taskStartDate = {} as any;
      const fromDate = parseDateFilterBoundary(from, "start");
      const toDate = parseDateFilterBoundary(to, "end");
      if (fromDate) filter.taskStartDate.$gte = fromDate;
      if (toDate) filter.taskStartDate.$lte = toDate;
    } else if (due === "overdue") {
      if (!hasExplicitStatus) {
        andFilters.push({
          $expr: {
            $not: {
              $in: [buildNormalizedCrmStatusExpression(), ["won", "lost"]],
            },
          },
        });
      }
      andFilters.push({ dueDate: { $lt: new Date() } });
    } else if (due === "upcoming") {
      const now = new Date();
      const upcomingCutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (!hasExplicitStatus) {
        andFilters.push({
          $expr: {
            $not: {
              $in: [buildNormalizedCrmStatusExpression(), ["won", "lost"]],
            },
          },
        });
      }
      andFilters.push({ dueDate: { $gte: now, $lte: upcomingCutoff } });
    } else if (!includeAllStatuses && !hasExplicitStatus) {
      const upcomingCutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      andFilters.push(
        {
          $expr: {
            $not: {
              $in: [buildNormalizedCrmStatusExpression(), ["won", "lost"]],
            },
          },
        },
        {
          $or: [
            { taskStartDate: { $exists: false } },
            { taskStartDate: null },
            { taskStartDate: { $lte: new Date() } },
            // Include future-scheduled tasks whose dueDate is within the next 7 days (upcoming)
            { dueDate: { $lte: upcomingCutoff } },
          ],
        },
      );
    }

    if (q) {
      const regex = new RegExp(q, "i");
      filter.$or = [
        { clientName: regex },
        { companyName: regex },
        { email: regex },
        { phoneFormatted: regex },
        { companyLocation: regex },
        { category: regex },
        { industry: regex },
        { website: regex },
        { contactSocials: regex },
        { listItems: regex },
        { notes: regex },
        { latestComment: regex },
      ];
    }

    if (andFilters.length > 0) {
      filter.$and = andFilters;
    }

    const summary = req.query.view === "summary";
    if (summary) res.setHeader("Cache-Control", "no-store");
    const aggregateFilter = normalizeCrmAggregateMatchFilter(filter);
    const [items, total, rawStatusCounts, leadSourceCounts] = await Promise.all([
      summary ? loadCrmTaskReadRows(filter, { summary: true, page, limit }) : CrmLead.find(filter)
        .sort({ dueDate: 1, taskStartDate: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CrmLead.countDocuments(filter),
      CrmLead.aggregate([
        { $match: aggregateFilter },
        {
          $addFields: {
            normalizedStatus: buildNormalizedCrmStatusExpression(),
          },
        },
        {
          $group: {
            _id: "$normalizedStatus",
            count: { $sum: 1 },
          },
        },
      ]),
      getCrmLeadSourceCounts(filter),
    ]);

    if (!summary) {
      let shouldPersistNormalizedItems = false;
      for (const item of items) {
        shouldPersistNormalizedItems = normalizeCrmLeadDocument(item) || shouldPersistNormalizedItems;
      }
      if (shouldPersistNormalizedItems) {
        await Promise.all(items.map((item) => item.save()));
      }
      // Populate only after any normalization save: a hidden actor must never be
      // persisted as a cleared reference merely because this is a review response.
      const match = isReviewAccount(req.user) ? { isReviewAccount: true } : undefined;
      await CrmLead.populate(items, [
        { path: "assignedBy", select: "email username", match },
        { path: "updates.createdBy", select: "email username role", match },
      ]);
    }

    const statusCounts = CRM_LEAD_STATUSES.map((crmStatus) => ({
      _id: crmStatus,
      count:
        Number(
          (rawStatusCounts as Array<{ _id?: string; count?: number }>).find((entry) => entry?._id === crmStatus)?.count || 0
        ) || 0,
    })).filter((entry) => entry.count > 0);

    return res.status(200).json({ items, total, page, limit, statusCounts, leadSourceCounts });
  } catch (e) {
    console.error("getMyCrmTasks error", e);
    return res.status(500).json({ message: "Failed to fetch CRM tasks" });
  }
};

export const submitCrmTaskUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { comment, status, lostReason } = req.body || {};

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const lead = await CrmLead.findOne({ _id: id, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    normalizeCrmLeadDocument(lead);

    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    // Follow-up fields are checked before any file is stored, so a refused
    // date never leaves orphaned uploads.
    let followUpIntent: CrmFollowUpIntent;
    try {
      followUpIntent = readCrmFollowUpIntent(req.body);
      if (followUpIntent.kind === "set") {
        const requested = normalizeCrmStatusValue(toNonEmptyString(status) || (lead as any).status, toNonEmptyString(lostReason) || (lead as any).lostReason);
        if (requested.status === "won" || requested.status === "lost") {
          throw new CrmFollowUpInputError("A won or lost lead has no follow-up date.");
        }
        computeCrmFollowUpSchedule(followUpIntent, new Date());
      }
    } catch (followUpError) {
      if (followUpError instanceof CrmFollowUpInputError) {
        return res.status(400).json({ message: followUpError.message, code: "CRM_FOLLOW_UP_INVALID" });
      }
      throw followUpError;
    }

    const files = ((req as any).files || {}) as {
      attachments?: Express.Multer.File[];
      recording?: Express.Multer.File[];
    };

    const attachmentUrls: string[] = [];
    for (const file of files.attachments || []) {
      const url = await uploadCrmFile(file, `crm/attachments/${lead._id}`);
      attachmentUrls.push(url);
    }

    let recordingUrl: string | undefined;
    const recordingFile = (files.recording || [])[0];
    if (recordingFile) {
      recordingUrl = await uploadCrmFile(recordingFile, `crm/recordings/${lead._id}`);
    }

    const nextStatus = toNonEmptyString(status);
    const nextLostReason = toNonEmptyString(lostReason);
    if (nextStatus) {
      if (!isCrmStatus(nextStatus)) {
        return res.status(400).json({ message: "Invalid CRM status" });
      }
    }
    if (nextLostReason && !isCrmLostReason(nextLostReason)) {
      return res.status(400).json({ message: "Invalid CRM lost reason" });
    }

    const effectiveStatus = nextStatus || String((lead as any).status || "new_lead");
    const effectiveLostReason = nextLostReason || toNonEmptyString((lead as any).lostReason);
    if (effectiveStatus === "lost" && !effectiveLostReason) {
      return res.status(400).json({ message: "Lost reason is required when status is Lost" });
    }
    const updatedAt = new Date();
    if (nextStatus || nextLostReason) {
      const normalized = normalizeCrmStatusValue(effectiveStatus, effectiveLostReason);
      applyCrmStatusChange(lead, normalized.status, normalized.lostReason, updatedAt);
    }

    // Follow-up date (2026-10-11, rules in service/crmFollowUpService.ts):
    // set, cleared, kept, or ended because this update came after it passed.
    try {
      const statusAfter = normalizeCrmStatusValue((lead as any).status, (lead as any).lostReason);
      resolveCrmFollowUpOnTaskUpdate(lead, followUpIntent, {
        now: updatedAt,
        setBy: req.userId,
        statusClosed: statusAfter.status === "won" || statusAfter.status === "lost",
        cadenceDueDate: computeNextCrmReminderDate(statusAfter.status, statusAfter.lostReason, updatedAt),
      });
    } catch (followUpError) {
      if (followUpError instanceof CrmFollowUpInputError) {
        return res.status(400).json({ message: followUpError.message, code: "CRM_FOLLOW_UP_INVALID" });
      }
      throw followUpError;
    }

    const safeComment = toNonEmptyString(comment);

    lead.set("callAttempts", Number((lead as any).callAttempts || 0) + 1);
    lead.set("lastCalledAt", new Date());

    if (safeComment) {
      lead.set("latestComment", safeComment);
    }

    if (attachmentUrls.length > 0) {
      lead.set("latestAttachmentUrls", attachmentUrls);
    }

    if (recordingUrl) {
      lead.set("latestRecordingUrl", recordingUrl);
    }

    const updates = Array.isArray((lead as any).updates) ? (lead as any).updates : [];
    updates.push({
      comment: safeComment || undefined,
      status: (lead as any).status,
      lostReason: (lead as any).lostReason,
      // When the follow-up reminder will come (the website history shows it
      // as "Reminder: …"); empty when no follow-up date is set.
      reminderDate: (lead as any).followUpRemindAt || undefined,
      attachmentUrls,
      recordingUrl,
      createdBy: req.userId,
      createdAt: new Date(),
    });

    lead.set("updates", updates);
    await lead.save();

    const updated = await CrmLead.findById(id)
      .populate({ path: "assignedTo", select: "email username", match: isReviewAccount(req.user) ? { isReviewAccount: true } : undefined })
      .populate({ path: "assignedBy", select: "email username", match: isReviewAccount(req.user) ? { isReviewAccount: true } : undefined })
      .populate({ path: "updates.createdBy", select: "email username role", match: isReviewAccount(req.user) ? { isReviewAccount: true } : undefined });

    return res.status(200).json({
      message: "CRM task updated",
      item: updated,
    });
  } catch (e: any) {
    console.error("submitCrmTaskUpdate error", e);
    return res.status(500).json({ message: e?.message || "Failed to update CRM task" });
  }
};

export const rewriteEmailWithAI = async (req: AuthRequest, res: Response) => {
  try {
    const body = toNonEmptyString(req.body?.body);
    const subject = toNonEmptyString(req.body?.subject);
    const clientName = toNonEmptyString(req.body?.clientName);
    const senderName = toNonEmptyString(req.body?.senderName);
    const senderCompany = toNonEmptyString(req.body?.senderCompany);

    if (!body) {
      return res.status(400).json({ message: "Email body is required" });
    }

    const contextParts: string[] = [];
    if (clientName) contextParts.push(`Recipient name: ${clientName}`);
    if (senderName) contextParts.push(`Sender name: ${senderName}`);
    if (senderCompany) contextParts.push(`Sender company: ${senderCompany}`);

    const systemPrompt = [
      "You are an expert professional email copywriter for a CRM system.",
      "Rewrite the given email draft into a polished, high-impact business email.",
      "",
      "FORMATTING RULES (HTML body):",
      "- Return the body as clean inline-styled HTML suitable for email clients.",
      "- Use <b> or <strong> to emphasize key phrases, names, and calls to action.",
      "- Use <u> sparingly for critical highlights.",
      "- Use <br> for line breaks and <p> tags for paragraphs.",
      "- Use <ul>/<li> for listing multiple points when appropriate.",
      "- Use <em> for gentle emphasis or brand mentions.",
      "- Keep font styling minimal — rely on semantic tags, not inline CSS colors.",
      "- Do NOT include <html>, <head>, <body>, or <style> tags — just the inner content.",
      "",
      "TONE & CONTENT:",
      "- Warm, confident, and professional tone.",
      "- Open with a personalized greeting using the recipient name if available.",
      "- Keep sentences concise and scannable.",
      "- End with a clear call-to-action and professional sign-off.",
      "- Preserve the original intent and all key information.",
      contextParts.length > 0 ? `\nContext:\n${contextParts.join("\n")}` : "",
      "",
      subject
        ? "Also return an improved, concise subject line."
        : "Also generate a compelling subject line based on the email content.",
      "",
      'Return ONLY valid JSON: {"subject": "...", "body": "<p>HTML content here</p>"}',
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: subject
            ? `Subject: ${subject}\n\n${body}`
            : body,
        },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    const raw = (completion.choices?.[0]?.message?.content || "").trim();

    let parsed: { subject?: string; body?: string } = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      parsed = { subject: subject || "Follow Up", body: raw };
    }

    return res.status(200).json({
      subject: toNonEmptyString(parsed.subject) || subject || "Follow Up",
      body: toNonEmptyString(parsed.body) || body,
    });
  } catch (e: any) {
    console.error("rewriteEmailWithAI error", e);
    return res.status(500).json({ message: e?.message || "Failed to rewrite email" });
  }
};

// Outlook app configuration and per-user tokens live in
// service/msOutlookCalendarService.ts (moved 2026-10-11 for the follow-up job).

function signMsOutlookState(payload: { userId: string }) {
  return jwt.sign(
    {
      userId: payload.userId,
      provider: "ms_outlook_calendar",
    },
    String(process.env.JWT_SECRET || ""),
    { expiresIn: "20m" }
  );
}

function verifyMsOutlookState(state: string) {
  const decoded = jwt.verify(state, String(process.env.JWT_SECRET || "")) as {
    userId?: string;
    provider?: string;
  };
  if (decoded?.provider !== "ms_outlook_calendar" || !decoded?.userId) {
    throw new Error("Invalid OAuth state");
  }
  return decoded.userId;
}

function toUtcISOStringWithFallback(dateValue?: Date) {
  const dt = dateValue && Number.isFinite(dateValue.getTime()) ? dateValue : new Date();
  return dt.toISOString();
}

function buildOutlookEventForTask(task: any) {
  const now = new Date();
  const startCandidate = task?.taskStartDate ? new Date(task.taskStartDate) : undefined;
  const dueCandidate = task?.dueDate ? new Date(task.dueDate) : undefined;

  const start =
    startCandidate && Number.isFinite(startCandidate.getTime())
      ? startCandidate
      : dueCandidate && Number.isFinite(dueCandidate.getTime())
        ? dueCandidate
        : now;

  const end =
    dueCandidate && Number.isFinite(dueCandidate.getTime())
      ? dueCandidate
      : new Date(start.getTime() + 30 * 60 * 1000);

  const startIso = toUtcISOStringWithFallback(start);
  const endIso = toUtcISOStringWithFallback(end.getTime() <= start.getTime() ? new Date(start.getTime() + 30 * 60 * 1000) : end);

  const title = toNonEmptyString(task?.title) || `Follow up: ${toNonEmptyString(task?.clientName) || "CRM Task"}`;
  const notes = toNonEmptyString(task?.latestComment || task?.notes);
  const email = toNonEmptyString(task?.email);
  const phone = toNonEmptyString(task?.phoneFormatted || task?.phoneRaw);

  const bodyHtml = [
    `<p><strong>CRM Lead:</strong> ${toNonEmptyString(task?.clientName) || "Unknown"}</p>`,
    task?.companyName ? `<p><strong>Company:</strong> ${toNonEmptyString(task.companyName)}</p>` : "",
    email ? `<p><strong>Email:</strong> ${email}</p>` : "",
    phone ? `<p><strong>Phone:</strong> ${phone}</p>` : "",
    task?.status ? `<p><strong>Status:</strong> ${toNonEmptyString(task.status)}</p>` : "",
    notes ? `<p><strong>Notes:</strong><br/>${notes.replace(/\n/g, "<br/>")}</p>` : "",
  ]
    .filter(Boolean)
    .join("");

  return {
    subject: title,
    body: {
      contentType: "HTML",
      content: bodyHtml || `<p>CRM follow-up task for ${toNonEmptyString(task?.clientName) || "lead"}</p>`,
    },
    start: {
      dateTime: startIso,
      timeZone: "UTC",
    },
    end: {
      dateTime: endIso,
      timeZone: "UTC",
    },
    categories: ["CRM"],
    location: {
      displayName: toNonEmptyString(task?.companyLocation || task?.contactLocation || ""),
    },
  };
}

async function exchangeMicrosoftCodeForTokens(code: string) {
  type MsTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const clientId = getMsOutlookClientId();
  const clientSecret = getMsOutlookClientSecret();
  const redirectUri = getMsOutlookRedirectUri();

  const payload = new URLSearchParams();
  payload.set("client_id", clientId);
  payload.set("client_secret", clientSecret);
  payload.set("code", code);
  payload.set("grant_type", "authorization_code");
  payload.set("redirect_uri", redirectUri);
  payload.set("scope", getMsOutlookScopes());

  const { data } = await axios.post<MsTokenResponse>(MS_GRAPH_TOKEN_BASE, payload.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });

  return {
    accessToken: toNonEmptyString(data?.access_token),
    refreshToken: toNonEmptyString(data?.refresh_token),
    expiresIn: Number(data?.expires_in || 0),
  };
}

export const getMsOutlookCalendarStatus = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select(
      "isCrmAgent isBlocked msOutlookCalendarConnected msOutlookConnectedEmail msOutlookConnectedAt"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    if ((user as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(user as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const payload = {
      connected: Boolean((user as any).msOutlookCalendarConnected),
      email: toNonEmptyString((user as any).msOutlookConnectedEmail),
      connectedAt: (user as any).msOutlookConnectedAt || null,
      configured: isMsOutlookConfigured(),
    };
    console.info("[Outlook][Server] Status", {
      userId: String(req.userId || ""),
      connected: payload.connected,
      email: payload.email,
      configured: payload.configured,
    });
    return res.status(200).json(payload);
  } catch (e: any) {
    console.error("getMsOutlookCalendarStatus error", e);
    return res.status(500).json({ message: e?.message || "Failed to load Outlook calendar status" });
  }
};

export const getMsOutlookCalendarAuthUrl = async (req: AuthRequest, res: Response) => {
  try {
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }
    if (!isMsOutlookConfigured()) {
      return res.status(500).json({ message: "Microsoft Outlook integration is not configured on server" });
    }

    // Signed state binds the unauthenticated provider callback to the initiating user;
    // the callback never accepts an account id directly from query parameters.
    const state = signMsOutlookState({ userId: String(req.userId) });
    const params = new URLSearchParams();
    params.set("client_id", getMsOutlookClientId());
    params.set("response_type", "code");
    params.set("redirect_uri", getMsOutlookRedirectUri());
    params.set("response_mode", "query");
    params.set("scope", getMsOutlookScopes());
    params.set("state", state);
    params.set("prompt", "select_account");

    const authUrl = `${MS_GRAPH_AUTH_BASE}?${params.toString()}`;
    console.info("[Outlook][Server] Auth URL generated", {
      userId: String(req.userId || ""),
      redirectUri: getMsOutlookRedirectUri(),
      configured: isMsOutlookConfigured(),
    });
    return res.status(200).json({ authUrl });
  } catch (e: any) {
    console.error("getMsOutlookCalendarAuthUrl error", e);
    return res.status(500).json({ message: e?.message || "Failed to start Outlook calendar connection" });
  }
};

export const msOutlookCalendarOAuthCallback = async (req: Request, res: Response) => {
  type MsProfileResponse = {
    mail?: string;
    userPrincipalName?: string;
  };

  const successRedirect = toNonEmptyString(process.env.MS_OUTLOOK_OAUTH_SUCCESS_REDIRECT);
  const failureRedirect = toNonEmptyString(process.env.MS_OUTLOOK_OAUTH_FAILURE_REDIRECT);

  try {
    const code = toNonEmptyString(req.query?.code as string);
    const state = toNonEmptyString(req.query?.state as string);
    const error = toNonEmptyString(req.query?.error as string);

    console.info("[Outlook][Server] OAuth callback hit", {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      hasError: Boolean(error),
    });

    if (error) {
      const reason = toNonEmptyString(req.query?.error_description as string) || error;
      if (failureRedirect) {
        return res.redirect(`${failureRedirect}?reason=${encodeURIComponent(reason)}`);
      }
      return res
        .status(400)
        .send(`<html><body><h3>Microsoft connection failed</h3><p>${reason}</p></body></html>`);
    }

    if (!code || !state) {
      if (failureRedirect) {
        return res.redirect(`${failureRedirect}?reason=${encodeURIComponent("Invalid callback payload")}`);
      }
      return res
        .status(400)
        .send("<html><body><h3>Invalid callback payload</h3><p>Missing code/state.</p></body></html>");
    }

    // Verify state before exchanging or storing provider credentials to reject forged
    // and expired callback attempts.
    const userId = verifyMsOutlookState(state);
    const exchanged = await exchangeMicrosoftCodeForTokens(code);
    if (!exchanged.accessToken) {
      throw new Error("Microsoft did not return an access token");
    }

    let connectedEmail = "";
    try {
      const profile = await axios.get<MsProfileResponse>(
        `${MS_GRAPH_API_BASE}/me?$select=mail,userPrincipalName`,
        {
        headers: {
          Authorization: `Bearer ${exchanged.accessToken}`,
        },
        timeout: 10000,
        }
      );
      connectedEmail =
        toNonEmptyString(profile.data?.mail) || toNonEmptyString(profile.data?.userPrincipalName);
    } catch {
      connectedEmail = "";
    }

    const expiresAt =
      exchanged.expiresIn > 0
        ? new Date(Date.now() + exchanged.expiresIn * 1000)
        : new Date(Date.now() + 45 * 60 * 1000);

    const updateResult = await User.updateOne(
      { _id: userId },
      {
        $set: {
          msOutlookCalendarConnected: true,
          msOutlookConnectedAt: new Date(),
          msOutlookConnectedEmail: connectedEmail || undefined,
          msOutlookAccessToken: exchanged.accessToken,
          msOutlookRefreshToken: exchanged.refreshToken || undefined,
          msOutlookTokenExpiresAt: expiresAt,
        },
      }
    );

    console.info("[Outlook][Server] OAuth persisted", {
      userId,
      connectedEmail,
      matchedCount: (updateResult as any)?.matchedCount,
      modifiedCount: (updateResult as any)?.modifiedCount,
    });

    if (successRedirect) {
      return res.redirect(successRedirect);
    }

    return res
      .status(200)
      .send(
        "<html><body><h3>Outlook calendar connected</h3><p>You can now return to the Asset Insight app.</p></body></html>"
      );
  } catch (e: any) {
    console.error("msOutlookCalendarOAuthCallback error", formatAxiosErrorForLog(e));
    const reason = e?.message || "Failed to complete Microsoft OAuth callback";
    if (failureRedirect) {
      return res.redirect(`${failureRedirect}?reason=${encodeURIComponent(reason)}`);
    }
    return res.status(500).send(`<html><body><h3>Connection failed</h3><p>${reason}</p></body></html>`);
  }
};

export const disconnectMsOutlookCalendar = async (req: AuthRequest, res: Response) => {
  try {
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    await User.updateOne(
      { _id: req.userId },
      {
        $set: {
          msOutlookCalendarConnected: false,
        },
        $unset: {
          msOutlookConnectedEmail: 1,
          msOutlookConnectedAt: 1,
          msOutlookAccessToken: 1,
          msOutlookRefreshToken: 1,
          msOutlookTokenExpiresAt: 1,
        },
      }
    );

    return res.status(200).json({ message: "Outlook calendar disconnected" });
  } catch (e: any) {
    console.error("disconnectMsOutlookCalendar error", e);
    return res.status(500).json({ message: e?.message || "Failed to disconnect Outlook calendar" });
  }
};

const OUTLOOK_TASK_ACCESS_CHANGED = "The task assignment or your CRM access changed while Outlook was updating. Refresh your tasks; no calendar receipt was returned.";
const OUTLOOK_TASK_RECEIPT_CHANGED = "The calendar changed while this request was finishing. Refresh your tasks and check Outlook before retrying.";

/** Provider work can outlive an assignment/access change. Never expose another
 * assignee's receipt, including when this worker reconciled that newer intent. */
async function currentCrmOutlookResponseAccess(userId: string, leadId: string, result: Awaited<ReturnType<typeof syncCrmFollowUpOutlookEvent>>) {
  const user = await User.findOne({ _id: userId, isCrmAgent: true, isBlocked: { $ne: true } }).select("isReviewAccount").lean();
  if (!user) return "denied" as const;
  const lead = await CrmLead.findOne({ _id: leadId, assignedTo: userId, ...crmLeadCohortFilter(user) })
    .select("followUpOutlook").lean();
  if (!lead) return "denied" as const;
  if (result.status === "synced" && result.eventId && (result.userId !== userId || String(lead.followUpOutlook?.userId) !== userId ||
      lead.followUpOutlook?.eventId !== result.eventId || lead.followUpOutlook?.syncPending !== false)) return "pending" as const;
  return "allowed" as const;
}

export const addCrmTaskToMsOutlookCalendar = async (req: AuthRequest, res: Response) => {
  type MsEventResponse = {
    id?: string;
    webLink?: string;
  };

  try {
    const leadId = toNonEmptyString(req.params.id);
    if (!leadId) {
      return res.status(400).json({ message: "Task id is required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked msOutlookCalendarConnected");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }
    if (!(me as any).msOutlookCalendarConnected) {
      return res.status(400).json({ message: "Outlook calendar is not connected" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(req.user) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only add your own task to calendar" });
    }

    // A lead with a follow-up date has one Outlook event, kept in step by the
    // follow-up job (2026-10-11). This button makes or refreshes that same event
    // now instead of adding a second one.
    if (hasActiveCrmFollowUp(lead) || lead.followUpOutlook?.eventId || lead.followUpOutlook?.syncPending) {
      requestCrmFollowUpOutlookSync(lead, new Date());
      await lead.save();
      const result = await syncCrmFollowUpOutlookEvent(String((lead as any)._id));
      const responseAccess = await currentCrmOutlookResponseAccess(String(req.userId), String(lead._id), result);
      if (responseAccess === "denied") return res.status(409).json({ message: OUTLOOK_TASK_ACCESS_CHANGED });
      if (responseAccess === "pending") return res.status(202).json({ pending: true, message: OUTLOOK_TASK_RECEIPT_CHANGED });
      if (result.status === "pending") {
        return res.status(202).json({ message: result.message, pending: true });
      }
      if (result.status !== "synced") {
        return res.status(502).json({ message: result.status === "failed" ? result.error : "CRM task not found" });
      }
      if (!result.eventId) {
        return res.status(409).json({ message: "This follow-up is no longer active. No new Outlook event was created." });
      }
      return res.status(201).json({
        message: "Follow-up added to Outlook calendar",
        eventId: result.eventId || "",
        webLink: result.webLink || "",
      });
    }

    const accessToken = await getValidMicrosoftAccessTokenForUser(String(req.userId));
    const eventPayload = buildOutlookEventForTask(lead);

    const created = await axios.post<MsEventResponse>(`${MS_GRAPH_API_BASE}/me/events`, eventPayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    return res.status(201).json({
      message: "Task added to Outlook calendar",
      eventId: toNonEmptyString(created.data?.id),
      webLink: toNonEmptyString(created.data?.webLink),
    });
  } catch (e: any) {
    console.error("addCrmTaskToMsOutlookCalendar error", formatAxiosErrorForLog(e));
    return res.status(500).json({
      message: e?.response?.data?.error?.message || e?.message || "Failed to add task to Outlook calendar",
    });
  }
};

export const addBulkCrmTasksToMsOutlookCalendar = async (req: AuthRequest, res: Response) => {
  type MsEventResponse = {
    id?: string;
    webLink?: string;
  };

  try {
    const ids = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    const taskIds = ids.map((v: unknown) => toNonEmptyString(v)).filter(Boolean).slice(0, 100);
    if (taskIds.length === 0) {
      return res.status(400).json({ message: "taskIds is required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked msOutlookCalendarConnected");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }
    if (!(me as any).msOutlookCalendarConnected) {
      return res.status(400).json({ message: "Outlook calendar is not connected" });
    }

    const leads = await CrmLead.find({
      _id: { $in: taskIds },
      assignedTo: req.userId,
      ...crmLeadCohortFilter(req.user),
    }).select(
      "assignedTo title clientName companyName email phoneRaw phoneFormatted status taskStartDate dueDate latestComment notes companyLocation contactLocation " +
      "followUpDate followUpTime followUpTimeZone followUpAt followUpRemindAt followUpOutlook"
    );

    if (leads.length === 0) {
      return res.status(404).json({ message: "No matching tasks found" });
    }

    const created: Array<{ taskId: string; eventId: string; webLink: string }> = [];
    const failed: Array<{ taskId: string; reason: string }> = [];
    const pending: Array<{ taskId: string; reason: string }> = [];

    for (const lead of leads) {
      // A lead with a follow-up date keeps its single follow-up event (2026-10-11).
      if (hasActiveCrmFollowUp(lead) || lead.followUpOutlook?.eventId || lead.followUpOutlook?.syncPending) {
        requestCrmFollowUpOutlookSync(lead, new Date());
        await lead.save();
        const result = await syncCrmFollowUpOutlookEvent(String((lead as any)._id));
        const responseAccess = await currentCrmOutlookResponseAccess(String(req.userId), String(lead._id), result);
        if (responseAccess === "denied") {
          failed.push({ taskId: String(lead._id), reason: OUTLOOK_TASK_ACCESS_CHANGED });
          continue;
        }
        if (responseAccess === "pending") {
          pending.push({ taskId: String(lead._id), reason: OUTLOOK_TASK_RECEIPT_CHANGED });
          continue;
        }
        if (result.status === "pending") {
          pending.push({ taskId: String(lead._id), reason: result.message });
        } else if (result.status === "synced" && result.eventId) {
          created.push({ taskId: String((lead as any)._id), eventId: result.eventId || "", webLink: result.webLink || "" });
        } else {
          failed.push({ taskId: String((lead as any)._id), reason: result.status === "failed" ? result.error : "The follow-up is no longer active. No new event was created." });
        }
        continue;
      }
      try {
        const accessToken = await getValidMicrosoftAccessTokenForUser(String(req.userId));
        const payload = buildOutlookEventForTask(lead);
        const resp = await axios.post<MsEventResponse>(`${MS_GRAPH_API_BASE}/me/events`, payload, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        });
        created.push({
          taskId: String((lead as any)._id),
          eventId: toNonEmptyString(resp.data?.id),
          webLink: toNonEmptyString(resp.data?.webLink),
        });
      } catch (err: any) {
        failed.push({
          taskId: String((lead as any)._id),
          reason: err?.response?.data?.error?.message || err?.message || "Failed to add event",
        });
      }
    }

    return res.status(200).json({
      message: "Bulk Outlook calendar sync completed",
      createdCount: created.length,
      failedCount: failed.length,
      pendingCount: pending.length,
      created,
      failed,
      pending,
    });
  } catch (e: any) {
    console.error("addBulkCrmTasksToMsOutlookCalendar error", formatAxiosErrorForLog(e));
    return res.status(500).json({
      message: e?.response?.data?.error?.message || e?.message || "Failed to sync tasks to Outlook calendar",
    });
  }
};

export const listCrmTransferAgents = async (req: AuthRequest, res: Response) => {
  try {
    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const items = await User.find({
      role: "user",
      isCrmAgent: true,
      isBlocked: { $ne: true },
      _id: { $ne: req.userId },
      ...crmUserCohortFilter(req.user),
    })
      .select("email username crmAddress crmQuadrant crmSpecializations")
      .sort({ username: 1, email: 1 })
      .lean();

    return res.status(200).json({ items });
  } catch (e: any) {
    console.error("listCrmTransferAgents error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM agents" });
  }
};

export const requestCrmTaskTransfer = async (req: AuthRequest, res: Response) => {
  try {
    const leadId = toNonEmptyString(req.params.id);
    const toUserId = toNonEmptyString(req.body?.toUserId || req.body?.targetUserId || req.body?.toUser);
    const note = toNonEmptyString(req.body?.note);

    if (!leadId || !toUserId) {
      return res.status(400).json({ message: "Task id and target CRM agent are required" });
    }
    if (String(toUserId) === String(req.userId)) {
      return res.status(400).json({ message: "You cannot transfer a task to yourself" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked email username isReviewAccount");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const target = await User.findById(toUserId).select("isCrmAgent isBlocked expoPushTokens email username isReviewAccount");
    if (!target || (target as any).isBlocked || !(target as any).isCrmAgent || !sameCrmCohort(me, target)) {
      return res.status(404).json({ message: "Target CRM agent not found or unavailable" });
    }

    const lead = await CrmLead.findOne({ _id: leadId, ...crmLeadCohortFilter(me) });
    if (!lead) return res.status(404).json({ message: "CRM task not found" });
    if (String((lead as any).assignedTo) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only transfer tasks assigned to you" });
    }

    // Refuse duplicate pending requests for the same route so recipients receive one
    // actionable decision and notification for a lead transfer.
    const alreadyPending = await CrmTaskTransferRequest.findOne({
      leadId,
      fromUserId: req.userId,
      toUserId,
      status: "pending",
    }).lean();
    if (alreadyPending) {
      return res.status(409).json({ message: "A transfer request is already pending for this agent" });
    }

    const created = await CrmTaskTransferRequest.create({
      isReviewData: isReviewAccount(me),
      leadId,
      fromUserId: req.userId,
      toUserId,
      requestedBy: req.userId,
      note: note || undefined,
      status: "pending",
    });

    await notifyUser({
      userId: String((target as any)._id || toUserId),
      tokens: ((target as any)?.expoPushTokens || []) as string[],
      category: "crm",
      type: "crm_transfer_request",
      title: "CRM Transfer Request",
      body: `${toNonEmptyString((me as any)?.username || (me as any)?.email || "A CRM agent")} requested to transfer ${toNonEmptyString((lead as any)?.clientName || "a lead")} to you.`,
      data: {
        type: "crm_transfer_request",
        requestId: String((created as any)._id || ""),
        leadId: String((lead as any)._id || ""),
      },
    }).catch((err) => {
      console.error("requestCrmTaskTransfer push error", err);
    });

    const item = await CrmTaskTransferRequest.findById((created as any)._id)
      .populate("leadId", "clientName title status dueDate")
      .populate("fromUserId", "email username")
      .populate("toUserId", "email username");

    return res.status(201).json({ message: "Transfer request sent", item });
  } catch (e: any) {
    console.error("requestCrmTaskTransfer error", e);
    return res.status(500).json({ message: e?.message || "Failed to request transfer" });
  }
};

async function reconcileStalePendingCrmTransfers(input: {
  toUserId?: unknown;
  respondedBy?: unknown;
  cohortUser?: unknown;
} = {}): Promise<void> {
  const filter: Record<string, any> = { status: "pending" };
  if (input.toUserId) {
    filter.toUserId = input.toUserId;
    Object.assign(filter, crmLeadCohortFilter(input.cohortUser));
  }

  const pending = await CrmTaskTransferRequest.find(filter)
    .select("_id leadId fromUserId")
    .populate("leadId", "assignedTo isReviewData")
    .lean();

  const sameCohortSenders = input.toUserId ? new Set((await User.find({
    _id: { $in: pending.map((request) => request.fromUserId) },
    ...crmUserCohortFilter(input.cohortUser),
  }).select("_id").lean()).map((user) => String(user._id))) : null;

  // A request becomes stale when the lead was deleted or reassigned outside this flow.
  // Cancelling it keeps inbox/admin counts aligned with what can still be accepted.
  const staleIds: any[] = [];
  for (const request of pending) {
    const lead = (request as any).leadId;
    const assignedTo = lead ? String((lead as any).assignedTo || "") : "";
    const fromUserId = String((request as any).fromUserId || "");
    // Corrupt/legacy cross-cohort records must not be changed by an inbox read.
    if (sameCohortSenders && (!sameCohortSenders.has(fromUserId) ||
        (lead && ((lead as any).isReviewData === true) !== isReviewAccount(input.cohortUser)))) continue;
    if (!lead || !assignedTo || assignedTo !== fromUserId) {
      staleIds.push((request as any)._id);
    }
  }

  if (staleIds.length === 0) return;

  const update: Record<string, any> = {
    status: "cancelled",
    respondedAt: new Date(),
  };
  if (input.respondedBy) update.respondedBy = input.respondedBy;

  await CrmTaskTransferRequest.updateMany(
    { _id: { $in: staleIds }, status: "pending" },
    { $set: update }
  );
}

export const getMyCrmTransferRequests = async (req: AuthRequest, res: Response) => {
  try {
    const status = toNonEmptyString(req.query?.status as string).toLowerCase();
    const effectiveStatus = CRM_TRANSFER_STATUS_SET.has(status) ? status : "pending";

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    if (effectiveStatus === "pending") {
      await reconcileStalePendingCrmTransfers({
        toUserId: req.userId,
        respondedBy: req.userId,
        cohortUser: req.user,
      });
    }

    const filter: Record<string, any> = { toUserId: req.userId, status: effectiveStatus, ...crmLeadCohortFilter(req.user) };

    const items = await CrmTaskTransferRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate({ path: "leadId", select: "clientName title status dueDate", match: crmLeadCohortFilter(req.user) })
      .populate({ path: "fromUserId", select: "email username", match: crmUserCohortFilter(req.user) })
      .populate({ path: "toUserId", select: "email username", match: crmUserCohortFilter(req.user) })
      .lean();

    return res.status(200).json({ items: items.filter((item) => item.leadId && item.fromUserId && item.toUserId) });
  } catch (e: any) {
    console.error("getMyCrmTransferRequests error", e);
    return res.status(500).json({ message: e?.message || "Failed to load transfer requests" });
  }
};

async function resolveCrmTransferAgentFilter(value: unknown): Promise<mongoose.Types.ObjectId[] | null> {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  const activeCrmAgentFilter: Record<string, any> = {
    role: "user",
    isBlocked: { $ne: true },
    isCrmAgent: true,
  };

  if (mongoose.Types.ObjectId.isValid(raw)) {
    const user = await User.findOne({
      ...activeCrmAgentFilter,
      _id: raw,
    }).select("_id").lean();
    return user?._id ? [user._id as mongoose.Types.ObjectId] : [];
  }

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  const users = await User.find({
    ...activeCrmAgentFilter,
    $or: [{ username: regex }, { email: regex }],
  }).select("_id").limit(50).lean();

  return users.map((user: any) => user._id as mongoose.Types.ObjectId).filter(Boolean);
}

export const listCrmTransfersForAdmin = async (req: AdminAuthRequest, res: Response) => {
  try {
    const status = toNonEmptyString(req.query?.status as string).toLowerCase();
    const agentSearch = req.query?.agent;
    const fromSearch = req.query?.from;
    const toSearch = req.query?.to;
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "50", 10) || 50, 1), 200);

    await reconcileStalePendingCrmTransfers();

    const filter: Record<string, any> = {};
    if (CRM_TRANSFER_STATUS_SET.has(status)) {
      filter.status = status;
    }

    const transferClauses: Record<string, any>[] = [];
    const [agentIds, fromIds, toIds] = await Promise.all([
      resolveCrmTransferAgentFilter(agentSearch),
      resolveCrmTransferAgentFilter(fromSearch),
      resolveCrmTransferAgentFilter(toSearch),
    ]);

    if (agentIds) {
      transferClauses.push(
        agentIds.length > 0
          ? { $or: [{ fromUserId: { $in: agentIds } }, { toUserId: { $in: agentIds } }] }
          : { _id: { $exists: false } }
      );
    }
    if (fromIds) {
      transferClauses.push(fromIds.length > 0 ? { fromUserId: { $in: fromIds } } : { _id: { $exists: false } });
    }
    if (toIds) {
      transferClauses.push(toIds.length > 0 ? { toUserId: { $in: toIds } } : { _id: { $exists: false } });
    }
    if (transferClauses.length > 0) {
      filter.$and = transferClauses;
    }

    const [items, total, statusCounts] = await Promise.all([
      CrmTaskTransferRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("leadId", "clientName title status dueDate")
        .populate("fromUserId", "email username")
        .populate("toUserId", "email username")
        .populate("requestedBy", "email username")
        .populate("respondedBy", "email username")
        .lean(),
      CrmTaskTransferRequest.countDocuments(filter),
      CrmTaskTransferRequest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    return res.status(200).json({
      items,
      total,
      page,
      limit,
      statusCounts,
    });
  } catch (e: any) {
    console.error("listCrmTransfersForAdmin error", e);
    return res.status(500).json({ message: e?.message || "Failed to load CRM transfer report" });
  }
};

export const respondCrmTaskTransferRequest = async (req: AuthRequest, res: Response) => {
  try {
    const requestId = toNonEmptyString((req.params as any).requestId);
    const action = toNonEmptyString(req.body?.action).toLowerCase();

    if (!requestId || !["accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "requestId and action (accept/reject) are required" });
    }

    const me = await User.findById(req.userId).select("isCrmAgent isBlocked email username isReviewAccount");
    if (!me) return res.status(404).json({ message: "User not found" });
    if ((me as any).isBlocked) return res.status(403).json({ message: "Account is blocked" });
    if (!(me as any).isCrmAgent) {
      return res.status(403).json({ message: "CRM access is not enabled for this account" });
    }

    const transfer = await CrmTaskTransferRequest.findOne({ _id: requestId, ...crmLeadCohortFilter(me) });
    if (!transfer) return res.status(404).json({ message: "Transfer request not found" });
    if (String((transfer as any).toUserId) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only respond to your own transfer requests" });
    }
    if (String((transfer as any).status) !== "pending") {
      return res.status(400).json({ message: "This transfer request has already been handled" });
    }

    const sender = await User.findById((transfer as any).fromUserId).select("isReviewAccount isCrmAgent isBlocked").lean();
    if (!sender || !sameCrmCohort(sender, me)) {
      return res.status(404).json({ message: "Transfer request not found" });
    }
    const lead = await CrmLead.findOne({ _id: (transfer as any).leadId, ...crmLeadCohortFilter(me) });
    if (!lead) {
      (transfer as any).status = "cancelled";
      (transfer as any).respondedAt = new Date();
      (transfer as any).respondedBy = req.userId;
      await transfer.save();
      return res.status(404).json({ message: "Task no longer exists; request cancelled" });
    }

    if (action === "accept") {
      // Revalidate the original owner immediately before reassignment; accepting an old
      // request must not take a lead away from a newer assignee.
      if (String((lead as any).assignedTo) !== String((transfer as any).fromUserId)) {
        return res.status(409).json({ message: "Task assignee changed; cannot accept this request" });
      }

      (lead as any).assignedTo = req.userId;
      (lead as any).assignedBy = (transfer as any).fromUserId;
      (lead as any).dueSoonPushSentAt = undefined;
      (lead as any).overduePushSentAt = undefined;
      await lead.save();

      await sendCrmNewTaskNotification({
        userId: String(req.userId || ""),
        leadId: String((lead as any)._id || ""),
        clientName: toNonEmptyString((lead as any).clientName),
        title: toNonEmptyString((lead as any).title),
        count: 1,
        reason: "transfer",
      }).catch((err) => {
        console.error("respondCrmTaskTransferRequest new assignee push error", err);
      });

      // Only one destination can own the lead. Once accepted, all competing pending
      // requests are cancelled so their recipients cannot act on obsolete offers.
      await CrmTaskTransferRequest.updateMany(
        {
          _id: { $ne: (transfer as any)._id },
          leadId: (transfer as any).leadId,
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
            respondedAt: new Date(),
            respondedBy: req.userId,
          },
        }
      );
    }

    (transfer as any).status = action === "accept" ? "accepted" : "rejected";
    (transfer as any).respondedAt = new Date();
    (transfer as any).respondedBy = req.userId;
    await transfer.save();

    const fromUser = await User.findById((transfer as any).fromUserId).select("_id expoPushTokens username email").lean();
    await notifyUser({
      userId: String((fromUser as any)?._id || (transfer as any).fromUserId || ""),
      tokens: ((fromUser as any)?.expoPushTokens || []) as string[],
      category: "crm",
      type: "crm_transfer_response",
      title: action === "accept" ? "Transfer Accepted" : "Transfer Rejected",
      body:
        action === "accept"
          ? `${toNonEmptyString((me as any)?.username || (me as any)?.email || "Agent")} accepted your CRM transfer request.`
          : `${toNonEmptyString((me as any)?.username || (me as any)?.email || "Agent")} rejected your CRM transfer request.`,
      data: {
        type: "crm_transfer_response",
        requestId: String((transfer as any)._id || ""),
        action,
      },
    }).catch((err) => {
      console.error("respondCrmTaskTransferRequest push error", err);
    });

    const item = await CrmTaskTransferRequest.findById((transfer as any)._id)
      .populate("leadId", "clientName title status dueDate")
      .populate("fromUserId", "email username")
      .populate("toUserId", "email username")
      .lean();

    return res.status(200).json({
      message: action === "accept" ? "Transfer accepted" : "Transfer rejected",
      item,
    });
  } catch (e: any) {
    console.error("respondCrmTaskTransferRequest error", e);
    return res.status(500).json({ message: e?.message || "Failed to respond to transfer request" });
  }
};

export const registerPushToken = async (req: AuthRequest, res: Response) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token || !token.startsWith("ExponentPushToken[")) {
      return res.status(400).json({ message: "Invalid Expo push token" });
    }

    await User.updateOne(
      { _id: req.userId },
      { $addToSet: { expoPushTokens: token } }
    );

    return res.status(200).json({ message: "Push token registered" });
  } catch (e: any) {
    console.error("registerPushToken error", e);
    return res.status(500).json({ message: "Failed to register push token" });
  }
};
