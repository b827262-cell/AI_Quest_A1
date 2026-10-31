import { lazy } from "react";
import { RouteLoading } from "./route-loading";
import { AdminPageTitle } from "./page-title";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppearanceProvider } from "./appearance";
import { AdminAuthProvider, RequireAdmin } from "./admin-auth";
import { AdminShell } from "./components/admin/AdminShell";
const AdminDashboardPage = lazy(async () => ({ default: (await import("./pages/AdminDashboardPage")).AdminDashboardPage }));
const AdminAccountsPage = lazy(async () => ({ default: (await import("./pages/AdminAccountsPage")).AdminAccountsPage }));
const AdminLearningHistoryPage = lazy(async () => ({ default: (await import("./pages/AdminLearningHistoryPage")).AdminLearningHistoryPage }));
const AppearanceSettingsPage = lazy(async () => ({ default: (await import("./pages/AppearanceSettingsPage")).AppearanceSettingsPage }));
const SiteConfigPage = lazy(async () => ({ default: (await import("./pages/SiteConfigPage")).SiteConfigPage }));
const AiAnalyticsPage = lazy(async () => ({ default: (await import("./pages/AiAnalyticsPage")).AiAnalyticsPage }));
const AiProvidersPage = lazy(async () => ({ default: (await import("./pages/AiProvidersPage")).AiProvidersPage }));
const AiQuotaCenterPage = lazy(async () => ({ default: (await import("./pages/AiQuotaCenterPage")).AiQuotaCenterPage }));
const AiQualityEvaluationsPage = lazy(async () => ({ default: (await import("./pages/AiQualityEvaluationsPage")).AiQualityEvaluationsPage }));
const ExamSnapshotsPage = lazy(async () => ({ default: (await import("./pages/ExamSnapshotsPage")).ExamSnapshotsPage }));
const BooksPage = lazy(async () => ({ default: (await import("./pages/BooksPage")).BooksPage }));
const NewBookPage = lazy(async () => ({ default: (await import("./pages/NewBookPage")).NewBookPage }));
const BookDetail = lazy(async () => ({ default: (await import("./pages/BookDetail")).BookDetail }));
const ChaptersPage = lazy(async () => ({ default: (await import("./pages/ChaptersPage")).ChaptersPage }));
const QaPage = lazy(async () => ({ default: (await import("./pages/QaPage")).QaPage }));
import { AdminLoginPage } from "./pages/AdminLoginPage";

export function App() {
  return (
    <BrowserRouter>
      <AdminPageTitle />
      <AdminAuthProvider>
        <Routes>
          <Route path="/login" element={<AdminLoginPage />} />
          <Route path="*" element={<ProtectedAdminRoutes />} />
        </Routes>
      </AdminAuthProvider>
    </BrowserRouter>
  );
}

function ProtectedAdminRoutes() {
  const location = useLocation();
  return (
    <RequireAdmin>
      <AppearanceProvider>
        <AdminShell>
          <RouteLoading key={location.pathname}><Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin" element={<AdminDashboardPage />} />
            <Route path="/admin/accounts" element={<AdminAccountsPage />} />
            <Route path="/admin/learning-history" element={<AdminLearningHistoryPage />} />
            <Route path="/admin/appearance" element={<AppearanceSettingsPage />} />
            <Route path="/admin/site-config" element={<SiteConfigPage />} />
            <Route path="/admin/exam-snapshots" element={<ExamSnapshotsPage />} />
            <Route path="/admin/ai-analytics" element={<AiAnalyticsPage />} />
            <Route path="/admin/ai-providers" element={<AiProvidersPage />} />
            <Route path="/admin/ai-quota-center" element={<AiQuotaCenterPage />} />
            <Route path="/admin/ai-quality-evaluations" element={<AiQualityEvaluationsPage />} />
            <Route path="/admin/books" element={<BooksPage />} />
            <Route path="/admin/books/new" element={<NewBookPage />} />
            {/* Dedicated reader-management pages take precedence over the tabbed detail. */}
            <Route path="/admin/books/:bookId/chapters" element={<ChaptersPage />} />
            <Route path="/admin/books/:bookId/qa" element={<QaPage />} />
            <Route path="/admin/books/:bookId/*" element={<BookDetail />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes></RouteLoading>
        </AdminShell>
      </AppearanceProvider>
    </RequireAdmin>
  );
}
