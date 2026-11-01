import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
  plan: "free" | "pro";
  quotaSeconds: number;
  usedSeconds: number;
  remainingSeconds: number | null;
  unlimited: boolean;
  createdAt: number;
  updatedAt: number;
  orderCount: number;
  paidOrderCount: number;
  lastOrderAt: number | null;
};

export type AdminOrder = {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  amountVnd: number;
  transferCode: string;
  status: "pending" | "paid" | "expired";
  createdAt: number;
  paidAt: number | null;
};

export type AdminStats = {
  users: number;
  proUsers: number;
  newUsers7d: number;
  totalUsedSeconds: number;
  paidOrders: number;
  pendingOrders: number;
  revenueVnd: number;
};

export function formatDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds)) return "Không giới hạn";
  const total = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  // Bỏ đuôi bằng 0 để đọc tự nhiên hơn: "30 ngày" thay vì "30 ngày 0 giờ".
  if (days > 0) return hours ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  if (hours > 0) return minutes ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  return `${minutes} phút`;
}

export function formatMinutes(totalSeconds: number) {
  return `${Math.round(totalSeconds / 60).toLocaleString("vi-VN")} phút`;
}

export function formatDate(value: number | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatVnd(amount: number) {
  return `${amount.toLocaleString("vi-VN")}đ`;
}

export async function apiFetch(input: string, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: "include" });
}

function LoginForm({ configured, error, onSignedIn }: {
  configured: boolean;
  error: string | null;
  onSignedIn: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setLocalError(null);
    try {
      const response = await apiFetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Đăng nhập thất bại.");
      setPassword("");
      onSignedIn();
    } catch (loginError) {
      setLocalError(loginError instanceof Error ? loginError.message : "Đăng nhập thất bại.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-gate">
      <form className="admin-gate-card" onSubmit={submit}>
        <span className="admin-gate-mark">R</span>
        <p className="admin-gate-kicker">Relay Admin</p>
        <h1>Quản trị hệ thống</h1>
        <p className="admin-gate-lead">Đăng nhập bằng tài khoản quản trị được cấu hình trên server.</p>
        {configured ? (
          <>
            <label className="admin-field">
              <span>Tên đăng nhập</span>
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="admin-field">
              <span>Mật khẩu</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit" className="admin-primary" disabled={submitting || !username.trim() || !password}>
              {submitting ? "Đang đăng nhập…" : "Đăng nhập"}
            </button>
          </>
        ) : (
          <p className="admin-error">
            Server chưa có tài khoản quản trị. Chạy <code>npm run seed</code> để tạo tài khoản mặc định.
          </p>
        )}
        {error || localError ? <p className="admin-error">{error || localError}</p> : null}
      </form>
    </div>
  );
}

export type AdminNavKey = "users" | "revenue" | "plans" | "settings";

const NAV_ITEMS: Array<{ key: AdminNavKey; label: string; href: string; match: RegExp; icon: ReactNode }> = [
  {
    key: "users",
    label: "Người dùng",
    href: "/admin",
    match: /^\/admin(\/users\/[^/]+)?\/?$/,
    icon: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.2 19a5.8 5.8 0 0 1 11.6 0" />
        <path d="M16.5 11.2a2.6 2.6 0 0 0 0-5.2M20.8 19a4.6 4.6 0 0 0-3.2-4.4" />
      </>
    ),
  },
  {
    key: "revenue",
    label: "Doanh thu",
    href: "/admin/revenue",
    match: /^\/admin\/revenue\/?$/,
    icon: (
      <>
        <path d="M4 19V5M4 19h16" />
        <path d="M8 15v-3M12 15V8M16 15v-5" />
      </>
    ),
  },
  {
    key: "plans",
    label: "Gói cước",
    href: "/admin/plans",
    match: /^\/admin\/plans\/?$/,
    icon: (
      <>
        <path d="M3 8.5 12 3l9 5.5-9 5.5z" />
        <path d="m3 8.5 9 5.5 9-5.5" />
        <path d="M3 15.5 12 21l9-5.5" />
      </>
    ),
  },
  {
    key: "settings",
    label: "Cài đặt",
    href: "/admin/settings",
    match: /^\/admin\/settings\/?$/,
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
  },
];

function AdminNavIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function AdminHeader({ username, onLogout, active }: {
  username: string | null;
  onLogout: () => void;
  active: AdminNavKey;
}) {
  return (
    <>
      <header className="admin-header">
        <a className="admin-brand" href="/admin">
          <span className="admin-gate-mark">R</span>
          <div>
            <strong>Relay Admin</strong>
            <small>Quản trị hệ thống</small>
          </div>
        </a>
        <div className="admin-header-actions">
          {username ? <span className="admin-username">{username}</span> : null}
          <a className="admin-link" href="/">← Ứng dụng</a>
          <button type="button" onClick={onLogout}>Đăng xuất</button>
        </div>
      </header>

      <nav className="admin-nav" aria-label="Mục quản trị">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.key}
            className={`admin-nav-item ${active === item.key ? "active" : ""}`}
            href={item.href}
            aria-current={active === item.key ? "page" : undefined}
          >
            <AdminNavIcon>{item.icon}</AdminNavIcon>
            <span>{item.label}</span>
          </a>
        ))}
        <div className="admin-nav-footer">
          <a href="/" className="admin-nav-item">
            <AdminNavIcon><path d="m14 6-6 6 6 6" /></AdminNavIcon>
            <span>Về ứng dụng</span>
          </a>
        </div>
      </nav>
    </>
  );
}

type GuardContext = {
  username: string | null;
  logout: () => void;
};

// Bao mọi trang admin: kiểm tra phiên trước khi render, hiện form đăng nhập nếu chưa có.
export function AdminGuard({ children }: { children: (context: GuardContext) => ReactNode }) {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    try {
      const response = await apiFetch("/api/admin/session");
      const body = await response.json() as {
        configured?: boolean;
        authenticated?: boolean;
        username?: string | null;
      };
      setConfigured(Boolean(body.configured));
      setSignedIn(Boolean(body.authenticated));
      setUsername(body.username || null);
    } catch {
      setError("Không kết nối được tới server.");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const logout = useCallback(async () => {
    await apiFetch("/api/admin/logout", { method: "POST" });
    setSignedIn(false);
    setUsername(null);
  }, []);

  if (!ready) {
    return <div className="admin-gate"><p className="admin-gate-lead">Đang mở trang quản trị…</p></div>;
  }

  if (!signedIn) {
    return <LoginForm configured={configured} error={error} onSignedIn={() => void bootstrap()} />;
  }

  return <>{children({ username, logout })}</>;
}
