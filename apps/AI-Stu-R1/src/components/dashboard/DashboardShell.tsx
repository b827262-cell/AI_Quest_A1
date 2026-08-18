import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Book } from "@ai-smartbook/schema";
import { Card } from "@ai-smartbook/ui";
import { GuestAnswerSection } from "./GuestAnswerSection";
import { MetricCards, type MetricCardData } from "./MetricCards";
import { SmartBookSection, type DashboardResourceStatus } from "./SmartBookSection";
import {
  askDashboardGuestQuestion,
  dashboardProfileFromSession,
  loadDashboardBooks,
  sendDashboardGuestFeedback,
  type DashboardProfile
} from "../../dashboard/dashboardQueries";
import { useStudentAuth } from "../../student-auth";
import type { GuestAskResponse } from "../../studentClient";

interface ResourceState<T> {
  status: DashboardResourceStatus;
  data: T | null;
  error: string | null;
}

const INITIAL_BOOKS_STATE: ResourceState<Book[]> = {
  status: "loading",
  data: null,
  error: null
};

export interface DashboardShellProps {
  profile?: DashboardProfile;
  loadBooks?: typeof loadDashboardBooks;
  askGuestQuestion?: typeof askDashboardGuestQuestion;
  sendGuestFeedback?: typeof sendDashboardGuestFeedback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "服務暫時無法使用，請稍後再試。";
}

export function DashboardShell({
  profile: profileOverride,
  loadBooks = loadDashboardBooks,
  askGuestQuestion = askDashboardGuestQuestion,
  sendGuestFeedback = sendDashboardGuestFeedback
}: DashboardShellProps) {
  const { profile: sessionProfile } = useStudentAuth();
  const profile = profileOverride ?? dashboardProfileFromSession(sessionProfile);
  const [books, setBooks] = useState<ResourceState<Book[]>>(INITIAL_BOOKS_STATE);
  const [guestStatus, setGuestStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [guestResponse, setGuestResponse] = useState<GuestAskResponse | null>(null);
  const [guestError, setGuestError] = useState<string | null>(null);

  async function refreshBooks() {
    setBooks((current) => ({ ...current, status: "loading", error: null }));
    try {
      const nextBooks = await loadBooks();
      setBooks({ status: "success", data: nextBooks, error: null });
    } catch (error) {
      setBooks((current) => ({
        status: "error",
        data: current.data,
        error: errorMessage(error)
      }));
    }
  }

  useEffect(() => {
    void refreshBooks();
    // The caller can replace the query adapter for a test or a compatible
    // backend. It is intentionally the only dependency of this resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBooks]);

  async function askGuest(question: string) {
    setGuestStatus("loading");
    setGuestError(null);
    setGuestResponse(null);
    try {
      const response = await askGuestQuestion(question);
      setGuestResponse(response);
      setGuestStatus("success");
    } catch (error) {
      setGuestStatus("error");
      setGuestError(errorMessage(error));
    }
  }

  function sendFeedback(helpful: boolean) {
    if (!guestResponse?.requestId) return;
    void sendGuestFeedback(guestResponse.requestId, helpful).catch(() => undefined);
  }

  const profileName = profile.name || "訪客";
  const bookCount = books.status === "success" && books.data ? books.data.length : null;
  const guestRemaining = guestResponse?.remainingGuestQuestions ?? null;
  const metrics = useMemo<MetricCardData[]>(() => [
    {
      id: "books",
      label: "可閱讀書本",
      value: bookCount,
      description: "目前書庫中的閱讀入口",
      tone: "blue"
    },
    {
      id: "points",
      label: "學習點數",
      value: profile.points,
      description: "來自目前的學員 profile",
      tone: "yellow"
    },
    {
      id: "guest-remaining",
      label: "訪客剩餘提問",
      value: guestRemaining,
      description: "完成一次公開問答後更新",
      tone: "purple"
    },
    {
      id: "progress",
      label: "閱讀進度",
      value: null,
      description: "等待進度 session 契約",
      tone: "green"
    }
  ], [bookCount, guestRemaining, profile.points]);

  return (
    <div className="dashboard-shell">
      <section className="dashboard-welcome" aria-labelledby="dashboard-welcome-heading">
        <div>
          <span className="dashboard-eyebrow">Student Dashboard</span>
          <h1 id="dashboard-welcome-heading">{profileName}，歡迎回來</h1>
          <p>從書本、學習摘要與快速問答開始今天的探索。</p>
        </div>
        {profile.authenticated ? (
          <span className="dashboard-auth-status" role="status"><span aria-hidden="true">●</span> 已登入學員</span>
        ) : (
          <Card className="dashboard-guest-status">
            <strong>目前以訪客模式瀏覽</strong>
            <span>登入後可接續個人化學習紀錄。</span>
            <Link to="/login">前往登入 →</Link>
          </Card>
        )}
      </section>

      <MetricCards metrics={metrics} />

      <div className="dashboard-content-grid">
        <SmartBookSection
          books={books.data ?? []}
          status={books.status}
          error={books.error}
          onRetry={() => void refreshBooks()}
        />
        <GuestAnswerSection
          response={guestResponse}
          status={guestStatus}
          error={guestError}
          onAsk={askGuest}
          onFeedback={sendFeedback}
        />
      </div>
    </div>
  );
}
