import { useState, useEffect } from "react";
import { AIActionButton, PrimaryButton, SecondaryButton, GhostButton } from "./ui/Buttons";

interface Citation {
  text: string;
  source: string;
  page: number;
}

interface SolveScenario {
  id: string;
  title: string;
  domain: string;
  domainColor: string;
  summary: string;
  steps: { title: string; content: string }[];
  citations: Citation[];
  validation: { status: "success" | "warning" | "error"; message: string };
  confidence: "High" | "Medium" | "Low";
  processingTime: string;
  budgetState?: "ok" | "warning" | "limit";
  modelState?: "ok" | "unavailable" | "timeout";
}

const SCENARIOS: Record<string, SolveScenario> = {
  math: {
    id: "math",
    title: "微積分求極值問題",
    domain: "數學科學 (Mathematics)",
    domainColor: "orange",
    summary: "求函數 f(x) = x^3 - 3x^2 + 2 在區間 [0, 3] 上的極值與最值。",
    steps: [
      { title: "步驟一：求導函數", content: "計算一階導函數得到 f'(x) = 3x^2 - 6x。" },
      { title: "步驟二：尋找臨界點", content: "令 f'(x) = 0，解得 x = 0 或 x = 2。此二點均在給定區間 [0, 3] 內。" },
      { title: "步驟三：端點與臨界點函數值比較", content: "計算各點函數值：\nf(0) = 2\nf(2) = 2^3 - 3(2)^2 + 2 = -2\nf(3) = 3^3 - 3(3)^2 + 2 = 2。" },
      { title: "步驟四：結論", content: "在區間 [0, 3] 上，極大值為 2 (在 x = 0, 3 處取得)，極小值為 -2 (在 x = 2 處取得)。" }
    ],
    citations: [
      { text: "導數之應用：令 f'(x) = 0 求解之點稱為臨界點，極值必定發生於臨界點或端點處。", source: "微積分基礎教程", page: 42 }
    ],
    validation: { status: "success", message: "公式結構完整，計算無誤。" },
    confidence: "High",
    processingTime: "2.1s"
  },
  prog: {
    id: "prog",
    title: "二元搜尋樹遍歷演算法",
    domain: "資訊科學 (Programming)",
    domainColor: "green",
    summary: "實現二元搜尋樹（BST）的中序遍歷（In-order Traversal），並分析其時間複雜度。",
    steps: [
      { title: "步驟一：遞迴演算法設計", content: "中序遍歷順序為：左子樹 -> 根節點 -> 右子樹。\n\nvoid inorder(Node* root) {\n  if (!root) return;\n  inorder(root->left);\n  print(root->val);\n  inorder(root->right);\n}" },
      { title: "步驟二：時間複雜度分析", content: "因為每個節點恰好被訪問一次，所以時間複雜度為 O(N)，其中 N 為節點總數。" },
      { title: "步驟三：空間複雜度分析", content: "遞迴調用棧的最大深度等於樹的高度。在最壞情況下（樹退化為鏈表），空間複雜度為 O(N)；最好情況（平衡二元樹）下為 O(log N)。" }
    ],
    citations: [
      { text: "二元樹遍歷：中序遍歷 BST 會產生一個嚴格遞增的有序序列。", source: "資料結構與演算法解密", page: 118 }
    ],
    validation: { status: "success", message: "代碼語法與複雜度分析正確。" },
    confidence: "High",
    processingTime: "1.8s"
  },
  humanities: {
    id: "humanities",
    title: "工業革命的社會經濟衝擊",
    domain: "人文歷史 (Humanities)",
    domainColor: "violet",
    summary: "分析 19 世紀英國工業革命對都市化與階級結構造成的關鍵影響。",
    steps: [
      { title: "步驟一：都市化進程加速", content: "圈地運動與工廠體系的崛起驅使大量農村人口湧入城市（如曼徹斯特），導致新興工業城市快速膨脹，但也造成了嚴重的公共衛生與居住擁擠問題。" },
      { title: "步驟二：階級結構重組", content: "傳統的土地貴族影響力相對下降，新興的「工業資產階級」（資本家）與「無產階級」（工廠工人）對立加劇，促成了早期工會运动與社會主義思潮的萌芽。" }
    ],
    citations: [
      { text: "19 世紀社會變遷：工廠制度重新定義了勞動時間與家庭結構，將勞動者轉變為工資雇員。", source: "世界現代史綱要", page: 85 }
    ],
    validation: { status: "success", message: "歷史事件因果關係邏輯清晰。" },
    confidence: "High",
    processingTime: "2.4s"
  },
  cyber: {
    id: "cyber",
    title: "預防 XSS 與 SQL 注入攻擊",
    domain: "資訊安全 (Cybersecurity)",
    domainColor: "rose",
    summary: "如何設計 Web 應用防禦惡意 SQL 語法注入與跨網站指令碼（XSS）攻擊？",
    steps: [
      { title: "步驟一：預防 SQL 注入", content: "使用「參數化查詢 (Parameterized Queries / Prepared Statements)」，嚴禁直接拼接字串拼裝 SQL 指令。" },
      { title: "步驟二：預防 XSS 攻擊", content: "對於所有用戶輸入的 HTML 字元進行轉義（HTML Entity Encoding）。" },
      { title: "步驟三：使用安全標頭", content: "配置 Content Security Policy (CSP)，限制瀏覽器僅執行受信任來源的指令碼。" }
    ],
    citations: [
      { text: "OWASP Top 10：注入防禦的首要規則是將資料與程式碼指令分離。", source: "Web 應用安全指南", page: 201 }
    ],
    validation: { status: "warning", message: "警告：步驟二中，轉義並非萬能防線。對於 DOM-based XSS 仍需注意 JS 輸出上下文的安全過濾。" },
    confidence: "Medium",
    processingTime: "2.9s"
  },
  general: {
    id: "general",
    title: "AI 技術發展對就業市場的衝擊",
    domain: "通識跨領域 (General)",
    domainColor: "blue",
    summary: "探討人工智慧與自動化技術在未來五年內如何塑造白領與藍領的就業生態。",
    steps: [
      { title: "步驟一：日常任務的自動化", content: "生成式 AI 將加快文書、初級寫作、代碼編寫等重複性白領任務的自動化速度。" },
      { title: "步驟二：技能升級需求", content: "市場將更看重人機協同、批判性思考與跨領域問題解決能力，提示詞工程與資料解讀能力成為必備基礎。" }
    ],
    citations: [
      { text: "人機協作趨勢：未來的工作不是被 AI 取代，而是被善用 AI 的人取代。", source: "數位轉型與未來工作", page: 15 }
    ],
    validation: { status: "success", message: "分析架構完整。" },
    confidence: "High",
    processingTime: "1.5s"
  },
  budget_warn: {
    id: "budget_warn",
    title: "預算警告狀態測試",
    domain: "通識領域 (General)",
    domainColor: "blue",
    summary: "預算警告狀態測試問題。",
    steps: [
      { title: "步驟一", content: "系統仍能產生解答，但即將達到每日限額。" }
    ],
    citations: [],
    validation: { status: "success", message: "運作正常" },
    confidence: "High",
    processingTime: "1.2s",
    budgetState: "warning"
  },
  budget_limit: {
    id: "budget_limit",
    title: "額度上限狀態測試",
    domain: "未知 (Unknown)",
    domainColor: "blue",
    summary: "無解答",
    steps: [],
    citations: [],
    validation: { status: "error", message: "已達今日預算上限" },
    confidence: "Low",
    processingTime: "0.1s",
    budgetState: "limit"
  },
  model_err: {
    id: "model_err",
    title: "模型不可用狀態測試",
    domain: "未知 (Unknown)",
    domainColor: "blue",
    summary: "解答失敗",
    steps: [],
    citations: [],
    validation: { status: "error", message: "模型不可用" },
    confidence: "Low",
    processingTime: "0.2s",
    modelState: "unavailable"
  },
  timeout_err: {
    id: "timeout_err",
    title: "連線逾時狀態測試",
    domain: "未知 (Unknown)",
    domainColor: "blue",
    summary: "逾時失敗",
    steps: [],
    citations: [],
    validation: { status: "error", message: "連線逾時" },
    confidence: "Low",
    processingTime: "10.0s",
    modelState: "timeout"
  },
  empty_citation: {
    id: "empty_citation",
    title: "無教材引用結果測試",
    domain: "通識領域 (General)",
    domainColor: "blue",
    summary: "此問題在現有教材中無直接對應章節，AI 基於通用知識庫給予解答。",
    steps: [
      { title: "解答步驟一", content: "直接調用外部通識知識進行解題。" }
    ],
    citations: [],
    validation: { status: "success", message: "解答完成（教材庫中無匹配文獻）" },
    confidence: "Medium",
    processingTime: "1.3s"
  }
};

const STAGES = [
  "正在理解題目",
  "正在判斷學科領域",
  "正在檢索教材",
  "正在建立解題步驟",
  "正在驗證答案",
  "正在整理學生版說明"
];

export function SmartSolvePanel({ bookId: _bookId, prefillText = "", onPrefillHandled }: { bookId: string; prefillText?: string; onPrefillHandled?: () => void }) {
  const [question, setQuestion] = useState("");
  const [selectedScenarioKey, setSelectedScenarioKey] = useState("math");
  const [processing, setProcessing] = useState(false);
  const [currentStageIndex, setCurrentStageIndex] = useState(-1);
  const [result, setResult] = useState<SolveScenario | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const [feedback, setFeedback] = useState<"like" | "dislike" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [alertMsg, setAlertMsg] = useState("");

  // Handle selected text prefill
  useEffect(() => {
    if (prefillText) {
      setQuestion(prefillText);
      if (onPrefillHandled) onPrefillHandled();
    }
  }, [prefillText, onPrefillHandled]);

  function handleQuickScenarioSelect(key: string) {
    setSelectedScenarioKey(key);
    const scen = SCENARIOS[key];
    if (scen) {
      if (key === "math") setQuestion("求函數 f(x) = x^3 - 3x^2 + 2 在區間 [0, 3] 上的極值。");
      else if (key === "prog") setQuestion("如何實現 BST 中序遍歷並分析時間與空間複雜度？");
      else if (key === "humanities") setQuestion("分析 19 世紀英國工業革命對都市化與階級結構的影響。");
      else if (key === "cyber") setQuestion("如何設計 Web 應用防範 SQL Injection 與 XSS 攻擊？");
      else setQuestion(`執行身分測試：${scen.title}`);
    }
  }

  async function handleSolve() {
    if (!question.trim()) return;

    const scenario = SCENARIOS[selectedScenarioKey] || SCENARIOS.math;

    // Reset states
    setProcessing(true);
    setCurrentStageIndex(0);
    setResult(null);
    setExpandedSteps({});
    setFeedback(null);
    setErrorMsg("");
    setAlertMsg("");

    // Simulate multi-stage processing with timeouts
    for (let i = 0; i < STAGES.length; i++) {
      setCurrentStageIndex(i);

      // If scenario has errors at specific stages, trigger them
      if (scenario.modelState === "unavailable" && i === 3) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        setErrorMsg("本次服務目前暫時無法使用。原因：AI 語言模型不可用或伺服器超載。");
        setProcessing(false);
        return;
      }
      if (scenario.modelState === "timeout" && i === 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        setErrorMsg("網路連線逾時，請檢查您的網路狀況後重試。");
        setProcessing(false);
        return;
      }
      if (scenario.budgetState === "limit" && i === 1) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        setErrorMsg("今日使用額度已達上限。請稍後再試或聯絡系統管理者。");
        setProcessing(false);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // Success outcomes
    setProcessing(false);
    setCurrentStageIndex(-1);
    setResult(scenario);

    // Apply warnings or info alerts
    if (scenario.budgetState === "warning") {
      setAlertMsg("本次服務目前暫時無法使用：今日使用餘額即將耗盡。");
    }
  }

  function toggleStep(idx: number) {
    setExpandedSteps((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  function handleReset() {
    setQuestion("");
    setResult(null);
    setErrorMsg("");
    setAlertMsg("");
    setFeedback(null);
  }

  return (
    <div className="smart-solve-panel">
      <div className="smart-solve-hero">
        <span className="solve-sparkle">✨</span>
        <h3>D4a Stateless Smart Solve</h3>
        <p>Gemini-Inspired 原創智能解題系統</p>
      </div>

      {!result && !processing && (
        <div className="solve-input-area">
          <div className="scenario-selector-group">
            <label>選擇測試情境（模擬 Mode）</label>
            <select
              value={selectedScenarioKey}
              onChange={(e) => handleQuickScenarioSelect(e.target.value)}
              className="scenario-select"
            >
              <optgroup label="正常解題情境">
                <option value="math">📐 數學問題 (微積分極值)</option>
                <option value="prog">💻 程式問題 (BST 遍歷)</option>
                <option value="humanities">📜 歷史人文 (工業革命衝擊)</option>
                <option value="general">🌍 通識學科 (AI 就業衝擊)</option>
                <option value="empty_citation">📚 無教材引用 (通識知識)</option>
              </optgroup>
              <optgroup label="異常與限制情境">
                <option value="budget_warn">⚠️ 預算接近限額警告</option>
                <option value="budget_limit">🚫 額度上限已達 (Limit)</option>
                <option value="cyber">🛡️ 驗證警告狀態 (SQLi & XSS)</option>
                <option value="model_err">❌ 語言模型不可用 (503)</option>
                <option value="timeout_err">⏳ 網路連線逾時 (Timeout)</option>
              </optgroup>
            </select>
          </div>

          <div className="question-input-group">
            <label htmlFor="solve-text">請輸入或選取題目內容</label>
            <textarea
              id="solve-text"
              className="solve-textarea"
              placeholder="請輸入欲解析之學科問題，或從左側 PDF 圈選文字後點擊「智慧解題」自動填入..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={5}
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <AIActionButton
              onClick={handleSolve}
              disabled={!question.trim()}
              style={{ width: "100%" }}
            >
              智慧解題
            </AIActionButton>
          </div>
        </div>
      )}

      {/* Processing Animation States */}
      {processing && (
        <div className="solve-processing-card">
          <div className="processing-title">正在進行智能解題分析...</div>
          <div className="processing-stages-list">
            {STAGES.map((stage, idx) => {
              let statusClass = "waiting";
              let statusIcon = "○";
              if (idx < currentStageIndex) {
                statusClass = "done";
                statusIcon = "✓";
              } else if (idx === currentStageIndex) {
                statusClass = "active animate-pulse";
                statusIcon = "●";
              }
              return (
                <div key={stage} className={`processing-stage-item ${statusClass}`}>
                  <span className="stage-icon">{statusIcon}</span>
                  <span className="stage-text">{stage}</span>
                </div>
              );
            })}
          </div>
          <div className="solve-skeleton-loader">
            <div className="skeleton-bar line-1"></div>
            <div className="skeleton-bar line-2"></div>
            <div className="skeleton-bar line-3"></div>
          </div>
        </div>
      )}

      {/* Failures & Errors */}
      {!processing && errorMsg && (
        <div className="solve-error-card">
          <div className="error-card-title">⚠️ 解題中斷</div>
          <p className="error-card-text">{errorMsg}</p>
          <div style={{ marginTop: 14 }}>
            <PrimaryButton onClick={handleReset}>重新輸入題目</PrimaryButton>
          </div>
        </div>
      )}

      {/* Solve Results View */}
      {!processing && result && (
        <div className="solve-result-container">
          {/* Gradient Header */}
          <div className="solve-result-header">
            <div className="header-meta-row">
              <span className={`domain-badge ${result.domainColor}`}>{result.domain}</span>
              <span className="time-badge">⏱️ 耗時 {result.processingTime}</span>
            </div>
            <h2>智慧解題分析完成</h2>
            <div className="confidence-row">
              <span>AI 信心度評估：</span>
              <span className={`confidence-badge ${result.confidence.toLowerCase()}`}>
                {result.confidence === "High" ? "✨ 高 (High)" : result.confidence === "Medium" ? "⚡ 中 (Medium)" : "⚠️ 低 (Low)"}
              </span>
            </div>
          </div>

          {/* Budget Alert (if any) */}
          {alertMsg && (
            <div className="budget-alert-banner">
              <span className="alert-icon">⚠️</span>
              <span className="alert-text">{alertMsg}</span>
            </div>
          )}

          {/* Answer Summary Card */}
          <div className="solve-section-card">
            <h3>📝 題目摘要與解析</h3>
            <p className="answer-summary-text">{result.summary}</p>
          </div>

          {/* Solution Steps (Expandable Accordion) */}
          {result.steps.length > 0 && (
            <div className="solve-section-card">
              <h3>🔍 核心解題步驟</h3>
              <div className="steps-accordion-group">
                {result.steps.map((step, idx) => {
                  const isExpanded = !!expandedSteps[idx];
                  return (
                    <div key={idx} className={`accordion-item ${isExpanded ? "is-expanded" : ""}`}>
                      <button
                        type="button"
                        className="accordion-trigger"
                        onClick={() => toggleStep(idx)}
                        aria-expanded={isExpanded}
                      >
                        <span className="step-num">{idx + 1}</span>
                        <strong>{step.title}</strong>
                        <span className="accordion-chevron">{isExpanded ? "▲" : "▼"}</span>
                      </button>
                      {isExpanded && (
                        <div className="accordion-content">
                          <p>{step.content}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Textbooks & Citations */}
          <div className="solve-section-card">
            <h3>📚 關聯教材引用</h3>
            {result.citations.length === 0 ? (
              <p className="muted" style={{ padding: "8px 0" }}>此題在目前課程教材庫中無匹配文獻段落。</p>
            ) : (
              <div className="citation-list">
                {result.citations.map((cit, idx) => (
                  <div key={idx} className="citation-item">
                    <p className="citation-text">「{cit.text}」</p>
                    <div className="citation-footer">
                      <span className="citation-source">📖 {cit.source}</span>
                      <span className="citation-page">第 {cit.page} 頁</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Answer Validation Status */}
          <div className={`validation-status-card ${result.validation.status}`}>
            <div className="validation-title">
              {result.validation.status === "success" ? "✓ 答案自動驗證成功" : "⚠ 答案驗證提示"}
            </div>
            <p>{result.validation.message}</p>
          </div>

          {/* Feedback & Actions */}
          <div className="solve-footer-controls">
            <div className="feedback-buttons-row">
              <span>這項解答是否有幫助？</span>
              <GhostButton
                onClick={() => setFeedback("like")}
                className={feedback === "like" ? "is-selected-like" : ""}
                title="有幫助"
              >
                👍 有幫助
              </GhostButton>
              <GhostButton
                onClick={() => setFeedback("dislike")}
                className={feedback === "dislike" ? "is-selected-dislike" : ""}
                title="需要改進"
              >
                👎 需要改進
              </GhostButton>
            </div>

            <div className="action-buttons-row" style={{ marginTop: 16, display: "flex", gap: 10 }}>
              <PrimaryButton onClick={handleReset} style={{ flex: 1 }}>
                重新解題
              </PrimaryButton>
              <SecondaryButton
                onClick={() => {
                  alert("問題已回報給助教群進行人工複核。");
                }}
                style={{ flex: 1 }}
              >
                回報問題
              </SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
