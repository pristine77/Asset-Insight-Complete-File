import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import ReportJob from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import { getReportJobTempStats } from "../utils/reportJobTempMaintenance.js";

/**
 * Operational snapshot for the durable report pipeline.
 *
 * It combines persisted job/session state with temporary-storage telemetry so an
 * administrator can inspect queue/session counts, observed queue wait, and disk
 * accumulation without coupling the client to schemas. It does not classify stalls.
 */

export const getReportJobStats = async (_req: AuthRequest, res: Response) => {
  try {
    // These are current all-time state buckets, not rates over a time window; the
    // response names preserve the established monitoring contract.
    const rows = await ReportJob.aggregate([
      {
        $group: {
          _id: { type: "$type", status: "$status" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.type": 1, "_id.status": 1 } },
    ]);
    const uploadSessions = await ReportUploadSession.aggregate([
      {
        $group: {
          _id: { type: "$type", status: "$status" },
          count: { $sum: 1 },
          totalBytes: { $sum: "$totalBytes" },
        },
      },
      { $sort: { "_id.type": 1, "_id.status": 1 } },
    ]);
    // Queue wait is measured only for jobs that actually started, avoiding misleading
    // subtraction for queued records whose `startedAt` value does not yet exist.
    const queueWait = await ReportJob.aggregate([
      {
        $match: {
          startedAt: { $exists: true },
          queuedAt: { $exists: true },
        },
      },
      {
        $project: {
          waitMs: { $subtract: ["$startedAt", "$queuedAt"] },
        },
      },
      {
        $group: {
          _id: null,
          avgWaitMs: { $avg: "$waitMs" },
          maxWaitMs: { $max: "$waitMs" },
        },
      },
    ]);
    const temp = await getReportJobTempStats();

    res.status(200).json({
      message: "Report job stats fetched successfully",
      data: {
        jobs: rows.map((row: any) => ({
          type: row._id.type,
          status: row._id.status,
          count: row.count,
        })),
        uploadSessions: uploadSessions.map((row: any) => ({
          type: row._id.type,
          status: row._id.status,
          count: row.count,
          totalBytes: row.totalBytes,
        })),
        queue: {
          avgWaitMs: Math.round(queueWait?.[0]?.avgWaitMs || 0),
          maxWaitMs: Math.round(queueWait?.[0]?.maxWaitMs || 0),
        },
        temp,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch report job stats", error });
  }
};
