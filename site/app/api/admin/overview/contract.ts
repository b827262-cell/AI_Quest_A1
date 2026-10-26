/** Aggregate-only admin overview. A future real source must count student_users,
 * not chat sessions, for totalUsers. activeUsers uses a 15-minute window. */
export type OverviewSource = "real" | "empty" | "unavailable";

export type DailyConversationPoint = { date: string; count: number };

export type AdminOverview = {
  totalUsers: number;
  activeUsers: number;
  totalConversations: number;
  totalMessages: number;
  dailyConversations: DailyConversationPoint[];
  source: OverviewSource;
  asOf: string;
  isSynthetic: false;
};

export function overviewWithoutData(source: "empty" | "unavailable", now = new Date()): AdminOverview {
  return {
    totalUsers: 0,
    activeUsers: 0,
    totalConversations: 0,
    totalMessages: 0,
    dailyConversations: [],
    source,
    asOf: now.toISOString(),
    isSynthetic: false,
  };
}
