import { useCallback, useEffect, useState } from "react";
import {
  AdminGuard,
  AdminHeader,
  AdminOrder,
  AdminUser,
  apiFetch,
  formatDate,
  formatDuration,
  formatVnd,
} from "./adminShared";

export default function AdminUserPage({ userId }: { userId: string }) {
  return (
    <AdminGuard>
      {({ username, logout }) => <UserDetail userId={userId} username={username} logout={logout} />}
    </AdminGuard>
  );
}

type AdminPlanOption = {
  id: string;
  name: string;
  kind: "subscription" | "event";
  monthlySeconds: number;
  durationSeconds: number;
  priceVnd: number;
  active: boolean;
};

function formatPlanSize(plan: AdminPlanOption) {
  const seconds = plan.kind === "subscription" ? plan.monthlySeconds : plan.durationSeconds;
  if (plan.kind === "subscription" && seconds === 0) return "không giới hạn";
  return formatDuration(seconds);
}

function UserDetail({ userId, username, logout }: {
  userId: string;
  username: string | null;
  logout: () => void;
}) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState("");
  const [plans, setPlans] = useState<AdminPlanOption[]>([]);
  const [grantPlanId, setGrantPlanId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [userResponse, ordersResponse] = await Promise.all([
        apiFetch(`/api/admin/users/${userId}`),
        apiFetch(`/api/admin/orders?userId=${encodeURIComponent(userId)}&limit=50`),
      ]);
      if (userResponse.status === 401) {
        window.location.reload();
        return;
      }
      if (userResponse.status === 404) {
        setNotFound(true);
        return;
      }
      if (!userResponse.ok) throw new Error("Không tải được thông tin người dùng.");
      const userBody = await userResponse.json() as { user: AdminUser };
      setUser(userBody.user);
      setQuotaDraft(String(userBody.user.quotaSeconds));
      if (ordersResponse.ok) {
        const ordersBody = await ordersResponse.json() as { orders: AdminOrder[] };
        setOrders(ordersBody.orders);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được dữ liệu.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      const response = await apiFetch("/api/admin/plans");
      if (!response.ok) return;
      const body = await response.json() as { plans: AdminPlanOption[] };
      setPlans(body.plans.filter((plan) => plan.active));
    })();
  }, []);

  const grantPlan = async () => {
    if (!user || !grantPlanId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/admin/users/${user.id}/grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: grantPlanId }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Cấp gói thất bại.");
      setNotice(`Đã cấp gói cho ${user.email}.`);
      setGrantPlanId("");
      await load();
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : "Cấp gói thất bại.");
    } finally {
      setBusy(false);
    }
  };

  const patchUser = async (update: { plan?: string; quotaSeconds?: number; resetUsage?: boolean }) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Cập nhật thất bại.");
      setNotice("Đã lưu thay đổi.");
      await load();
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "Cập nhật thất bại.");
    } finally {
      setBusy(false);
    }
  };

  const saveQuota = () => {
    const value = Number(quotaDraft);
    if (!Number.isFinite(value) || value < 0) {
      setError("Hạn mức phải là số không âm.");
      return;
    }
    void patchUser({ quotaSeconds: Math.floor(value) });
  };

  const percent = user && user.quotaSeconds > 0
    ? Math.min(100, Math.round(user.usedSeconds / user.quotaSeconds * 100))
    : 0;

  return (
    <div className="admin-shell">
      <AdminHeader username={username} onLogout={logout} active="users" />

      <main className="admin-main">
        <nav className="admin-breadcrumb">
          <a href="/admin">← Danh sách người dùng</a>
        </nav>

        {error ? <div className="admin-banner error">{error}<button onClick={() => setError(null)}>×</button></div> : null}
        {notice ? <div className="admin-banner success">{notice}<button onClick={() => setNotice(null)}>×</button></div> : null}

        {notFound ? (
          <section className="admin-card admin-empty-page">
            <h2>Không tìm thấy người dùng</h2>
            <p>ID <code>{userId}</code> không tồn tại hoặc đã bị xóa.</p>
            <a className="admin-primary" href="/admin">Về danh sách</a>
          </section>
        ) : loading && !user ? (
          <p className="admin-gate-lead">Đang tải thông tin người dùng…</p>
        ) : user ? (
          <>
            <section className="admin-card admin-profile">
              <div className="admin-profile-head">
                {user.picture
                  ? <img src={user.picture} alt="" />
                  : <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>}
                <div>
                  <h1>{user.name || "Chưa đặt tên"}</h1>
                  <p>{user.email}</p>
                  <div className="admin-profile-badges">
                    <span className={`admin-badge ${user.plan}`}>{user.plan === "pro" ? "Pro" : "Free"}</span>
                    {user.unlimited ? <span className="admin-badge admin">Không giới hạn</span> : null}
                  </div>
                </div>
              </div>

              <dl className="admin-meta">
                <div><dt>ID</dt><dd><code>{user.id}</code></dd></div>
                <div><dt>Ngày tạo</dt><dd>{formatDate(user.createdAt)}</dd></div>
                <div><dt>Cập nhật lần cuối</dt><dd>{formatDate(user.updatedAt)}</dd></div>
                <div><dt>Đơn hàng</dt><dd>{user.paidOrderCount} đã trả / {user.orderCount} tổng</dd></div>
                <div><dt>Đơn gần nhất</dt><dd>{formatDate(user.lastOrderAt)}</dd></div>
              </dl>
            </section>

            <div className="admin-detail-grid">
              <section className="admin-card admin-detail-card">
                <header className="admin-card-header">
                  <div>
                    <h2>Mức sử dụng</h2>
                    <p>{user.unlimited ? "Không giới hạn" : `Còn ${formatDuration(user.remainingSeconds ?? 0)}`}</p>
                  </div>
                </header>
                <div className="admin-detail-body">
                  <div className="admin-usage big">
                    <div className="admin-usage-bar"><i style={{ width: `${percent}%` }} /></div>
                    <div className="admin-usage-numbers">
                      <span><strong>{formatDuration(user.usedSeconds)}</strong> đã dùng</span>
                      <span><strong>{user.quotaSeconds === 0 ? "∞" : formatDuration(user.quotaSeconds)}</strong> tổng hạn mức</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="admin-ghost-button"
                    onClick={() => void patchUser({ resetUsage: true })}
                    disabled={busy || user.usedSeconds === 0}
                  >
                    Đặt lại thời gian đã dùng
                  </button>
                </div>
              </section>

              <section className="admin-card admin-detail-card">
                <header className="admin-card-header">
                  <div>
                    <h2>Gói và hạn mức</h2>
                    <p>Thay đổi có hiệu lực ngay với người dùng đang đăng nhập</p>
                  </div>
                </header>
                <div className="admin-detail-body">
                  <label className="admin-detail-label">Gói hiện tại</label>
                  <div className="admin-segmented admin-plan-picker">
                    {(plans.filter((plan) => plan.kind === "subscription").length
                      ? plans.filter((plan) => plan.kind === "subscription")
                      : [{ id: "free", name: "Free" }, { id: "pro", name: "Pro" }] as AdminPlanOption[]
                    ).map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        className={user.plan === plan.id ? "active" : ""}
                        onClick={() => void patchUser({ plan: plan.id })}
                        disabled={busy || user.plan === plan.id}
                        title={`Chuyển sang ${plan.name}`}
                      >
                        {plan.name}
                      </button>
                    ))}
                  </div>

                  <label className="admin-detail-label" htmlFor="admin-grant">Cấp gói ngay (không cần thanh toán)</label>
                  <div className="admin-inline-form">
                    <select
                      id="admin-grant"
                      value={grantPlanId}
                      onChange={(event) => setGrantPlanId(event.target.value)}
                    >
                      <option value="">— Chọn gói để cấp —</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} · {formatPlanSize(plan)}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void grantPlan()} disabled={busy || !grantPlanId}>
                      Cấp
                    </button>
                  </div>
                  <p className="admin-editor-hint">
                    Gói thuê bao đặt lại hạn mức tháng; gói một lần cộng thêm thời gian vào hạn mức mua
                    thêm. Dùng khi hỗ trợ khách hoặc bù trừ thanh toán.
                  </p>

                  <label className="admin-detail-label" htmlFor="admin-quota">Tổng hạn mức (giây)</label>
                  <div className="admin-inline-form">
                    <input
                      id="admin-quota"
                      type="number"
                      min={0}
                      value={quotaDraft}
                      onChange={(event) => setQuotaDraft(event.target.value)}
                    />
                    <button type="button" onClick={saveQuota} disabled={busy}>Lưu</button>
                  </div>
                  <p className="admin-editor-hint">
                    Nhập 0 để cấp hạn mức không giới hạn. Đây là tổng hạn mức, không phải phần còn lại.
                  </p>
                </div>
              </section>
            </div>

            <section className="admin-card">
              <header className="admin-card-header">
                <div>
                  <h2>Đơn nâng cấp</h2>
                  <p>{orders.length} đơn của người dùng này</p>
                </div>
              </header>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Mã chuyển khoản</th>
                      <th>Số tiền</th>
                      <th>Trạng thái</th>
                      <th>Tạo lúc</th>
                      <th>Thanh toán lúc</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id}>
                        <td><code>{order.transferCode}</code></td>
                        <td>{formatVnd(order.amountVnd)}</td>
                        <td><span className={`admin-badge order-${order.status}`}>{order.status}</span></td>
                        <td>{formatDate(order.createdAt)}</td>
                        <td>{formatDate(order.paidAt)}</td>
                      </tr>
                    ))}
                    {!orders.length ? <tr><td colSpan={5} className="admin-empty">Người dùng chưa có đơn hàng.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
