import { Card } from "@ai-smartbook/ui";

export interface MetricCardData {
  id: string;
  label: string;
  value: number | null;
  description: string;
  tone?: "blue" | "purple" | "yellow" | "green";
}

export function formatMetricValue(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function MetricCards({ metrics }: { metrics: MetricCardData[] }) {
  return (
    <section className="dashboard-metrics" aria-labelledby="dashboard-metrics-heading">
      <div className="dashboard-section-heading">
        <div>
          <span className="dashboard-eyebrow">學習概況</span>
          <h2 id="dashboard-metrics-heading">你的學習指標</h2>
        </div>
        <span className="dashboard-heading-note">即時摘要</span>
      </div>
      <div className="dashboard-metrics-grid">
        {metrics.map((metric) => {
          const unavailable = metric.value === null;
          return (
            <Card
              className={`dashboard-metric-card tone-${metric.tone ?? "blue"}${unavailable ? " is-unavailable" : ""}`}
              key={metric.id}
              aria-label={`${metric.label}：${formatMetricValue(metric.value)}`}
            >
              <span className="dashboard-metric-label">{metric.label}</span>
              <strong className="dashboard-metric-value">
                {formatMetricValue(metric.value)}
              </strong>
              <span className="dashboard-metric-description">
                {unavailable ? "目前沒有可用資料" : metric.description}
              </span>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
