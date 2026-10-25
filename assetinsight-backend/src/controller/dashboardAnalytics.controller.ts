import type { Response } from "express";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import User from "../models/user.model.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";

const ALLOWED_RANGES = new Set([7, 31, 183]);

type ActivityRow = { _id: string; reports: number; lots: number };
type LeaderRow = { _id: mongoose.Types.ObjectId; reports: number; lots: number };
type FacetResult = { series: ActivityRow[]; leaderboard: LeaderRow[] };

function rangeStart(days: number): Date {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - (days - 1));
  return value;
}

function lotCountExpression() {
  const rootLots = { $cond: [{ $isArray: "$lots" }, "$lots", []] };
  const previewLots = {
    $cond: [{ $isArray: "$preview_data.lots" }, "$preview_data.lots", []],
  };
  return { $max: [{ $size: rootLots }, { $size: previewLots }] };
}

function analyticsPipeline(userId: mongoose.Types.ObjectId, start: Date) {
  return [
    {
      $match: {
        createdAt: { $gte: start },
        is_draft_preview: { $ne: true },
      },
    },
    { $project: { user: 1, createdAt: 1, lots: lotCountExpression() } },
    {
      $facet: {
        series: [
          { $match: { user: userId } },
          {
            $group: {
              _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "UTC" } },
              reports: { $sum: 1 },
              lots: { $sum: "$lots" },
            },
          },
        ],
        leaderboard: [
          {
            $group: {
              _id: "$user",
              reports: { $sum: 1 },
              lots: { $sum: "$lots" },
            },
          },
        ],
      },
    },
  ];
}

function mergeRows<T extends { reports: number; lots: number }>(
  rows: T[],
  keyFor: (row: T) => string
) {
  const merged = new Map<string, { reports: number; lots: number }>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const current = merged.get(key) || { reports: 0, lots: 0 };
    current.reports += Number(row.reports || 0);
    current.lots += Number(row.lots || 0);
    merged.set(key, current);
  }
  return merged;
}

// One aggregate powers both the chart and leaderboard. This prevents the
// dashboard from issuing a request per user/report as data volume increases.
export const getDashboardAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    const requested = Number(req.query.range || 31);
    const rangeDays = ALLOWED_RANGES.has(requested) ? requested : 31;
    const start = rangeStart(rangeDays);
    const userId = new mongoose.Types.ObjectId(String(req.userId));

    const [assetResult, lotListingResult] = await Promise.all([
      AssetReport.aggregate<FacetResult>(analyticsPipeline(userId, start)),
      LotListing.aggregate<FacetResult>(analyticsPipeline(userId, start)),
    ]);
    const asset = assetResult[0] || { series: [], leaderboard: [] };
    const lotListing = lotListingResult[0] || { series: [], leaderboard: [] };

    const seriesMap = mergeRows(
      [...asset.series, ...lotListing.series],
      (row) => String(row._id || "")
    );
    const series = Array.from({ length: rangeDays }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      const value = seriesMap.get(key) || { reports: 0, lots: 0 };
      return { date: key, ...value };
    });

    const leaderboardMap = mergeRows(
      [...asset.leaderboard, ...lotListing.leaderboard],
      (row) => String(row._id || "")
    );
    const leaderIds = [...leaderboardMap.keys()].filter((id) =>
      mongoose.isValidObjectId(id)
    );
    const users = await User.find({ _id: { $in: leaderIds } })
      .select("username companyName avatarUrl")
      .lean();
    const userMap = new Map(users.map((user: any) => [String(user._id), user]));
    const entries = [...leaderboardMap.entries()]
      .map(([id, value]) => {
        const user = userMap.get(id) as any;
        return {
          userId: id,
          displayName: user?.username || user?.companyName || "User",
          avatarUrl: user?.avatarUrl || null,
          reports: value.reports,
          lots: value.lots,
        };
      })
      .sort((a, b) => b.lots - a.lots || b.reports - a.reports || a.displayName.localeCompare(b.displayName))
      .slice(0, 50)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    const totals = series.reduce(
      (sum, point) => ({ reports: sum.reports + point.reports, lots: sum.lots + point.lots }),
      { reports: 0, lots: 0 }
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      rangeDays,
      generatedAt: new Date().toISOString(),
      totals,
      series,
      leaderboard: {
        entries,
        totals: {
          users: leaderboardMap.size,
          reports: [...leaderboardMap.values()].reduce((sum, row) => sum + row.reports, 0),
          lots: [...leaderboardMap.values()].reduce((sum, row) => sum + row.lots, 0),
        },
      },
    });
  } catch (error) {
    console.error("[DashboardAnalytics] failed:", error);
    return res.status(500).json({ message: "Unable to load dashboard activity" });
  }
};
