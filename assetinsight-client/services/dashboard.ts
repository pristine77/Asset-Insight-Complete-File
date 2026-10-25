import API from "@/lib/api";

export type DashboardRange = 7 | 31 | 183;

export type DashboardSeriesPoint = {
  date: string;
  reports: number;
  lots: number;
};

export type LeaderboardEntry = {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  reports: number;
  lots: number;
  rank: number;
};

export type DashboardAnalytics = {
  rangeDays: DashboardRange;
  generatedAt: string;
  totals: { reports: number; lots: number };
  series: DashboardSeriesPoint[];
  leaderboard: {
    entries: LeaderboardEntry[];
    totals: { users: number; reports: number; lots: number };
  };
};

export const DashboardService = {
  async getAnalytics(range: DashboardRange): Promise<DashboardAnalytics> {
    const { data } = await API.get<DashboardAnalytics>(
      `/reports/dashboard-analytics?range=${range}`
    );
    return data;
  },
};
