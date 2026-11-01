import { FormEvent, useCallback, useEffect, useState } from "react";
import { AdminGuard, AdminHeader, apiFetch, formatDuration, formatVnd } from "./adminShared";

type PlanKind = "subscription" | "event";

type AdminPlan = {
  id: string;
  name: string;
  kind: PlanKind;
  monthlySeconds: number;
  durationSeconds: number;
  priceVnd: number;
  description: string;
  sortOrder: number;
  active: boolean;
  userCount: number;
};

type Draft = {
  id: string;
  name: string;
  kind: PlanKind;
  monthlySeconds: string;
  durationSeconds: string;
  priceVnd: string;
  description: string;
  sortOrder: string;
  active: boolean;
  isNew: boolean;
};

const EMPTY_DRAFT: Draft = {
  id: "",
  name: "",
  kind: "subscription",
  monthlySeconds: "3600",
  durationSeconds: "3600",
  priceVnd: "49000",
  description: "",
  sortOrder: "10",
  active: true,
  isNew: true,
};

function toDraft(plan: AdminPlan): Draft {
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    monthlySeconds: String(plan.monthlySeconds),
    durationSeconds: String(plan.durationSeconds),
    priceVnd: String(plan.priceVnd),
    description: plan.description,
    sortOrder: String(plan.sortOrder),
    active: plan.active,
    isNew: false,
  };
}

function hoursToSeconds(value: string) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 3600) : NaN;
}

export default function AdminPlansPage() {
  return (
    <AdminGuard>
      {({ username, logout }) => <PlansView username={username} logout={logout} />}
    </AdminGuard>
  );
}

function PlansView({ username, logout }: { username: string | null; logout: () => void }) {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch("/api/admin/plans");
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error("Không tải được danh sách gói.");
      const body = await response.json() as { plans: AdminPlan[] };
      setPlans(body.plans);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được danh sách gói.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = {
        name: draft.name,
        kind: draft.kind,
        monthlySeconds: draft.kind === "subscription" ? hoursToSeconds(draft.monthlySeconds) : 0,
        durationSeconds: draft.kind === "event" ? hoursToSeconds(draft.durationSeconds) : 0,
        priceVnd: Number(draft.priceVnd),
        description: draft.description,
        sortOrder: Number(draft.sortOrder) || 0,
        active: draft.active,
      };
      if (!Number.isFinite(payload.monthlySeconds as number) || !Number.isFinite(payload.durationSeconds as number)) {
        throw new Error("Số giờ không hợp lệ.");
      }
      const response = await apiFetch(
        draft.isNew ? `/api/admin/plans/${encodeURIComponent(draft.id)}` : `/api/admin/plans/${encodeURIComponent(draft.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Lưu gói thất bại.");
      setNotice(draft.isNew ? "Đã thêm gói mới." : "Đã cập nhật gói.");
      setDraft(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Lưu gói thất bại.");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (plan: AdminPlan) => {
    setError(null);
    if (!plan.active) {
      // Tắt gói dùng endpoint DELETE; bật lại thì lưu lại với active = true.
      setDraft({ ...toDraft(plan), active: true });
      return;
    }
    if (plan.userCount > 0) {
      setError(`Gói "${plan.name}" đang có ${plan.userCount} người dùng — không thể tắt.`);
      return;
    }
    if (!window.confirm(`Tắt bán gói "${plan.name}"? Người dùng đang dùng gói này không bị ảnh hưởng.`)) return;
    try {
      const response = await apiFetch(`/api/admin/plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Không tắt được gói.");
      setNotice(`Đã tắt bán gói "${plan.name}".`);
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Không tắt được gói.");
    }
  };

  return (
    <div className="admin-shell">
      <AdminHeader username={username} onLogout={logout} active="plans" />

      <main className="admin-main">
        <section className="admin-revenue-head admin-page-head">
          <div>
            <h1>Gói cước</h1>
            <p>Gói thuê bao làm mới hạn mức mỗi tháng; gói sự kiện cộng thêm thời gian một lần.</p>
          </div>
          <button
            type="button"
            className="admin-primary admin-head-action"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            + Thêm gói
          </button>
        </section>

        {error ? <div className="admin-banner error">{error}<button onClick={() => setError(null)}>×</button></div> : null}
        {notice ? <div className="admin-banner success">{notice}<button onClick={() => setNotice(null)}>×</button></div> : null}

        <section className="admin-card">
          <header className="admin-card-header">
            <div>
              <h2>Danh sách gói</h2>
              <p>{plans.length} gói · {plans.filter((plan) => plan.active).length} đang bán</p>
            </div>
          </header>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Tên</th>
                  <th>Loại</th>
                  <th>Hạn mức</th>
                  <th>Giá</th>
                  <th>Người dùng</th>
                  <th>Trạng thái</th>
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td><code>{plan.id}</code></td>
                    <td><strong>{plan.name}</strong></td>
                    <td>
                      <span className={`admin-badge ${plan.kind === "event" ? "admin" : "pro"}`}>
                        {plan.kind === "event" ? "Một lần" : "Hằng tháng"}
                      </span>
                    </td>
                    <td>
                      {plan.kind === "subscription"
                        ? (plan.monthlySeconds === 0 ? "Không giới hạn" : formatDuration(plan.monthlySeconds))
                        : formatDuration(plan.durationSeconds)}
                    </td>
                    <td>{plan.priceVnd === 0 ? "Miễn phí" : formatVnd(plan.priceVnd)}</td>
                    <td>{plan.userCount}</td>
                    <td>
                      <span className={`admin-badge ${plan.active ? "order-paid" : "order-expired"}`}>
                        {plan.active ? "Đang bán" : "Đã tắt"}
                      </span>
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="admin-row-action" onClick={() => setDraft(toDraft(plan))}>
                          Sửa
                        </button>
                        {plan.id !== "free" ? (
                          <button
                            type="button"
                            className="admin-row-action"
                            onClick={() => void toggleActive(plan)}
                            disabled={plan.active && plan.userCount > 0}
                            title={plan.active && plan.userCount > 0 ? "Còn người dùng đang dùng gói này" : undefined}
                          >
                            {plan.active ? "Tắt" : "Bật"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {!plans.length && !loading ? (
                  <tr><td colSpan={8} className="admin-empty">Chưa có gói nào.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {draft ? (
          <section className="admin-card">
            <header className="admin-card-header">
              <div>
                <h2>{draft.isNew ? "Thêm gói mới" : `Sửa gói: ${draft.name}`}</h2>
                <p>Thời lượng nhập theo giờ, lưu theo giây.</p>
              </div>
              <button type="button" onClick={() => setDraft(null)}>Đóng</button>
            </header>
            <form className="admin-detail-body" onSubmit={save}>
              <div className="admin-form-grid">
                <label className="admin-field">
                  <span>Mã gói</span>
                  <input
                    value={draft.id}
                    onChange={(event) => setDraft({ ...draft, id: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                    placeholder="vd: pro_year"
                    disabled={!draft.isNew}
                    required
                  />
                </label>
                <label className="admin-field">
                  <span>Tên hiển thị</span>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="vd: Pro năm"
                    required
                  />
                </label>
                <label className="admin-field">
                  <span>Loại gói</span>
                  <select
                    value={draft.kind}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value as PlanKind })}
                  >
                    <option value="subscription">Thuê bao — làm mới hằng tháng</option>
                    <option value="event">Một lần — cộng thêm thời gian</option>
                  </select>
                </label>
                <label className="admin-field">
                  <span>Giá (VND)</span>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={draft.priceVnd}
                    onChange={(event) => setDraft({ ...draft, priceVnd: event.target.value })}
                    required
                  />
                </label>
                {draft.kind === "subscription" ? (
                  <label className="admin-field">
                    <span>Hạn mức mỗi tháng (giờ)</span>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={draft.monthlySeconds}
                      onChange={(event) => setDraft({ ...draft, monthlySeconds: event.target.value })}
                    />
                    <small className="admin-field-hint">0 = không giới hạn. Mặc định 1 giờ.</small>
                  </label>
                ) : (
                  <label className="admin-field">
                    <span>Thời lượng cộng thêm (giờ)</span>
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={draft.durationSeconds}
                      onChange={(event) => setDraft({ ...draft, durationSeconds: event.target.value })}
                    />
                    <small className="admin-field-hint">Cộng vào hạn mức của người dùng, không hết hạn.</small>
                  </label>
                )}
                <label className="admin-field">
                  <span>Thứ tự hiển thị</span>
                  <input
                    type="number"
                    value={draft.sortOrder}
                    onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })}
                  />
                </label>
              </div>
              <label className="admin-field">
                <span>Mô tả ngắn</span>
                <input
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="Hiện dưới giá trong bảng chọn gói"
                  maxLength={300}
                />
              </label>
              <label className="toggle-row admin-toggle">
                <span>
                  <strong>Đang bán</strong>
                  <small>Tắt để ẩn gói khỏi bảng chọn</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(event) => setDraft({ ...draft, active: event.target.checked })}
                />
              </label>

              <div className="admin-settings-footer">
                <button type="button" className="admin-ghost-button" onClick={() => setDraft(null)}>Hủy</button>
                <button type="submit" className="admin-primary" disabled={saving || !draft.id || !draft.name.trim()}>
                  {saving ? "Đang lưu…" : draft.isNew ? "Thêm gói" : "Lưu thay đổi"}
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </main>
    </div>
  );
}
