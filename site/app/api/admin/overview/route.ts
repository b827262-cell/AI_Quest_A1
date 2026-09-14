import { getAuthFromRequest } from "../../auth-helper";
import { getDb, isProductionEnvironment } from "../../../../db";
import { adminOverview } from "../../../../db/schema";

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);

  if (!auth.isAuthenticated) {
    return Response.json(
      { error: "admin authentication required", authenticated: false },
      { status: 401 }
    );
  }

  if (auth.role !== "admin") {
    return Response.json(
      { error: "admin permission required", authenticated: true, role: auth.role },
      { status: 403 }
    );
  }

  const defaultTotals = {
    totalUsers: 93,
    activeUsers: 5,
    totalSessions: 93,
    totalMessages: 107,
  };

  try {
    const db = await getDb();
    const rows = await db.select().from(adminOverview);
    for (const row of rows) {
      if (row.metricName === "總用戶數") defaultTotals.totalUsers = row.metricValue;
      if (row.metricName === "活躍用戶") defaultTotals.activeUsers = row.metricValue;
      if (row.metricName === "總對話數") defaultTotals.totalSessions = row.metricValue;
      if (row.metricName === "總訊息數") defaultTotals.totalMessages = row.metricValue;
    }
  } catch (error) {
    if (isProductionEnvironment()) {
      return Response.json(
        { error: "database_unavailable", message: "D1 database binding 'DB' is unavailable in production" },
        { status: 503 }
      );
    }
    // Graceful fallback to default synthetic metrics in dev/test
  }

  return Response.json({
    totals: defaultTotals,
    topSubjects: [
      { name: "中級會計學", count: 49 },
      { name: "商研", count: 4 },
    ],
    recentKeywords: [
      "用例子解釋 (9)",
      "解析第一題 (7)",
      "整理這頁重點 (6)",
      "本章有考題 (6)",
      "IASB (5)",
      "IAS (4)",
      "IFRS (4)",
      "是什麼關係 (4)",
    ],
    isSynthetic: true,
  });
}
