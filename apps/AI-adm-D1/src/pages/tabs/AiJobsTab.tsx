import { useEffect, useState } from "react";
import type { BookAiJob } from "@ai-smartbook/schema";
import { adminApi } from "../../api";

export function AiJobsTab({ bookId }: { bookId: string }) {
  const [jobs, setJobs] = useState<BookAiJob[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void adminApi.getJobs(bookId)
      .then((d) => {
        if (active) setJobs(d.jobs);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [bookId]);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>AI 任務記錄（{jobs.length}）</h3>
      {error ? <p className="error">{error}</p> : null}
      {jobs.length === 0 ? (
        <p className="muted">尚無 AI 任務。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>類型</th>
              <th>狀態</th>
              <th>建立時間</th>
              <th>錯誤</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.jobType}</td>
                <td>
                  <span className={`badge ${j.status}`}>{j.status}</span>
                </td>
                <td className="muted">{new Date(j.createdAt).toLocaleString()}</td>
                <td className="error">{j.errorMessage || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
