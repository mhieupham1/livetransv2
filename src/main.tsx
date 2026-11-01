import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AdminPage from "./AdminPage";
import AdminPlansPage from "./AdminPlansPage";
import AdminRevenuePage from "./AdminRevenuePage";
import AdminSettingsPage from "./AdminSettingsPage";
import AdminUserPage from "./AdminUserPage";
import "./styles.css";

// Không dùng thư viện router: chỉ có vài mẫu đường dẫn admin, giữ bundle nhỏ.
function Root() {
  const { pathname } = window.location;
  const userDetailMatch = pathname.match(/^\/admin\/users\/([^/]+)\/?$/);
  if (userDetailMatch) return <AdminUserPage userId={decodeURIComponent(userDetailMatch[1])} />;
  if (/^\/admin\/revenue\/?$/.test(pathname)) return <AdminRevenuePage />;
  if (/^\/admin\/plans\/?$/.test(pathname)) return <AdminPlansPage />;
  if (/^\/admin\/settings\/?$/.test(pathname)) return <AdminSettingsPage />;
  if (/^\/admin\/?$/.test(pathname)) return <AdminPage />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
