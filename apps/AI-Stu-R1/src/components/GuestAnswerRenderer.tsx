import type { ReactNode } from "react";
import type { GuestAnswerContent, GuestAnswerExample } from "@ai-smartbook/schema";

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "code"; language?: string; code: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export const STRUCTURED_SECTION_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(題意摘要|解題步驟|完整程式碼|範例(?:輸入輸出|驗證)?|複雜度分析?|補充說明)\s*[:：]?\s*$/;

export function removeStructuredSectionHeading(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !STRUCTURED_SECTION_HEADING_PATTERN.test(line.trim()))
    .join("\n")
    .trim();
}

function summaryFallbackFromMarkdown(markdownText: string): string {
  return removeStructuredSectionHeading(markdownText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line))
    .map((line) => line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^(?:[-*+]\s+|\d+[.)、:：]\s+)/, "")
      .replace(/\*\*|__|~~|`/g, "")
      .trim())
    .find(Boolean) ?? "請依題目條件與輸出要求完成解題。";
}

/** Normalize historical structured answers before any answer section renders. */
export function normalizeGuestAnswerContent(content: GuestAnswerContent): GuestAnswerContent {
  const summary = removeStructuredSectionHeading(content.summary) ||
    summaryFallbackFromMarkdown(content.markdownText);
  const steps = content.steps
    .map(removeStructuredSectionHeading)
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 6);

  return { ...content, summary, steps };
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Parse a safe Markdown subset without creating HTML from model text. */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1] || undefined, code: codeLines.join("\n") });
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: "heading", level: Math.min(6, heading[1].length), text: heading[2] });
      index += 1;
      continue;
    }
    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)、:：]\s+(.+)$/);
    if (unordered || ordered) {
      const kind = unordered ? "unordered-list" : "ordered-list";
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = kind === "unordered-list"
          ? current.match(/^\s*[-*+]\s+(.+)$/)
          : current.match(/^\s*\d+[.)、:：]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ kind, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || /^\s*```/.test(current) || /^\s*#{1,6}\s+/.test(current)) break;
      if (paragraph.length > 0 && (current.match(/^\s*[-*+]\s+/) || current.match(/^\s*\d+[.)、:：]\s+/))) break;
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\$\$?[^$]+\$\$?)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (/^`[^`]*`$/.test(token)) return <code key={index}>{token.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(token) || /^__[^_]+__$/.test(token)) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (/^\*[^*]+\*$/.test(token) || /^_[^_]+_$/.test(token)) {
      return <em key={index}>{token.slice(1, -1)}</em>;
    }
    if (/^\$\$?[^$]+\$\$?$/.test(token)) return <span key={index}>{token.replace(/^\$\$?|\$\$?$/g, "")}</span>;
    return <span key={index}>{token}</span>;
  });
}

function renderTextLines(lines: string[]): ReactNode {
  return lines.map((line, index) => (
    <span key={index}>{renderInline(line)}{index < lines.length - 1 ? <br /> : null}</span>
  ));
}

export function MarkdownFallback({ source }: { source: string }) {
  return (
    <div className="guest-answer-markdown">
      {parseMarkdownBlocks(source).map((block, index) => {
        if (block.kind === "heading") {
          const Heading = block.level <= 2 ? "h3" : "h4";
          return <Heading key={index}>{renderInline(block.text)}</Heading>;
        }
        if (block.kind === "code") {
          return (
            <pre key={index} data-language={block.language}>
              <code>{block.code}</code>
            </pre>
          );
        }
        if (block.kind === "unordered-list") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>;
        }
        if (block.kind === "ordered-list") {
          return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>;
        }
        if (block.kind === "table") {
          return (
            <div className="guest-answer-table-wrap" key={index}>
              <table>
                <thead><tr>{block.headers.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={index}>{renderTextLines(block.lines)}</p>;
      })}
    </div>
  );
}

export function AnswerSummary({ summary }: { summary: string }) {
  return <section className="answer-section answer-summary"><h3>題意摘要</h3><p>{renderInline(summary)}</p></section>;
}

export function StepsList({ steps }: { steps: string[] }) {
  return (
    <section className="answer-section answer-steps">
      <h3>解題步驟</h3>
      <ol>{steps.slice(0, 6).map((step, index) => <li key={index}>{renderInline(step)}</li>)}</ol>
    </section>
  );
}

export function CodeBlock({ language, code }: { language?: string; code: string }) {
  return (
    <section className="answer-section answer-code-section">
      <div className="answer-section-heading"><h3>完整程式碼</h3>{language ? <span>{language}</span> : null}</div>
      <pre className="answer-code-block"><code>{code}</code></pre>
    </section>
  );
}

export function ExampleCases({ examples }: { examples: GuestAnswerExample[] }) {
  if (examples.length === 0) return null;
  return (
    <section className="answer-section answer-examples">
      <h3>範例驗證</h3>
      <div className="answer-example-grid">
        {examples.slice(0, 4).map((example, index) => (
          <div className="answer-example-card" key={`${example.input}-${index}`}>
            <div><span>輸入</span><code>{example.input}</code></div>
            <div><span>輸出</span><code>{example.output}</code></div>
            {example.explanation ? <p>{example.explanation}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ExpandableExplanation({ explanation, complexity }: { explanation?: string; complexity?: string }) {
  if (!explanation && !complexity) return null;
  return (
    <details className="answer-section answer-explanation">
      <summary>補充說明</summary>
      {explanation ? <MarkdownFallback source={explanation} /> : null}
      {complexity ? <p className="answer-complexity"><strong>複雜度：</strong>{complexity}</p> : null}
    </details>
  );
}

export function StructuredStudentAnswer({ content }: { content: GuestAnswerContent }) {
  const normalized = normalizeGuestAnswerContent(content);
  return (
    <div className="structured-student-answer">
      <AnswerSummary summary={normalized.summary} />
      <StepsList steps={normalized.steps} />
      {normalized.code ? <CodeBlock language={normalized.codeLanguage} code={normalized.code} /> : null}
      <ExampleCases examples={normalized.examples} />
      <ExpandableExplanation explanation={normalized.explanation} complexity={normalized.complexity} />
    </div>
  );
}

export function StudentAnswerRenderer({ content, fallback }: { content?: GuestAnswerContent; fallback?: string }) {
  return content ? <StructuredStudentAnswer content={content} /> : <MarkdownFallback source={fallback ?? ""} />;
}
