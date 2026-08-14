import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface LatestRecord {
  日期?: string;
  外資買賣超?: string | number | null;
  投信買賣超?: string | number | null;
  自營商買賣超?: string | number | null;
  三大法人合計買賣超?: string | number | null;
  外資期貨未平倉?: string | number | null;
  外資期貨未平倉變化?: string | number | null;
  投信期貨未平倉?: string | number | null;
  自營商期貨未平倉?: string | number | null;
  投信期貨未平倉變化?: string | number | null;
  自營商期貨未平倉變化?: string | number | null;
  外資小台期貨未平倉?: string | number | null;
  外資小台期貨未平倉變化?: string | number | null;
}

interface MarketClose {
  status?: string;
  as_of?: string;
  futures_near_month_close?: number | null;
  near_month_contract?: string;
  weighted_index_close?: number | null;
  weighted_index_change?: number | null;
  trading_value?: number | null;
  margin_balance?: number | null;
}

interface Dmi {
  period?: number;
  status?: string;
  plus_di?: number | null;
  minus_di?: number | null;
  adx?: number | null;
  as_of?: string;
  interpretation?: string[];
}

interface FlowData {
  data_date?: string;
  status?: string;
  parsed_at?: string;
  latest?: {
    foreign_spot_amount_yi?: number | null;
    total_spot_amount_yi?: number | null;
    foreign_futures_oi?: number | null;
    foreign_futures_oi_change?: number | null;
  };
  history?: LatestRecord[];
  interpretation?: string[];
  market_close?: MarketClose;
  dmi?: Dmi;
}

function fmtYi(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${v >= 0 ? "▲ " : "▼ "}${Math.abs(v).toFixed(2)} 億`;
}

function fmtNum(v: number | string | null | undefined, digits = 0): string {
  if (v == null || v === "") return "N/A";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "N/A";
  if (digits > 0) return n.toFixed(digits);
  return Math.round(n).toLocaleString("zh-TW");
}

function fmtChange(v: number | string | null | undefined): string {
  if (v == null || v === "") return "N/A";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "N/A";
  const abs = Math.abs(Math.round(n)).toLocaleString("zh-TW");
  return n >= 0 ? `▲ ${abs}` : `▼ ${abs}`;
}

function Chip({ label, val, pos, neg }: { label: string; val: string; pos?: boolean; neg?: boolean }) {
  const cls = pos ? " pos" : neg ? " neg" : "";
  return (
    <div className={`antig-chip${cls}`}>
      <span className="antig-chip-label">{label}</span>
      <span className="antig-chip-val">{val}</span>
    </div>
  );
}

export function InstitutionalFlowPage() {
  const [data, setData] = useState<FlowData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/institutional-flow")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FlowData>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  const latest = data?.latest;
  const mc = data?.market_close;
  const dmi = data?.dmi;
  const history = data?.history ?? [];

  const foiRaw = latest?.foreign_futures_oi;
  const foiN = foiRaw != null ? Number(foiRaw) : null;
  const foiChangeRaw = latest?.foreign_futures_oi_change;
  const foiChangeN = foiChangeRaw != null ? Number(foiChangeRaw) : null;

  // If FOI is negative, net short; if daily change positive, covering shorts
  const foiSentiment = foiN != null ? (foiN < 0 ? "偏空（淨空單）" : "偏多（淨多單）") : "N/A";
  const foiChangeSentiment = foiChangeN != null
    ? foiChangeN > 0
      ? "空單回補"
      : foiChangeN < 0
        ? "加碼空單"
        : "持平"
    : "N/A";

  return (
    <div className="antig-portal-bg">
      <div className="antig-flow-container">
        {/* Back nav */}
        <div className="antig-breadcrumb">
          <Link to="/antiG" className="antig-back-link">← 返回 AntiG 門戶</Link>
        </div>

        {/* Hero */}
        <div className="antig-flow-hero">
          <h1 className="antig-flow-title">台指期與台股法人每日報告</h1>
          {data && (
            <div className="antig-flow-meta">
              <span>資料日期：{data.data_date ?? "N/A"}</span>
              <span>·</span>
              <span>更新：{data.parsed_at?.slice(0, 16) ?? "N/A"}</span>
              <span>·</span>
              <span className={`antig-status-badge ${data.status === "success" ? "ok" : "warn"}`}>
                {data.status ?? "未知"}
              </span>
            </div>
          )}
        </div>

        {loading && (
          <div className="antig-loading">
            <div className="antig-spinner" />
            <span>載入資料中…</span>
          </div>
        )}

        {error && (
          <div className="antig-error-box">
            <p>⚠️ 無法載入資料：{error}</p>
            <p>
              請使用{" "}
              <a
                href="https://github.com/b827262-cell/Anti-G-C1/blob/codex/tw-legal-flow-dashboard/reports/LATEST_INSTITUTIONAL_FLOW.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub Markdown 備用連結
              </a>
              。
            </p>
          </div>
        )}

        {data && !loading && (
          <>
            {/* ── 今日重點 ─────────────────────────── */}
            <section className="antig-section">
              <h2 className="antig-section-title">今日重點</h2>
              <div className="antig-chips-grid">
                <Chip
                  label="外資現貨買賣超"
                  val={fmtYi(latest?.foreign_spot_amount_yi)}
                  pos={(latest?.foreign_spot_amount_yi ?? 0) > 0}
                  neg={(latest?.foreign_spot_amount_yi ?? 0) < 0}
                />
                <Chip
                  label="三大法人合計"
                  val={fmtYi(latest?.total_spot_amount_yi)}
                  pos={(latest?.total_spot_amount_yi ?? 0) > 0}
                  neg={(latest?.total_spot_amount_yi ?? 0) < 0}
                />
                <Chip
                  label="外資台指期未平倉"
                  val={foiN != null ? `${foiN.toLocaleString("zh-TW")} 口` : "N/A"}
                  neg={foiN != null && foiN < 0}
                  pos={foiN != null && foiN > 0}
                />
                <Chip
                  label="期貨部位方向"
                  val={foiSentiment}
                  neg={foiN != null && foiN < 0}
                  pos={foiN != null && foiN > 0}
                />
                <Chip
                  label="期貨今日變化"
                  val={foiChangeN != null ? `${fmtChange(foiChangeN)} 口` : "N/A"}
                  pos={foiChangeN != null && foiChangeN > 0}
                  neg={foiChangeN != null && foiChangeN < 0}
                />
                <Chip
                  label="期貨變化解讀"
                  val={foiChangeSentiment}
                />
              </div>
            </section>

            {/* ── 尾盤市場概況 ─────────────────────── */}
            <section className="antig-section">
              <h2 className="antig-section-title">尾盤市場概況</h2>
              <div className="antig-chips-grid">
                <Chip label="台指期近月收盤" val={mc?.futures_near_month_close != null ? fmtNum(mc.futures_near_month_close) : "N/A"} />
                <Chip label="近月合約" val={mc?.near_month_contract ?? "N/A"} />
                <Chip
                  label="加權指數收盤"
                  val={mc?.weighted_index_close != null ? fmtNum(mc.weighted_index_close, 2) : "N/A"}
                />
                <Chip
                  label="指數漲跌"
                  val={mc?.weighted_index_change != null ? fmtChange(mc.weighted_index_change) : "N/A"}
                  pos={(mc?.weighted_index_change ?? 0) > 0}
                  neg={(mc?.weighted_index_change ?? 0) < 0}
                />
                <Chip
                  label="成交值（元）"
                  val={mc?.trading_value != null ? (mc.trading_value / 1e8).toFixed(0) + " 億" : "N/A"}
                />
                <Chip
                  label="融資餘額（交易單位）"
                  val={mc?.margin_balance != null ? fmtNum(mc.margin_balance) : "N/A"}
                />
              </div>
              {mc?.status === "partial" && (
                <p className="antig-note">⚠️ 部分市場資料尚未完整（當沖比重等欄位 N/A）</p>
              )}
            </section>

            {/* ── DMI 技術面判讀 ───────────────────── */}
            <section className="antig-section">
              <h2 className="antig-section-title">DMI 技術面判讀</h2>
              <div className="antig-chips-grid">
                <Chip label={`+DI（${dmi?.period ?? 14}日）`} val={dmi?.plus_di != null ? dmi.plus_di.toFixed(2) : "N/A"} />
                <Chip label={`-DI（${dmi?.period ?? 14}日）`} val={dmi?.minus_di != null ? dmi.minus_di.toFixed(2) : "N/A"} />
                <Chip label="ADX" val={dmi?.adx != null ? dmi.adx.toFixed(2) : "N/A"} />
                <Chip
                  label="多空判斷"
                  val={
                    dmi?.plus_di != null && dmi?.minus_di != null
                      ? dmi.plus_di > dmi.minus_di
                        ? "買方力道占優"
                        : "賣方力道占優"
                      : "N/A"
                  }
                  pos={dmi?.plus_di != null && dmi?.minus_di != null && dmi.plus_di > dmi.minus_di}
                  neg={dmi?.plus_di != null && dmi?.minus_di != null && dmi.plus_di <= dmi.minus_di}
                />
              </div>
              {dmi?.interpretation && dmi.interpretation.length > 0 && (
                <ul className="antig-interp-list">
                  {dmi.interpretation.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 法人動向觀察 ─────────────────────── */}
            {data.interpretation && data.interpretation.length > 0 && (
              <section className="antig-section">
                <h2 className="antig-section-title">法人動向觀察</h2>
                <ul className="antig-interp-list">
                  {data.interpretation.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── 近二週台指期法人資料 ─────────────── */}
            <section className="antig-section">
              <h2 className="antig-section-title">近二週台指期法人資料</h2>
              <div className="antig-table-wrapper">
                <table className="antig-table" id="table-futures">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>外資未平倉（口）</th>
                      <th>外資今日變化</th>
                      <th>投信未平倉</th>
                      <th>自營商未平倉</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.slice(0, 14).map((row, i) => {
                      const foi = row["外資期貨未平倉"];
                      const foiNum = foi != null ? Number(foi) : null;
                      const foiChg = row["外資期貨未平倉變化"];
                      const foiChgNum = foiChg != null ? Number(foiChg) : null;
                      return (
                        <tr key={i}>
                          <td>{row["日期"] ?? "—"}</td>
                          <td className={foiNum != null && foiNum < 0 ? "neg" : foiNum != null && foiNum > 0 ? "pos" : ""}>
                            {foiNum != null ? foiNum.toLocaleString("zh-TW") : "—"}
                          </td>
                          <td className={foiChgNum != null && foiChgNum > 0 ? "pos" : foiChgNum != null && foiChgNum < 0 ? "neg" : ""}>
                            {foiChgNum != null ? (foiChgNum >= 0 ? "▲ " : "▼ ") + Math.abs(foiChgNum).toLocaleString("zh-TW") : "—"}
                          </td>
                          <td>{fmtNum(row["投信期貨未平倉"])}</td>
                          <td>{fmtNum(row["自營商期貨未平倉"])}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── 近二週台股現貨三大法人 ─────────────── */}
            <section className="antig-section">
              <h2 className="antig-section-title">近二週台股現貨三大法人</h2>
              <div className="antig-table-wrapper">
                <table className="antig-table" id="table-spot">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>外資買賣超</th>
                      <th>投信買賣超</th>
                      <th>自營商買賣超</th>
                      <th>三大法人合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.slice(0, 14).map((row, i) => {
                      const cols = [
                        row["外資買賣超"],
                        row["投信買賣超"],
                        row["自營商買賣超"],
                        row["三大法人合計買賣超"],
                      ];
                      return (
                        <tr key={i}>
                          <td>{row["日期"] ?? "—"}</td>
                          {cols.map((v, j) => {
                            const n = v != null ? Number(v) : null;
                            const yi = n != null ? n / 1e8 : null;
                            return (
                              <td
                                key={j}
                                className={yi != null && yi > 0 ? "pos" : yi != null && yi < 0 ? "neg" : ""}
                              >
                                {yi != null ? (yi >= 0 ? "▲ " : "▼ ") + Math.abs(yi).toFixed(2) + " 億" : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── 資料來源 ─────────────────────────── */}
            <section className="antig-section antig-section-sm">
              <h2 className="antig-section-title">資料來源</h2>
              <ul className="antig-source-list">
                <li>台灣證券交易所（TWSE）三大法人買賣超：<a href="https://www.twse.com.tw/rwd/zh/fund/BFI82U" target="_blank" rel="noopener noreferrer">BFI82U</a></li>
                <li>台灣期貨交易所（TAIFEX）法人期貨未平倉：<a href="https://www.taifex.com.tw/cht/3/futContractsDate" target="_blank" rel="noopener noreferrer">futContractsDate</a></li>
                <li>TWSE 加權指數收盤：<a href="https://www.twse.com.tw/exchangeReport/MI_INDEX" target="_blank" rel="noopener noreferrer">MI_INDEX</a></li>
                <li>TAIFEX 台指期近月收盤：<a href="https://www.taifex.com.tw/cht/3/futDailyMarketReport" target="_blank" rel="noopener noreferrer">futDailyMarketReport</a></li>
              </ul>
            </section>

            {/* ── 風險與限制 ───────────────────────── */}
            <section className="antig-section antig-section-sm antig-risk">
              <h2 className="antig-section-title">⚠️ 風險與限制</h2>
              <ul className="antig-source-list">
                <li>本報告僅供參考，不構成任何投資建議。</li>
                <li>外資台指期未平倉為負值代表淨空單（偏空），正值代表淨多單（偏多）。</li>
                <li>單日期貨未平倉變化為正值，代表當日空單回補或多單增加，不代表整體方向翻多。</li>
                <li>資料更新時間以每日 20:00 後為準，非交易日不更新。</li>
                <li>投資有風險，請依個人判斷做出決策。</li>
              </ul>
            </section>

            {/* GitHub backup */}
            <div className="antig-github-row">
              <a
                id="btn-github-backup"
                href="https://github.com/b827262-cell/Anti-G-C1/blob/codex/tw-legal-flow-dashboard/reports/LATEST_INSTITUTIONAL_FLOW.md"
                target="_blank"
                rel="noopener noreferrer"
                className="antig-btn antig-btn-secondary"
              >
                🔗 GitHub Markdown 備用連結
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
