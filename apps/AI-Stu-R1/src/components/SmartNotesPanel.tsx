import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SmartBookNote, SmartBookNoteType } from "@ai-smartbook/schema";
import { studentClient } from "../studentClient";
import { useConfirm } from "./useConfirm";

const CANVAS_W = 600;
const CANVAS_H = 360;

const TYPE_LABEL: Record<SmartBookNoteType, string> = {
  text: "文字",
  ai_answer: "AI 解答",
  canvas: "手寫"
};

type Point = { x: number; y: number };
interface StrokeDoc {
  v: number;
  w: number;
  h: number;
  strokes: Point[][];
}

/** Parse stored canvas data as stroke JSON. Returns null for legacy/PNG data. */
function parseStrokeDoc(data: string | null): StrokeDoc | null {
  if (!data || data.startsWith("data:")) return null;
  try {
    const d = JSON.parse(data) as Partial<StrokeDoc>;
    if (d && Array.isArray(d.strokes)) {
      return { v: d.v ?? 1, w: d.w ?? CANVAS_W, h: d.h ?? CANVAS_H, strokes: d.strokes };
    }
  } catch {
    /* not stroke JSON */
  }
  return null;
}

function drawStrokes(ctx: CanvasRenderingContext2D, doc: StrokeDoc) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, doc.w, doc.h);
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of doc.strokes) {
    if (stroke.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    if (stroke.length === 1) {
      ctx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1);
    } else {
      for (let i = 1; i < stroke.length; i += 1) ctx.lineTo(stroke[i].x, stroke[i].y);
    }
    ctx.stroke();
  }
}

/** Read-only preview of a stored canvas note (replays strokes; PNG fallback). */
function CanvasNotePreview({
  data,
  width,
  onClick
}: {
  data: string | null;
  width: number;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useMemo(() => parseStrokeDoc(data), [data]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !doc) return;
    canvas.width = doc.w;
    canvas.height = doc.h;
    const ctx = canvas.getContext("2d");
    if (ctx) drawStrokes(ctx, doc);
  }, [doc]);

  if (!doc) {
    if (data && data.startsWith("data:image")) {
      return (
        <img
          className="notes-canvas-thumb"
          src={data}
          alt="手寫筆記"
          style={{ width }}
          onClick={onClick}
        />
      );
    }
    return <p className="muted">（無法顯示此筆記）</p>;
  }
  return (
    <canvas
      ref={ref}
      className="notes-canvas-thumb"
      style={{ width, height: "auto", aspectRatio: `${doc.w} / ${doc.h}` }}
      onClick={onClick}
    />
  );
}

/**
 * Smart Notes MVP panel: typed notes, saved AI answers, and a basic handwriting
 * canvas. The canvas is persisted as compact stroke JSON (not a full PNG base64
 * blob); previews are rendered by replaying the strokes. Notes are scoped to the
 * current book and tagged with the current page / chapter context. Talks only to
 * /api/student/* via studentClient.
 */
export function SmartNotesPanel({
  bookId,
  pageNumber,
  chapterId,
  chapterTitle,
  refreshKey = 0,
  compact = false,
  onCollapse
}: {
  bookId: string;
  pageNumber: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
  refreshKey?: number;
  compact?: boolean;
  onCollapse?: () => void;
}) {
  const [notes, setNotes] = useState<SmartBookNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [canvasDirty, setCanvasDirty] = useState(false);
  const [preview, setPreview] = useState<SmartBookNote | null>(null);
  const confirmAction = useConfirm();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    studentClient
      .listNotes(bookId)
      .then((r) => setNotes(r.notes))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [bookId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Prime the canvas with a white background and clear the stroke buffer.
  const resetCanvas = useCallback(() => {
    strokes.current = [];
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    setCanvasDirty(false);
  }, []);

  useEffect(() => {
    resetCanvas();
  }, [resetCanvas]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * canvas.width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * canvas.height)
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([pointFromEvent(e)]);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const stroke = strokes.current[strokes.current.length - 1];
    if (!ctx || !stroke) return;
    const prev = stroke[stroke.length - 1];
    const p = pointFromEvent(e);
    if (prev && prev.x === p.x && prev.y === p.y) return;
    stroke.push(p);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!canvasDirty) setCanvasDirty(true);
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function noteContext() {
    return { chapterId, pageNumber: pageNumber ?? null };
  }

  function onCreateTextNote() {
    if (!textBody.trim()) return;
    void run(async () => {
      await studentClient.createNote(bookId, {
        type: "text",
        title: textTitle.trim() || undefined,
        content: textBody.trim(),
        ...noteContext()
      });
      setTextTitle("");
      setTextBody("");
      load();
    });
  }

  function onSaveCanvasNote() {
    if (!canvasDirty) return;
    // Persist compact stroke JSON instead of a full PNG base64 image.
    const doc: StrokeDoc = { v: 1, w: CANVAS_W, h: CANVAS_H, strokes: strokes.current };
    void run(async () => {
      await studentClient.createNote(bookId, {
        type: "canvas",
        title: "手寫筆記",
        canvasData: JSON.stringify(doc),
        ...noteContext()
      });
      resetCanvas();
      load();
    });
  }

  async function onDelete(noteId: string) {
    const confirmed = await confirmAction({
      title: "刪除筆記",
      message: "刪除這則筆記？",
      tone: "danger"
    });
    if (!confirmed) return;
    void run(async () => {
      await studentClient.deleteNote(bookId, noteId);
      if (preview?.id === noteId) setPreview(null);
      load();
    });
  }

  function contextLabel(note: SmartBookNote): string {
    const parts: string[] = [];
    if (note.pageNumber != null) parts.push(`p.${note.pageNumber}`);
    if (note.title) parts.push(note.title);
    return parts.join(" · ");
  }

  return (
    <div className={`notes-panel ${compact ? "compact" : ""}`.trim()}>
      {onCollapse ? (
        <div className="notes-panel-head">
          <h4>智能筆記</h4>
          <button type="button" className="notes-btn small" onClick={onCollapse}>
            收合筆記
          </button>
        </div>
      ) : null}

      <div className="notes-compose">
        <div className="notes-context muted">
          目前內容：
          {pageNumber != null ? `PDF 第 ${pageNumber} 頁` : "未指定頁"}
          {chapterTitle ? ` · ${chapterTitle}` : ""}
        </div>

        <section className="notes-card">
          <h4>文字筆記</h4>
          <input
            className="notes-input"
            placeholder="標題（可留空）"
            value={textTitle}
            onChange={(e) => setTextTitle(e.target.value)}
          />
          <textarea
            className="notes-textarea"
            placeholder="輸入筆記內容…"
            value={textBody}
            onChange={(e) => setTextBody(e.target.value)}
          />
          <button
            type="button"
            className="notes-btn primary"
            disabled={busy || !textBody.trim()}
            onClick={onCreateTextNote}
          >
            新增文字筆記
          </button>
        </section>

        <section className="notes-card">
          <h4>手寫筆記</h4>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="notes-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <div className="notes-canvas-actions">
            <button type="button" className="notes-btn" onClick={resetCanvas} disabled={busy}>
              清除
            </button>
            <button
              type="button"
              className="notes-btn primary"
              onClick={onSaveCanvasNote}
              disabled={busy || !canvasDirty}
            >
              儲存手寫筆記
            </button>
          </div>
        </section>
      </div>

      <div className="notes-list">
        <h4>我的筆記（{notes.length}）</h4>
        {error ? <p className="error-text">{error}</p> : null}
        {loading ? (
          <p className="muted">載入中…</p>
        ) : notes.length === 0 ? (
          <p className="muted">尚無筆記。可新增文字、儲存 AI 解答，或手寫一頁。</p>
        ) : (
          <ul className="notes-items">
            {notes.map((note) => (
              <li key={note.id} className="notes-item">
                <div className="notes-item-head">
                  <span className={`notes-type-badge ${note.type}`}>{TYPE_LABEL[note.type]}</span>
                  <span className="muted notes-item-ctx">{contextLabel(note)}</span>
                  <button
                    type="button"
                    className="notes-btn small"
                    onClick={() => void onDelete(note.id)}
                    disabled={busy}
                  >
                    刪除
                  </button>
                </div>
                {note.type === "canvas" ? (
                  <CanvasNotePreview
                    data={note.canvasData}
                    width={compact ? 220 : 280}
                    onClick={() => setPreview(note)}
                  />
                ) : (
                  <p className="notes-item-body">{note.content}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {preview ? (
        <div className="notes-preview-backdrop" onClick={() => setPreview(null)} role="presentation">
          <div className="notes-preview-box" onClick={(e) => e.stopPropagation()}>
            <CanvasNotePreview data={preview.canvasData} width={560} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
