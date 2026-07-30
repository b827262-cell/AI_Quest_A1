import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppearanceProvider } from "./appearance";
import { BooksPage } from "./pages/BooksPage";
import { BookReaderPage } from "./pages/BookReaderPage";
import { AntiGPortalPage } from "./pages/AntiGPortalPage";
import { InstitutionalFlowPage } from "./pages/InstitutionalFlowPage";
import { LoginPage } from "./pages/LoginPage";
import { StudentHeader } from "./components/StudentHeader";
import { PublicHomePage } from "./pages/PublicHomePage";

function StudentChrome() {
  const location = useLocation();
  const isPublicRoute = location.pathname === "/" || location.pathname === "/guest-answer" || location.pathname === "/login";
  return isPublicRoute ? null : <StudentHeader />;
}

/** Legacy /read and /chat routes now resolve to the unified reader. */
function RedirectToReader() {
  const { bookId = "" } = useParams();
  return <Navigate to={`/books/${bookId}`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <AppearanceProvider>
        <StudentChrome />
        <main className="stu-main">
          <Routes>
            <Route path="/" element={<PublicHomePage />} />
            <Route path="/guest-answer" element={<PublicHomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/books" element={<BooksPage />} />
            <Route path="/books/:bookId" element={<BookReaderPage />} />
            <Route path="/books/:bookId/read" element={<RedirectToReader />} />
            <Route path="/books/:bookId/chat" element={<RedirectToReader />} />
            {/* AntiG portal */}
            <Route path="/antiG" element={<AntiGPortalPage />} />
            <Route path="/antiG/institutional-flow" element={<InstitutionalFlowPage />} />
            <Route path="/antiG/report" element={<Navigate to="/antiG/institutional-flow" replace />} />
            <Route path="*" element={<Navigate to="/books" replace />} />
          </Routes>
        </main>
      </AppearanceProvider>
    </BrowserRouter>
  );
}
