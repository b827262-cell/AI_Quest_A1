import { lazy } from "react";
import { RouteLoading } from "./route-loading";
import { StudentPageTitle } from "./page-title";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppearanceProvider } from "./appearance";
const BooksPage = lazy(async () => ({ default: (await import("./pages/BooksPage")).BooksPage }));
const BookReaderPage = lazy(async () => ({ default: (await import("./pages/BookReaderPage")).BookReaderPage }));
const AntiGPortalPage = lazy(async () => ({ default: (await import("./pages/AntiGPortalPage")).AntiGPortalPage }));
const InstitutionalFlowPage = lazy(async () => ({ default: (await import("./pages/InstitutionalFlowPage")).InstitutionalFlowPage }));
import { LoginPage } from "./pages/LoginPage";
import { StudentHeader } from "./components/StudentHeader";
import { PublicHomePage } from "./pages/PublicHomePage";
const KnowledgeAiPage = lazy(async () => ({ default: (await import("./pages/KnowledgeAiPage")).KnowledgeAiPage }));
const ProfileCompletionPage = lazy(async () => ({ default: (await import("./pages/ProfileCompletionPage")).ProfileCompletionPage }));
const StudentDashboardPage = lazy(async () => ({ default: (await import("./pages/StudentDashboardPage")).StudentDashboardPage }));
import { RequireStudent, StudentAuthProvider } from "./student-auth";

function StudentChrome() {
  const location = useLocation();
  const isPublicRoute = location.pathname === "/" || location.pathname === "/share-target" || location.pathname === "/guest-answer" || location.pathname === "/knowledge-ai" || location.pathname === "/login" || location.pathname === "/profile-completion";
  return isPublicRoute ? null : <StudentHeader />;
}

/** Legacy /read and /chat routes now resolve to the unified reader. */
function RedirectToReader() {
  const { bookId = "" } = useParams();
  return <Navigate to={`/books/${bookId}`} replace />;
}

/**
 * Route tree without the browser history binding. App() wraps it with
 * BrowserRouter for production; integration tests wrap it with
 * MemoryRouter to assert session-driven redirects through the real router.
 */
export function StudentAppRoutes() {
  const location = useLocation();
  return (
    <StudentAuthProvider>
      <AppearanceProvider>
        <StudentPageTitle />
        <StudentChrome />
        <main className="stu-main">
          <RouteLoading key={location.pathname}><Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<PublicHomePage />} />
              <Route path="/share-target" element={<PublicHomePage />} />
              <Route path="/guest-answer" element={<PublicHomePage />} />
              <Route path="/knowledge-ai" element={<KnowledgeAiPage />} />
              <Route path="/profile-completion" element={<ProfileCompletionPage />} />
              <Route path="/dashboard" element={<RequireStudent><StudentDashboardPage /></RequireStudent>} />
              <Route path="/books" element={<RequireStudent><BooksPage /></RequireStudent>} />
              <Route path="/books/:bookId" element={<RequireStudent><BookReaderPage /></RequireStudent>} />
              <Route path="/books/:bookId/read" element={<RequireStudent><RedirectToReader /></RequireStudent>} />
              <Route path="/books/:bookId/chat" element={<RequireStudent><RedirectToReader /></RequireStudent>} />
              {/* AntiG portal */}
              <Route path="/antiG" element={<AntiGPortalPage />} />
              <Route path="/antiG/institutional-flow" element={<InstitutionalFlowPage />} />
              <Route path="/antiG/report" element={<Navigate to="/antiG/institutional-flow" replace />} />
              <Route path="*" element={<Navigate to="/books" replace />} />
            </Routes></RouteLoading>
          </main>
        </AppearanceProvider>
      </StudentAuthProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <StudentAppRoutes />
    </BrowserRouter>
  );
}
