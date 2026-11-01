import { useEffect, useRef, useState } from "react";
import {
  acknowledgeLearningTombstone,
  importGuestLearningHistory,
  mergeLearningHistory,
  readGuestLearningHistory,
  readLearningHistory,
  readLearningTombstones,
  setLearningHistoryScope,
  splitLearningHistoryBatches,
  type LearningHistoryEntry
} from "../../learningHistory";
import { studentClient } from "../../studentClient";
import { useStudentAuth } from "../../student-auth";

export function useLearningHistorySync() {
  const { user, status: authStatus } = useStudentAuth();
  const studentName = user?.displayName || "";
  const [learningHistory, setLearningHistory] = useState<LearningHistoryEntry[]>(() => readLearningHistory());
  const [scopeReady, setScopeReady] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState("只儲存在這台裝置");
  const [guestImportCount, setGuestImportCount] = useState(0);
  const [syncRetry, setSyncRetry] = useState(0);
  const remoteVersions = useRef(new Map<string, number>());
  const remoteDeleted = useRef(new Set<string>());
  const syncBusy = useRef(false);
  const syncQueued = useRef(false);
  const activeSyncUser = useRef<string | null>(null);

  useEffect(() => {
    const studentId = authStatus === "authenticated" ? user?.id ?? null : null;
    activeSyncUser.current = studentId;
    setLearningHistoryScope(studentId);
    setLearningHistory(readLearningHistory());
    setGuestImportCount(studentId ? readGuestLearningHistory().length : 0);
    setScopeReady(null);
    remoteVersions.current.clear();
    remoteDeleted.current.clear();
    if (!studentId) {
      setSyncStatus("只儲存在這台裝置");
      return;
    }
    let active = true;
    setSyncStatus("正在讀取後台紀錄…");
    void (async () => {
      const records: Array<LearningHistoryEntry & { updatedAt: string; deletedAt: string | null }> = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await studentClient.listLearningHistory(offset);
        records.push(...page.entries);
        offset = page.nextOffset;
        if (records.length > 10_000) throw new Error("學習紀錄超過本機一次可載入的上限");
      }
      if (!active) return;
      remoteVersions.current = new Map(records.map((entry) => [entry.id, entry.syncVersion || 1]));
      remoteDeleted.current = new Set(records.filter((entry) => Boolean(entry.deletedAt)).map((entry) => entry.id));
      setLearningHistory(mergeLearningHistory(records));
      setScopeReady(studentId);
      setSyncStatus("後台紀錄已載入");
    })().catch(() => { if (active) setSyncStatus("讀取後台失敗；本機紀錄已保留，可重試。"); });
    return () => { active = false; };
  }, [authStatus, user?.id, syncRetry]);

  useEffect(() => {
    if (!user || scopeReady !== user.id) return;
    if (syncBusy.current) { syncQueued.current = true; return; }
    const pending = learningHistory.filter((entry) => (entry.syncVersion || 1) > (remoteVersions.current.get(entry.id) || 0));
    const removed = readLearningTombstones().filter((item) => {
      if (!remoteVersions.current.has(item.id)) { acknowledgeLearningTombstone(item.id); return false; }
      if (remoteDeleted.current.has(item.id)) { acknowledgeLearningTombstone(item.id); return false; }
      return true;
    });
    if (!pending.length && !removed.length) {
      if (learningHistory.length) setSyncStatus("已同步後台");
      return;
    }
    syncBusy.current = true;
    setSyncStatus("正在同步後台…");
    void (async () => {
      for (const batch of splitLearningHistoryBatches(pending)) {
        if (activeSyncUser.current !== user.id) return;
        const result = await studentClient.upsertLearningHistory(batch);
        if (activeSyncUser.current !== user.id) return;
        for (const entry of result.entries) {
          remoteVersions.current.set(entry.id, entry.syncVersion || 1);
          if (entry.deletedAt) remoteDeleted.current.add(entry.id);
        }
        setLearningHistory(mergeLearningHistory(result.entries));
      }
      for (const item of removed) {
        if (activeSyncUser.current !== user.id) return;
        const requestedVersion = Math.max(item.syncVersion, (remoteVersions.current.get(item.id) || 0) + 1);
        const result = await studentClient.deleteLearningHistory(item.id, requestedVersion);
        if (activeSyncUser.current !== user.id) return;
        if (!result.entry.deletedAt || result.entry.syncVersion < requestedVersion) throw new Error("刪除尚未確認");
        remoteVersions.current.set(item.id, result.entry.syncVersion);
        remoteDeleted.current.add(item.id);
        acknowledgeLearningTombstone(item.id);
      }
      if (activeSyncUser.current === user.id) setSyncStatus("已同步後台");
    })().catch(() => { if (activeSyncUser.current === user.id) setSyncStatus("同步失敗；本機紀錄已保留，可重試。"); })
      .finally(() => {
        syncBusy.current = false;
        if (syncQueued.current) { syncQueued.current = false; setSyncRetry((value) => value + 1); }
      });
  }, [learningHistory, scopeReady, user?.id]);

  function importGuestHistory() {
    setLearningHistory(importGuestLearningHistory());
    setGuestImportCount(0);
    setSyncStatus("正在同步後台…");
  }

  function retrySync() {
    setSyncRetry((value) => value + 1);
  }

  return {
    authStatus,
    studentName,
    learningHistory,
    setLearningHistory,
    syncStatus,
    guestImportCount,
    importGuestHistory,
    retrySync
  };
}
