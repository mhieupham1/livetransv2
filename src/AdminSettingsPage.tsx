import { FormEvent, useCallback, useEffect, useState } from "react";
import { AdminGuard, AdminHeader, apiFetch, formatDate, formatVnd } from "./adminShared";

// Vài ngân hàng phổ biến để chọn nhanh; vẫn cho nhập BIN khác nếu cần.
const BANKS: Array<{ bin: string; name: string }> = [
  { bin: "970422", name: "MB Bank" },
  { bin: "970436", name: "Vietcombank" },
  { bin: "970415", name: "VietinBank" },
  { bin: "970418", name: "BIDV" },
  { bin: "970405", name: "Agribank" },
  { bin: "970407", name: "Techcombank" },
  { bin: "970416", name: "ACB" },
  { bin: "970432", name: "VPBank" },
  { bin: "970423", name: "TPBank" },
  { bin: "970441", name: "VIB" },
  { bin: "970443", name: "SHB" },
  { bin: "970448", name: "OCB" },
];

type BillingSettings = {
  bankBin: string;
  bankAccount: string;
  bankAccountName: string;
  upgradeAmountVnd: number;
  configured: boolean;
  hasSepayKey: boolean;
  updatedAt: number | null;
  source: "database" | "environment";
};

export default function AdminSettingsPage() {
  return (
    <AdminGuard>
      {({ username, logout }) => <SettingsView username={username} logout={logout} />}
    </AdminGuard>
  );
}

function SettingsView({ username, logout }: { username: string | null; logout: () => void }) {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [bankBin, setBankBin] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [amount, setAmount] = useState("99000");
  const [sepayKey, setSepayKey] = useState("");
  const [clearSepayKey, setClearSepayKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((billing: BillingSettings) => {
    setSettings(billing);
    setBankBin(billing.bankBin);
    setBankAccount(billing.bankAccount);
    setBankAccountName(billing.bankAccountName);
    setAmount(String(billing.upgradeAmountVnd));
    setSepayKey("");
    setClearSepayKey(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch("/api/admin/settings/billing");
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error("Không tải được cấu hình.");
      const body = await response.json() as { billing: BillingSettings };
      apply(body.billing);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được cấu hình.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = {
        bankBin: bankBin.trim(),
        bankAccount: bankAccount.trim(),
        bankAccountName: bankAccountName.trim(),
        upgradeAmountVnd: Number(amount),
      };
      // Chỉ gửi khóa khi có thay đổi, tránh vô tình xóa mất khóa đang dùng.
      if (clearSepayKey) payload.sepayWebhookApiKey = "";
      else if (sepayKey.trim()) payload.sepayWebhookApiKey = sepayKey.trim();

      const response = await apiFetch("/api/admin/settings/billing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null) as {
        billing?: BillingSettings;
        error?: string;
      } | null;
      if (!response.ok || !body?.billing) throw new Error(body?.error || "Lưu cấu hình thất bại.");
      apply(body.billing);
      setNotice("Đã lưu. Đơn mới tạo từ bây giờ dùng thông tin này — không cần restart.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Lưu cấu hình thất bại.");
    } finally {
      setSaving(false);
    }
  };

  const previewUrl = bankBin && bankAccount
    ? `https://img.vietqr.io/image/${bankBin}-${bankAccount}-compact2.png?${new URLSearchParams({
      amount: String(Number(amount) || 0),
      addInfo: "RELAYPREVIEW",
      accountName: bankAccountName,
    }).toString()}`
    : "";

  return (
    <div className="admin-shell">
      <AdminHeader username={username} onLogout={logout} active="settings" />

      <main className="admin-main">
        <section className="admin-revenue-head">
          <div>
            <h1>Cài đặt thanh toán</h1>
            <p>Thông tin VietQR dùng để tạo mã cho đơn nâng cấp Pro.</p>
          </div>
          {settings ? (
            <span className={`admin-badge ${settings.configured ? "order-paid" : "order-expired"}`}>
              {settings.configured ? "Đã cấu hình" : "Chưa cấu hình"}
            </span>
          ) : null}
        </section>

        {error ? <div className="admin-banner error">{error}<button onClick={() => setError(null)}>×</button></div> : null}
        {notice ? <div className="admin-banner success">{notice}<button onClick={() => setNotice(null)}>×</button></div> : null}

        {loading && !settings ? (
          <p className="admin-gate-lead">Đang tải cấu hình…</p>
        ) : settings ? (
          <div className="admin-settings-grid">
            <form className="admin-card admin-settings-form" onSubmit={submit}>
              <header className="admin-card-header">
                <div>
                  <h2>Tài khoản nhận tiền</h2>
                  <p>
                    {settings.source === "environment"
                      ? "Đang dùng giá trị từ .env — lưu lần đầu sẽ chuyển sang cơ sở dữ liệu."
                      : `Cập nhật lần cuối ${formatDate(settings.updatedAt)}`}
                  </p>
                </div>
              </header>

              <div className="admin-detail-body">
                <label className="admin-field">
                  <span>Ngân hàng</span>
                  <select value={bankBin} onChange={(event) => setBankBin(event.target.value)}>
                    <option value="">— Chọn ngân hàng —</option>
                    {BANKS.map((bank) => (
                      <option key={bank.bin} value={bank.bin}>{bank.name} · {bank.bin}</option>
                    ))}
                    {bankBin && !BANKS.some((bank) => bank.bin === bankBin) ? (
                      <option value={bankBin}>BIN khác · {bankBin}</option>
                    ) : null}
                  </select>
                </label>

                <label className="admin-field">
                  <span>Số tài khoản</span>
                  <input
                    value={bankAccount}
                    onChange={(event) => setBankAccount(event.target.value)}
                    placeholder="0123456789"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                  />
                </label>

                <label className="admin-field">
                  <span>Tên chủ tài khoản</span>
                  <input
                    value={bankAccountName}
                    onChange={(event) => setBankAccountName(event.target.value.toUpperCase())}
                    placeholder="NGUYEN VAN A"
                    autoComplete="off"
                    required
                  />
                  <small className="admin-field-hint">Viết không dấu, đúng như ngân hàng đăng ký.</small>
                </label>

                <label className="admin-field">
                  <span>Giá nâng cấp (VND)</span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    required
                  />
                  <small className="admin-field-hint">Hiện tại: {formatVnd(Number(amount) || 0)}</small>
                </label>

                <label className="admin-field">
                  <span>Sepay webhook API key</span>
                  <input
                    type="password"
                    value={sepayKey}
                    onChange={(event) => { setSepayKey(event.target.value); setClearSepayKey(false); }}
                    placeholder={settings.hasSepayKey ? "Đã cấu hình — để trống nếu không đổi" : "Chưa cấu hình"}
                    autoComplete="new-password"
                    disabled={clearSepayKey}
                  />
                  <small className="admin-field-hint">
                    Khóa chỉ lưu phía server và không bao giờ trả về trình duyệt.
                  </small>
                </label>

                {settings.hasSepayKey ? (
                  <label className="toggle-row admin-toggle">
                    <span>
                      <strong>Xóa khóa Sepay</strong>
                      <small>Dùng khi muốn quay lại giá trị trong .env</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={clearSepayKey}
                      onChange={(event) => { setClearSepayKey(event.target.checked); if (event.target.checked) setSepayKey(""); }}
                    />
                  </label>
                ) : null}
              </div>

              <footer className="admin-settings-footer">
                <button type="button" className="admin-ghost-button" onClick={() => void load()} disabled={saving}>
                  Khôi phục
                </button>
                <button type="submit" className="admin-primary" disabled={saving || !bankBin || !bankAccount.trim() || !bankAccountName.trim()}>
                  {saving ? "Đang lưu…" : "Lưu cấu hình"}
                </button>
              </footer>
            </form>

            <aside className="admin-card admin-settings-preview">
              <header className="admin-card-header">
                <div>
                  <h2>Xem trước mã QR</h2>
                  <p>Nội dung mẫu RELAYPREVIEW</p>
                </div>
              </header>
              <div className="admin-settings-preview-body">
                {previewUrl ? (
                  <>
                    <img src={previewUrl} alt="Mã VietQR xem trước" />
                    <dl>
                      <div><dt>Ngân hàng</dt><dd>{bankBin}</dd></div>
                      <div><dt>Số TK</dt><dd>{bankAccount}</dd></div>
                      <div><dt>Chủ TK</dt><dd>{bankAccountName || "—"}</dd></div>
                      <div><dt>Số tiền</dt><dd>{formatVnd(Number(amount) || 0)}</dd></div>
                    </dl>
                  </>
                ) : (
                  <p className="admin-gate-lead">Chọn ngân hàng và nhập số tài khoản để xem trước.</p>
                )}
              </div>
            </aside>

            <PasswordCard username={username} />
          </div>
        ) : null}
      </main>
    </div>
  );
}

function PasswordCard({ username }: { username: string | null }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit = currentPassword.length > 0 && newPassword.length >= 12 && newPassword === confirmPassword;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Đổi mật khẩu thất bại.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("Đã đổi mật khẩu. Các phiên quản trị khác đã bị đăng xuất.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Đổi mật khẩu thất bại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="admin-card admin-settings-form" onSubmit={submit}>
      <header className="admin-card-header">
        <div>
          <h2>Mật khẩu quản trị</h2>
          <p>Tài khoản: {username || "—"}</p>
        </div>
      </header>

      <div className="admin-detail-body">
        {error ? <div className="admin-banner error">{error}</div> : null}
        {notice ? <div className="admin-banner success">{notice}</div> : null}

        <label className="admin-field">
          <span>Mật khẩu hiện tại</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <label className="admin-field">
          <span>Mật khẩu mới</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
          <small className="admin-field-hint">Tối thiểu 12 ký tự.</small>
        </label>

        <label className="admin-field">
          <span>Nhập lại mật khẩu mới</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
          {confirmPassword && newPassword !== confirmPassword ? (
            <small className="admin-field-hint">Mật khẩu xác nhận không khớp.</small>
          ) : null}
        </label>
      </div>

      <footer className="admin-settings-footer">
        <span />
        <button type="submit" className="admin-primary" disabled={saving || !canSubmit}>
          {saving ? "Đang lưu…" : "Đổi mật khẩu"}
        </button>
      </footer>
    </form>
  );
}
