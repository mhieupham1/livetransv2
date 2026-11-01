import { useCallback, useEffect, useState } from "react";
import {
  AdminGuard,
  AdminHeader,
  apiFetch,
  formatDate,
  formatVnd,
} from "./adminShared";

type RevenueDay = { date: string; orders: number; amountVnd: number };

type TopBuyer = {
  userId: string;
  email: string;
  name: string;
  orders: number;
  amountVnd: number;
  lastPaidAt: number;
};

type Revenue = {
  allTimeVnd: number;
  windowVnd: number;
  todayVnd: number;
  monthVnd: number;
  paidOrders: number;
  windowOrders: number;
  pendingOrders: number;
  pendingVnd: number;
  averageOrderVnd: number;
  series: RevenueDay[];
  topBuyers: TopBuyer[];
};

const RANGES = [7, 30, 90] as const;
type Range = typeof RANGES[number];

export default function AdminRevenuePage() {
  return (
    <AdminGuard>
      {({ username, logout }) => <RevenueView username={username} logout={logout} />}
    </AdminGuard>
  );
}

function formatDay(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function RevenueView({ username, logout }: { username: string | null; logout: () => void }) {
  const [range, setRange] = useState<Range>(30);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: Range) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/admin/revenue?days=${days}`);
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error("Không tải được dữ liệu doanh thu.");
      const body = await response.json() as { revenue: Revenue };
      setRevenue(body.revenue);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được dữ liệu doanh thu.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  const maxAmount = Math.max(1, ...(revenue?.series.map((day) => day.amountVnd) || [0]));
  const windowLabel = `Tổng thu ${range} ngày`;

  return (
    <div className="admin-shell">
      <AdminHeader username={username} onLogout={logout} active="revenue" />

      <main className="admin-main">
        {error ? <div className="admin-banner error">{error}<button onClick={() => setError(null)}>×</button></div> : null}

        {revenue ? (
          <>
            <section className="admin-revenue-head">
              <div>
                <h1>Doanh thu</h1>
                <p>Cập nhật từ webhook Sepay — chỉ tính đơn đã thanh toán.</p>
              </div>
              <div className="admin-range">
                {RANGES.map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={range === days ? "active" : ""}
                    onClick={() => setRange(days)}
                  >
                    {days} ngày
                  </button>
                ))}
              </div>
            </section>

            <section className="admin-stats">
              <article>
                <span>{windowLabel}</span>
                <strong>{formatVnd(revenue.windowVnd)}</strong>
                <small>{revenue.windowOrders} đơn</small>
              </article>
              <article>
                <span>Hôm nay</span>
                <strong>{formatVnd(revenue.todayVnd)}</strong>
              </article>
              <article>
                <span>Tháng này</span>
                <strong>{formatVnd(revenue.monthVnd)}</strong>
              </article>
              <article>
                <span>Tổng cộng</span>
                <strong>{formatVnd(revenue.allTimeVnd)}</strong>
                <small>{revenue.paidOrders} đơn đã trả</small>
              </article>
              <article>
                <span>Đơn trung bình</span>
                <strong>{formatVnd(revenue.averageOrderVnd)}</strong>
              </article>
              <article>
                <span>Đang chờ</span>
                <strong>{formatVnd(revenue.pendingVnd)}</strong>
                <small>{revenue.pendingOrders} đơn</small>
              </article>
            </section>

            <section className="admin-card">
              <header className="admin-card-header">
                <div>
                  <h2>Doanh thu theo ngày</h2>
                  <p>{range} ngày gần nhất · cao nhất {formatVnd(maxAmount)}</p>
                </div>
                <span className={`admin-loading ${loading ? "on" : ""}`}>Đang tải…</span>
              </header>
              <div className="admin-chart">
                {revenue.series.map((day) => (
                  <div
                    key={day.date}
                    className={`admin-chart-bar ${day.amountVnd ? "has-value" : ""}`}
                    title={`${formatDay(day.date)}: ${formatVnd(day.amountVnd)} (${day.orders} đơn)`}
                  >
                    <div className="admin-chart-track">
                      <i style={{ height: `${Math.max(day.amountVnd ? 4 : 1, Math.round(day.amountVnd / maxAmount * 100))}%` }} />
                    </div>
                    <span>{formatDay(day.date).slice(0, 5)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="admin-card">
              <header className="admin-card-header">
                <div>
                  <h2>Khách hàng chi trả nhiều nhất</h2>
                  <p>Top 5 theo tổng tiền đã thanh toán</p>
                </div>
              </header>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Người dùng</th>
                      <th>Số đơn</th>
                      <th>Tổng chi</th>
                      <th>Lần cuối</th>
                      <th aria-label="Chi tiết" />
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.topBuyers.map((buyer) => (
                      <tr key={buyer.userId}>
                        <td>
                          <div className="admin-user-cell">
                            <span>{(buyer.name || buyer.email).slice(0, 1).toUpperCase()}</span>
                            <div>
                              <strong>{buyer.name || "Chưa đặt tên"}</strong>
                              <small>{buyer.email}</small>
                            </div>
                          </div>
                        </td>
                        <td>{buyer.orders}</td>
                        <td><strong>{formatVnd(buyer.amountVnd)}</strong></td>
                        <td>{formatDate(buyer.lastPaidAt)}</td>
                        <td><a className="admin-row-action" href={`/admin/users/${buyer.userId}`}>Xem</a></td>
                      </tr>
                    ))}
                    {!revenue.topBuyers.length ? (
                      <tr><td colSpan={5} className="admin-empty">Chưa có đơn nào được thanh toán.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <p className="admin-gate-lead">{loading ? "Đang tải doanh thu…" : "Chưa có dữ liệu."}</p>
        )}
      </main>
    </div>
  );
}
