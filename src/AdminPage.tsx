import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AdminGuard,
  AdminHeader,
  AdminStats,
  AdminUser,
  apiFetch,
  formatDate,
  formatDuration,
  formatMinutes,
  formatVnd,
} from "./adminShared";

const PAGE_SIZE = 20;

export default function AdminPage() {
  return (
    <AdminGuard>
      {({ username, logout }) => <UserList username={username} logout={logout} />}
    </AdminGuard>
  );
}

function UserList({ username, logout }: { username: string | null; logout: () => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async (nextOffset: number, nextQuery: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (nextQuery) params.set("search", nextQuery);
      const [usersResponse, statsResponse] = await Promise.all([
        apiFetch(`/api/admin/users?${params.toString()}`),
        apiFetch("/api/admin/stats"),
      ]);
      if (usersResponse.status === 401) {
        window.location.reload();
        return;
      }
      if (!usersResponse.ok) throw new Error("Không tải được danh sách người dùng.");
      const usersBody = await usersResponse.json() as { total: number; users: AdminUser[] };
      setUsers(usersBody.users);
      setTotal(usersBody.total);
      if (statsResponse.ok) {
        const statsBody = await statsResponse.json() as { stats: AdminStats };
        setStats(statsBody.stats);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được dữ liệu.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(offset, query); }, [offset, query, loadUsers]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setQuery(search.trim());
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="admin-shell">
      <AdminHeader username={username} onLogout={logout} active="users" />

      <main className="admin-main">
        {stats ? (
          <section className="admin-stats">
            <article><span>Người dùng</span><strong>{stats.users}</strong></article>
            <article><span>Gói Pro</span><strong>{stats.proUsers}</strong></article>
            <article><span>Mới 7 ngày</span><strong>{stats.newUsers7d}</strong></article>
            <article><span>Doanh thu</span><strong>{formatVnd(stats.revenueVnd)}</strong></article>
            <article><span>Đơn chờ</span><strong>{stats.pendingOrders}</strong></article>
            <article><span>Tổng thời gian dùng</span><strong>{formatMinutes(stats.totalUsedSeconds)}</strong></article>
          </section>
        ) : null}

        {error ? <div className="admin-banner error">{error}<button onClick={() => setError(null)}>×</button></div> : null}

        <section className="admin-card">
          <header className="admin-card-header">
            <div>
              <h2>Người dùng</h2>
              <p>{total.toLocaleString("vi-VN")} tài khoản</p>
            </div>
            <form className="admin-search" onSubmit={submitSearch}>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Tìm email, tên hoặc ID…"
                aria-label="Tìm người dùng"
              />
              <button type="submit">Tìm</button>
            </form>
          </header>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Người dùng</th>
                  <th>Gói</th>
                  <th>Đã dùng</th>
                  <th>Hạn mức</th>
                  <th>Đơn</th>
                  <th>Ngày tạo</th>
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const percent = user.quotaSeconds > 0
                    ? Math.min(100, Math.round(user.usedSeconds / user.quotaSeconds * 100))
                    : 0;
                  return (
                    <tr key={user.id}>
                      <td>
                        <div className="admin-user-cell">
                          {user.picture
                            ? <img src={user.picture} alt="" />
                            : <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>}
                          <div>
                            <strong>{user.name || "Chưa đặt tên"}</strong>
                            <small>{user.email}</small>
                          </div>
                        </div>
                      </td>
                      <td><span className={`admin-badge ${user.plan}`}>{user.plan === "pro" ? "Pro" : "Free"}</span></td>
                      <td>
                        <div className="admin-usage">
                          <div className="admin-usage-bar"><i style={{ width: `${percent}%` }} /></div>
                          <small>{formatDuration(user.usedSeconds)}</small>
                        </div>
                      </td>
                      <td>{user.unlimited ? "Không giới hạn" : formatDuration(user.remainingSeconds ?? 0)}</td>
                      <td>{user.paidOrderCount}/{user.orderCount}</td>
                      <td>{formatDate(user.createdAt)}</td>
                      <td>
                        <a className="admin-row-action" href={`/admin/users/${user.id}`}>Quản lý</a>
                      </td>
                    </tr>
                  );
                })}
                {!users.length && !loading ? (
                  <tr><td colSpan={7} className="admin-empty">Không có người dùng phù hợp.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <footer className="admin-pagination">
            <button type="button" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>
              ← Trước
            </button>
            <span>Trang {page}/{pageCount}</span>
            <button type="button" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>
              Sau →
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}
