import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppearanceProvider } from "./appearance";
import { AdminShell } from "./components/admin/AdminShell";
import { AdminDashboardPage } from "./pages/AdminDashboardPage";
import { AdminAccountsPage } from "./pages/AdminAccountsPage";
import { AppearanceSettingsPage } from "./pages/AppearanceSettingsPage";
import { SiteConfigPage } from "./pages/SiteConfigPage";
import { AiAnalyticsPage } from "./pages/AiAnalyticsPage";
import { AiProvidersPage } from "./pages/AiProvidersPage";
import { AiQuotaCenterPage } from "./pages/AiQuotaCenterPage";
import { AiQualityEvaluationsPage } from "./pages/AiQualityEvaluationsPage";
import { BooksPage } from "./pages/BooksPage";
import { NewBookPage } from "./pages/NewBookPage";
import { BookDetail } from "./pages/BookDetail";
import { ChaptersPage } from "./pages/ChaptersPage";
import { QaPage } from "./pages/QaPage";

export function App() {
  return (
    <BrowserRouter>
      <AppearanceProvider>
        <AdminShell>
          <Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin" element={<AdminDashboardPage />} />
            <Route path="/admin/accounts" element={<AdminAccountsPage />} />
            <Route path="/admin/appearance" element={<AppearanceSettingsPage />} />
            <Route path="/admin/site-config" element={<SiteConfigPage />} />
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
          </Routes>
        </AdminShell>
      </AppearanceProvider>
    </BrowserRouter>
  );
}
