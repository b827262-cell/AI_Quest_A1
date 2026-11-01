import { useCallback, useEffect, useState } from "react";
import { adminApi, type AiAnalyticsSummary, type AiAnalyticsDailyRow, type AiAnalyticsProviderRow, type AiAnalyticsSubjectRow, type AiRequestLogRow, type AiRequestLogDetail, type AiRequestLogQuery, type AiRequestLogSort, type AiUsageDetail, type AiBudgetPolicyRow } from "../../api";
import { daysAgoIsoDate, todayIsoDate, friendlyError } from "./analytics-utils";

export function useAiAnalytics() {
  const [from, setFrom] = useState<string>(daysAgoIsoDate(13));
  const [to, setTo] = useState<string>(todayIsoDate());
  const [summary, setSummary] = useState<AiAnalyticsSummary | null>(null);
  const [daily, setDaily] = useState<AiAnalyticsDailyRow[]>([]);
  const [providers, setProviders] = useState<AiAnalyticsProviderRow[]>([]);
  const [subjects, setSubjects] = useState<AiAnalyticsSubjectRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logsBusy, setLogsBusy] = useState(false);
  const [policiesBusy, setPoliciesBusy] = useState(false);

  // Request log table state
  const [filterProvider, setFilterProvider] = useState("");
  const [filterSubject, setFilterSubject] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [sort, setSort] = useState<AiRequestLogSort>("newest");
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [logRows, setLogRows] = useState<AiRequestLogRow[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiRequestLogDetail | null>(null);
  // Full Q&A + token/cost detail (spec §4.3). Loaded only when the user clicks
  // "查看完整問答"; the list endpoint exposes previews only (spec §3.1).
  const [usageDetailRequestId, setUsageDetailRequestId] = useState<string | null>(null);
  const [usageDetail, setUsageDetail] = useState<AiUsageDetail | null>(null);
  const [usageDetailBusy, setUsageDetailBusy] = useState(false);

  // Budget policies
  const [policies, setPolicies] = useState<AiBudgetPolicyRow[]>([]);
  const [policySavingId, setPolicySavingId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [s, d, p, subj] = await Promise.all([
        adminApi.getAiAnalyticsSummary(),
        adminApi.getAiAnalyticsDaily(from, to),
        adminApi.getAiAnalyticsProviders(from, to),
        adminApi.getAiAnalyticsSubjects(from, to)
      ]);
      setSummary(s);
      setDaily(d);
      setProviders(p);
      setSubjects(subj);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }, [from, to]);

  const loadLogs = useCallback(async () => {
    setLogsBusy(true);
    try {
      const query: AiRequestLogQuery = {
        from,
        to,
        sort,
        page,
        limit
      };
      if (filterProvider) query.provider = filterProvider;
      if (filterSubject) query.subject = filterSubject;
      if (filterStatus) query.status = filterStatus;
      if (filterSource) query.requestSource = filterSource;
      const result = await adminApi.listAiRequests(query);
      setLogRows(result.rows);
      setLogTotal(result.total);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLogsBusy(false);
    }
  }, [from, to, filterProvider, filterSubject, filterStatus, filterSource, sort, page, limit]);

  const loadPolicies = useCallback(async () => {
    setPoliciesBusy(true);
    try {
      const result = await adminApi.listAiBudgetPolicies();
      setPolicies(result.policies);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPoliciesBusy(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    if (!selectedRequestId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    adminApi
      .getAiRequestDetail(selectedRequestId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRequestId]);

  // Load the full Q&A + token/cost detail when the user opens the full drawer.
  useEffect(() => {
    if (!usageDetailRequestId) {
      setUsageDetail(null);
      return;
    }
    let cancelled = false;
    setUsageDetailBusy(true);
    adminApi
      .getAiUsageDetail(usageDetailRequestId)
      .then((d) => {
        if (!cancelled) setUsageDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      })
      .finally(() => {
        if (!cancelled) setUsageDetailBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [usageDetailRequestId]);

  const totalPages = Math.max(1, Math.ceil(logTotal / limit));

  const handlePolicySave = useCallback(
    async (id: string, patch: {
      dailyTokenLimit?: number;
      dailyCostLimitUsd?: number;
      warningPercentage?: number;
      enabled?: boolean;
    }) => {
      setPolicySavingId(id);
      try {
        const updated = await adminApi.updateAiBudgetPolicy(id, patch);
        setPolicies((prev) => prev.map((p) => (p.id === id ? updated.policy : p)));
      } catch (e) {
        setError(friendlyError(e));
      } finally {
        setPolicySavingId(null);
      }
    },
    []
  );
  const successRate =
    summary && summary.totalRequests > 0
      ? Math.round((summary.successCount / summary.totalRequests) * 1000) / 10
      : 0;
  return { from, setFrom, to, setTo, summary, setSummary, daily, setDaily, providers, setProviders, subjects, setSubjects, error, setError, busy, setBusy, logsBusy, setLogsBusy, policiesBusy, setPoliciesBusy, filterProvider, setFilterProvider, filterSubject, setFilterSubject, filterStatus, setFilterStatus, filterSource, setFilterSource, sort, setSort, page, setPage, logRows, setLogRows, logTotal, setLogTotal, selectedRequestId, setSelectedRequestId, detail, setDetail, usageDetailRequestId, setUsageDetailRequestId, usageDetail, setUsageDetail, usageDetailBusy, setUsageDetailBusy, policies, setPolicies, policySavingId, setPolicySavingId, limit, loadOverview, loadLogs, loadPolicies, totalPages, handlePolicySave, successRate };
}
export type AiAnalyticsState = ReturnType<typeof useAiAnalytics>;
