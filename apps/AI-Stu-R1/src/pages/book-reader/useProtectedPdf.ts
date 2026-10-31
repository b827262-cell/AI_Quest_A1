import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { studentClient, type BookDetail } from "../../studentClient";
import { studentSessionKey } from "./layout";

/**
 * Protected PDF state holder. Kept separate from the effects so the page can
 * read `pdfBlob` before the chrome measurement effect while the session/blob
 * effects still run in their original position (after the book/outline ones).
 */
export function useProtectedPdfState() {
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfSessionId, setPdfSessionId] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [watermarkStamp, setWatermarkStamp] = useState("");

  return {
    pdfBlob,
    setPdfBlob,
    pdfSessionId,
    setPdfSessionId,
    pdfLoading,
    setPdfLoading,
    pdfError,
    setPdfError,
    watermarkStamp,
    setWatermarkStamp
  };
}

/**
 * Protected PDF lifecycle: ensure the book session, fetch the protected blob
 * and retry once when a stored session id has expired.
 */
export function useProtectedPdfSession({
  bookId,
  book,
  setPdfBlob,
  setPdfSessionId,
  setPdfLoading,
  setPdfError,
  setWatermarkStamp
}: {
  bookId: string;
  book: BookDetail | null;
  setPdfBlob: Dispatch<SetStateAction<Blob | null>>;
  setPdfSessionId: Dispatch<SetStateAction<string | null>>;
  setPdfLoading: Dispatch<SetStateAction<boolean>>;
  setPdfError: Dispatch<SetStateAction<string>>;
  setWatermarkStamp: Dispatch<SetStateAction<string>>;
}) {
  useEffect(() => {
    setPdfBlob(null);
    setPdfLoading(false);
    setPdfError("");
    setPdfSessionId(null);
    setWatermarkStamp("");
  }, [bookId]);

  useEffect(() => {
    if (!bookId || !book?.pdfFileId) return;

    const pdfFileId = book.pdfFileId;
    let disposed = false;

    async function loadProtectedPdf(savedSessionId?: string | null) {
      const ensured = await studentClient.ensureBookSession(bookId, savedSessionId ?? undefined);
      if (disposed) return;
      localStorage.setItem(studentSessionKey(bookId), ensured.sessionId);
      setPdfSessionId(ensured.sessionId);
      setWatermarkStamp(new Date().toLocaleString());
      const blob = await studentClient.getProtectedPdfBlob(bookId, pdfFileId, ensured.sessionId);
      if (disposed) return;
      setPdfBlob(blob);
    }

    async function run() {
      setPdfLoading(true);
      setPdfError("");
      const savedSessionId = localStorage.getItem(studentSessionKey(bookId));
      try {
        await loadProtectedPdf(savedSessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (savedSessionId && /invalid session/i.test(message)) {
          localStorage.removeItem(studentSessionKey(bookId));
          try {
            await loadProtectedPdf(null);
            return;
          } catch (retryErr) {
            if (!disposed) {
              setPdfError(retryErr instanceof Error ? retryErr.message : String(retryErr));
            }
            return;
          }
        }
        if (!disposed) setPdfError(message);
      } finally {
        if (!disposed) setPdfLoading(false);
      }
    }

    void run();

    return () => {
      disposed = true;
    };
  }, [bookId, book?.pdfFileId]);
}
