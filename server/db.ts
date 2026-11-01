import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export type UserPlan = string;
export type PlanKind = "subscription" | "event";

export type UserRow = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  plan: UserPlan;
  quota_seconds: number;
  used_seconds: number;
  // Hạn mức mua thêm (gói sự kiện, mua lẻ phút). Không bị reset theo tháng.
  bonus_seconds: number;
  // Đầu kỳ hạn mức hiện tại; dùng để biết khi nào cần reset tháng.
  period_start: number;
  // Tăng lên mỗi khi đăng xuất: token cũ mang số này sẽ bị từ chối (thu hồi phiên).
  session_version: number;
  created_at: number;
  updated_at: number;
};

export type PlanRow = {
  id: string;
  name: string;
  kind: PlanKind;
  // Số giây được cấp mỗi tháng với gói thuê bao. 0 = không giới hạn.
  monthly_seconds: number;
  // Số giây cộng thêmmột lần với gói sự kiện.
  duration_seconds: number;
  price_vnd: number;
  description: string;
  sort_order: number;
  active: number;
  created_at: number;
  updated_at: number;
};

export type OrderStatus = "pending" | "paid" | "expired";

export type OrderRow = {
  id: string;
  user_id: string;
  amount_vnd: number;
  transfer_code: string;
  status: OrderStatus;
  created_at: number;
  paid_at: number | null;
  plan_id: string | null;
  grant_seconds: number | null;
  kind: string;
};

const dataDir = resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(resolve(dataDir, "app.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT 'free',
    quota_seconds INTEGER NOT NULL,
    used_seconds INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_vnd INTEGER NOT NULL,
    transfer_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_transfer ON orders(transfer_code);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- Sổ giao dịch: mỗi lần nhận tiền là một dòng, kể cả khi không khớp đơn.
  -- provider_txn_id UNIQUE chặn webhook bị gửi lại và nâng cấp hai lần.
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'sepay',
    provider_txn_id TEXT NOT NULL UNIQUE,
    order_id TEXT REFERENCES orders(id),
    user_id TEXT REFERENCES users(id),
    received_vnd INTEGER NOT NULL,
    transfer_code TEXT,
    matched INTEGER NOT NULL DEFAULT 0,
    raw_payload TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);

  -- Danh mục gói bán được, quản lý từ trang admin.
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'subscription',
    monthly_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    price_vnd INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Nâng cấp schema cũ tại chỗ: chỉ thêm cột, không tạo lại bảng nên dữ liệu được giữ nguyên.
function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("users", "bonus_seconds", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "period_start", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "session_version", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("orders", "plan_id", "TEXT");
addColumnIfMissing("orders", "grant_seconds", "INTEGER");
addColumnIfMissing("orders", "kind", "TEXT NOT NULL DEFAULT 'subscription'");

// Người dùng cũ chưa có period_start: bắt đầu kỳ từ thời điểm nâng cấp.
db.prepare("UPDATE users SET period_start = ? WHERE period_start = 0").run(startOfPeriod(Date.now()));

seedDefaultPlans();

export type AdminAccountRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
};

// Cấu hình vận hành (VietQR, Sepay...) lưu trong DB để đổi qua trang admin mà không cần restart.
export function getSetting(key: string) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function getSettingUpdatedAt(key: string) {
  const row = db.prepare("SELECT updated_at FROM settings WHERE key = ?").get(key) as { updated_at: number } | undefined;
  return row?.updated_at ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function deleteSetting(key: string) {
  return db.prepare("DELETE FROM settings WHERE key = ?").run(key).changes;
}

export function getAdminAccountByUsername(username: string) {
  return db.prepare(
    "SELECT * FROM admin_accounts WHERE username = ? COLLATE NOCASE",
  ).get(username.trim()) as AdminAccountRow | undefined;
}

export function listAdminAccounts() {
  return db.prepare("SELECT * FROM admin_accounts ORDER BY created_at ASC").all() as AdminAccountRow[];
}

export function countAdminAccounts() {
  return (db.prepare("SELECT COUNT(*) AS count FROM admin_accounts").get() as { count: number }).count;
}

export function createAdminAccount(input: { username: string; passwordHash: string }) {
  const id = makeId("adm_");
  const now = Date.now();
  db.prepare(`
    INSERT INTO admin_accounts (id, username, password_hash, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(id, input.username.trim(), input.passwordHash, now, now);
  return db.prepare("SELECT * FROM admin_accounts WHERE id = ?").get(id) as AdminAccountRow;
}

export function updateAdminPassword(username: string, passwordHash: string) {
  db.prepare(`
    UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE username = ? COLLATE NOCASE
  `).run(passwordHash, Date.now(), username.trim());
  return getAdminAccountByUsername(username);
}

export function deleteAdminAccount(username: string) {
  return db.prepare("DELETE FROM admin_accounts WHERE username = ? COLLATE NOCASE").run(username.trim()).changes;
}

export function touchAdminLogin(username: string) {
  db.prepare(`
    UPDATE admin_accounts SET last_login_at = ? WHERE username = ? COLLATE NOCASE
  `).run(Date.now(), username.trim());
}

export function publicAdminAccount(account: AdminAccountRow) {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
    lastLoginAt: account.last_login_at,
  };
}


export function freeQuotaSeconds() {
  const value = Number(process.env.FREE_QUOTA_SECONDS || 1_800);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1_800;
}

export function proQuotaSeconds() {
  const value = Number(process.env.PRO_QUOTA_SECONDS || 2_592_000);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2_592_000;
}

// Kỳ hạn mức bắt đầu từ 00:00 ngày 1 hằng tháng theo giờ máy chủ.
export function startOfPeriod(at: number) {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function nextPeriodStart(at: number) {
  const date = new Date(startOfPeriod(at));
  date.setMonth(date.getMonth() + 1);
  return date.getTime();
}

function defaultPlans() {
  const now = Date.now();
  return [
    {
      id: "free",
      name: "Free",
      kind: "subscription" as const,
      monthlySeconds: freeQuotaSeconds(),
      durationSeconds: 0,
      priceVnd: 0,
      description: "Dùng thử hằng tháng",
      sortOrder: 0,
    },
    {
      id: "pro",
      name: "Pro",
      kind: "subscription" as const,
      monthlySeconds: proQuotaSeconds(),
      durationSeconds: 0,
      priceVnd: Number(process.env.UPGRADE_AMOUNT_VND || 99_000),
      description: "Hạn mức lớn, tự làm mới mỗi tháng",
      sortOrder: 1,
    },
    {
      id: "event",
      name: "Sự kiện",
      kind: "event" as const,
      monthlySeconds: 0,
      durationSeconds: 3 * 3_600,
      priceVnd: 49_000,
      description: "Cộng 3 giờ dùng một lần, không hết hạn theo tháng",
      sortOrder: 2,
    },
    {
      id: "topup_1h",
      name: "Thêm 1 giờ",
      kind: "event" as const,
      monthlySeconds: 0,
      durationSeconds: 3_600,
      priceVnd: 19_000,
      description: "Mua thêm ngay khi đang họp",
      sortOrder: 3,
    },
  ].map((plan) => ({ ...plan, active: 1, now }));
}

// Chỉ chèn khi bảng plans còn trống, để admin sửa giá không bị ghi đè lúc khởi động.
function seedDefaultPlans() {
  const count = (db.prepare("SELECT COUNT(*) AS count FROM plans").get() as { count: number }).count;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO plans (
      id, name, kind, monthly_seconds, duration_seconds, price_vnd,
      description, sort_order, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const plan of defaultPlans()) {
    insert.run(
      plan.id, plan.name, plan.kind, plan.monthlySeconds, plan.durationSeconds,
      plan.priceVnd, plan.description, plan.sortOrder, plan.active, plan.now, plan.now,
    );
  }
}

export function listPlans(options: { includeInactive?: boolean } = {}) {
  const where = options.includeInactive ? "" : "WHERE active = 1";
  return db.prepare(`
    SELECT * FROM plans ${where} ORDER BY sort_order ASC, price_vnd ASC
  `).all() as PlanRow[];
}

export function getPlanById(id: string) {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
}

export function planMonthlySeconds(planId: string) {
  const plan = getPlanById(planId);
  if (!plan) return freeQuotaSeconds();
  return plan.kind === "subscription" ? plan.monthly_seconds : 0;
}

export type PlanInput = {
  id: string;
  name: string;
  kind: PlanKind;
  monthlySeconds: number;
  durationSeconds: number;
  priceVnd: number;
  description: string;
  sortOrder: number;
  active: boolean;
};

export function upsertPlan(input: PlanInput) {
  if (!/^[a-z0-9_]{2,32}$/.test(input.id)) throw new Error("Mã gói chỉ gồm chữ thường, số và dấu gạch dưới.");
  if (!input.name.trim()) throw new Error("Tên gói không được để trống.");
  if (input.kind !== "subscription" && input.kind !== "event") throw new Error("Loại gói không hợp lệ.");
  if (!Number.isFinite(input.priceVnd) || input.priceVnd < 0) throw new Error("Giá gói không hợp lệ.");
  if (input.kind === "subscription" && (!Number.isFinite(input.monthlySeconds) || input.monthlySeconds < 0)) {
    throw new Error("Hạn mức tháng không hợp lệ.");
  }
  if (input.kind === "event" && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) {
    throw new Error("Thời lượng gói sự kiện phải lớn hơn 0.");
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO plans (
      id, name, kind, monthly_seconds, duration_seconds, price_vnd,
      description, sort_order, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      monthly_seconds = excluded.monthly_seconds,
      duration_seconds = excluded.duration_seconds,
      price_vnd = excluded.price_vnd,
      description = excluded.description,
      sort_order = excluded.sort_order,
      active = excluded.active,
      updated_at = excluded.updated_at
  `).run(
    input.id, input.name.trim(), input.kind,
    Math.max(0, Math.floor(input.monthlySeconds)),
    Math.max(0, Math.floor(input.durationSeconds)),
    Math.max(0, Math.round(input.priceVnd)),
    input.description.trim().slice(0, 300),
    Math.floor(input.sortOrder) || 0,
    input.active ? 1 : 0,
    now, now,
  );
  return getPlanById(input.id)!;
}

// Không cho xoá gói đang được người dùng sử dụng; chỉ tắt bán.
export function deactivatePlan(id: string) {
  if (id === "free") throw new Error("Không thể tắt gói Free.");
  db.prepare("UPDATE plans SET active = 0, updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function countUsersOnPlan(id: string) {
  return (db.prepare("SELECT COUNT(*) AS count FROM users WHERE plan = ?").get(id) as { count: number }).count;
}

export function makeId(prefix = "") {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export function getUserById(id: string) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

// Đăng xuất phải thu hồi token đã phát: chỉ xoá cookie ở client là không đủ,
// kẻ đã đánh cắp cookie vẫn dùng được tới khi JWT hết hạn (30 ngày).
export function revokeUserSessions(userId: string) {
  db.prepare("UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id = ?")
    .run(Date.now(), userId);
}

export function getUserByGoogleSub(googleSub: string) {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").get(googleSub) as UserRow | undefined;
}

export function upsertGoogleUser(input: {
  googleSub: string;
  email: string;
  name: string;
  picture: string;
}) {
  const existing = getUserByGoogleSub(input.googleSub);
  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE users
      SET email = ?, name = ?, picture = ?, updated_at = ?
      WHERE id = ?
    `).run(input.email, input.name, input.picture, now, existing.id);
    return getUserById(existing.id)!;
  }

  const id = makeId("usr_");
  db.prepare(`
    INSERT INTO users (
      id, google_sub, email, name, picture, plan, quota_seconds, used_seconds,
      bonus_seconds, period_start, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'free', ?, 0, 0, ?, ?, ?)
  `).run(
    id,
    input.googleSub,
    input.email,
    input.name,
    input.picture,
    planMonthlySeconds("free"),
    startOfPeriod(now),
    now,
    now,
  );
  return getUserById(id)!;
}

export type AdminUserRow = UserRow & {
  order_count: number;
  paid_order_count: number;
  last_order_at: number | null;
};

export function countUsers() {
  return (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
}

export function listUsersForAdmin(options: { search?: string; limit: number; offset: number }) {
  const search = (options.search || "").trim();
  const where = search ? "WHERE email LIKE ? OR name LIKE ? OR id LIKE ?" : "";
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_order_count,
      (SELECT MAX(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
    FROM users u
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit, options.offset) as AdminUserRow[];
  return { total, rows };
}

export function getAdminUserById(id: string) {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_order_count,
      (SELECT MAX(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
    FROM users u
    WHERE u.id = ?
  `).get(id) as AdminUserRow | undefined;
}

export function adminStats() {
  const users = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END) AS pro,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_last_7d
    FROM users
  `).get(Date.now() - 7 * 24 * 60 * 60 * 1_000) as { total: number; pro: number; new_last_7d: number };
  const usage = db.prepare("SELECT COALESCE(SUM(used_seconds), 0) AS used FROM users").get() as { used: number };
  const orders = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_vnd ELSE 0 END), 0) AS revenue
    FROM orders
  `).get() as { paid: number | null; pending: number | null; revenue: number };
  return {
    users: users.total || 0,
    proUsers: users.pro || 0,
    newUsers7d: users.new_last_7d || 0,
    totalUsedSeconds: usage.used || 0,
    paidOrders: orders.paid || 0,
    pendingOrders: orders.pending || 0,
    revenueVnd: orders.revenue || 0,
  };
}

// Doanh thu lấy theo paid_at để xếp đúng ngày tiền vào, không phải ngày tạo đơn.
export function adminRevenueSummary(days = 30) {
  const now = Date.now();
  const todayStart = startOfDay(now);
  // Cửa sổ bắt đầu từ 00:00 của ngày đầu tiên để tổng tiền khớp đúng tổng các cột trên biểu đồ.
  const windowStart = startOfDay(todayStart - (days - 1) * 24 * 60 * 60 * 1_000);
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_vnd ELSE 0 END), 0) AS all_time,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN amount_vnd ELSE 0 END), 0) AS window_revenue,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN amount_vnd ELSE 0 END), 0) AS today_revenue,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN amount_vnd ELSE 0 END), 0) AS month_revenue,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN 1 ELSE 0 END) AS window_orders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_orders,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_vnd ELSE 0 END), 0) AS pending_amount
    FROM orders
  `).get(windowStart, todayStart, monthStart, windowStart) as {
    all_time: number;
    window_revenue: number;
    today_revenue: number;
    month_revenue: number;
    paid_orders: number | null;
    window_orders: number | null;
    pending_orders: number | null;
    pending_amount: number;
  };

  const daily = db.prepare(`
    SELECT
      paid_at AS paidAt,
      COUNT(*) AS orders,
      SUM(amount_vnd) AS amountVnd
    FROM orders
    WHERE status = 'paid' AND paid_at >= ?
    GROUP BY strftime('%Y-%m-%d', paid_at / 1000, 'unixepoch', 'localtime')
    ORDER BY paidAt ASC
  `).all(windowStart) as Array<{ paidAt: number; orders: number; amountVnd: number }>;

  // Gom theo ngày ở đây để biểu đồ có đủ ngày trống, không chỉ ngày có đơn.
  const byDay = new Map<string, { orders: number; amountVnd: number }>();
  for (const row of daily) {
    const key = dayKey(row.paidAt);
    const current = byDay.get(key) || { orders: 0, amountVnd: 0 };
    byDay.set(key, {
      orders: current.orders + row.orders,
      amountVnd: current.amountVnd + row.amountVnd,
    });
  }
  const series: Array<{ date: string; orders: number; amountVnd: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = dayKey(todayStart - index * 24 * 60 * 60 * 1_000);
    const entry = byDay.get(date) || { orders: 0, amountVnd: 0 };
    series.push({ date, ...entry });
  }

  const buyers = db.prepare(`
    SELECT
      u.id AS userId,
      u.email AS email,
      u.name AS name,
      COUNT(o.id) AS orders,
      SUM(o.amount_vnd) AS amountVnd,
      MAX(o.paid_at) AS lastPaidAt
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status = 'paid'
    GROUP BY u.id
    ORDER BY amountVnd DESC
    LIMIT 5
  `).all() as Array<{
    userId: string;
    email: string;
    name: string;
    orders: number;
    amountVnd: number;
    lastPaidAt: number;
  }>;

  return {
    allTimeVnd: totals.all_time,
    windowVnd: totals.window_revenue,
    todayVnd: totals.today_revenue,
    monthVnd: totals.month_revenue,
    paidOrders: totals.paid_orders || 0,
    windowOrders: totals.window_orders || 0,
    pendingOrders: totals.pending_orders || 0,
    pendingVnd: totals.pending_amount || 0,
    averageOrderVnd: totals.paid_orders ? Math.round(totals.all_time / totals.paid_orders) : 0,
    series,
    topBuyers: buyers,
  };
}

function startOfDay(value: number) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function publicAdminUser(user: AdminUserRow) {
  return {
    ...publicUser(user),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    orderCount: user.order_count,
    paidOrderCount: user.paid_order_count,
    lastOrderAt: user.last_order_at,
  };
}

// Chỉ nhận đúng các cột do trang admin được phép sửa, tránh ghi đè google_sub hoặc email.
export function updateUserByAdmin(userId: string, input: {
  plan?: UserPlan;
  quotaSeconds?: number;
  resetUsage?: boolean;
}) {
  const user = getUserById(userId);
  if (!user) return undefined;
  const plan = input.plan ?? user.plan;
  const targetPlan = getPlanById(plan);
  if (!targetPlan) throw new Error("Gói không tồn tại.");
  // Gói một lần không phải là "gói đang dùng" — phải cấp qua grantPlanToUser
  // để cộng vào bonus_seconds, tránh biến người dùng thành không giới hạn.
  if (input.plan && input.plan !== user.plan && targetPlan.kind === "event") {
    throw new Error("Gói một lần phải cấp qua mục \"Cấp gói ngay\", không đặt làm gói chính.");
  }

  // Đổi sang gói khác thì hạn mức lấy theo gói đó, tránh cảnh hạ về Free mà vẫn còn 30 ngày.
  const planChanged = plan !== user.plan;
  const planDefault = planMonthlySeconds(plan);
  const quotaSeconds = input.quotaSeconds
    ?? (planChanged ? planDefault : user.quota_seconds);
  const usedSeconds = input.resetUsage || planChanged ? 0 : user.used_seconds;
  if (!Number.isFinite(quotaSeconds) || quotaSeconds < 0) throw new Error("Hạn mức không hợp lệ.");

  db.prepare(`
    UPDATE users
    SET plan = ?, quota_seconds = ?, used_seconds = ?, period_start = ?, updated_at = ?
    WHERE id = ?
  `).run(
    plan,
    Math.floor(quotaSeconds),
    Math.floor(usedSeconds),
    planChanged ? startOfPeriod(Date.now()) : user.period_start,
    Date.now(),
    userId,
  );
  return getUserById(userId);
}

export function listOrdersForAdmin(options: { userId?: string; limit: number; offset: number }) {
  const where = options.userId ? "WHERE o.user_id = ?" : "";
  const params = options.userId ? [options.userId] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM orders o ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`
    SELECT o.*, u.email AS user_email, u.name AS user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit, options.offset) as Array<OrderRow & {
    user_email: string | null;
    user_name: string | null;
  }>;
  return { total, rows };
}

export function remainingSeconds(user: UserRow) {
  // quota_seconds = 0 nghĩa là không giới hạn (gói admin cấp tay hoặc gói đặc biệt).
  if (user.quota_seconds === 0) return Number.POSITIVE_INFINITY;
  const monthly = Math.max(0, user.quota_seconds - user.used_seconds);
  return monthly + Math.max(0, user.bonus_seconds || 0);
}

export function hasQuota(user: UserRow) {
  return remainingSeconds(user) > 0;
}

// Trả về user sau khi đã áp dụng kỳ mới nếu đã sang tháng.
// Gói sự kiện (bonus_seconds) không bị reset.
const resetPeriodTx = db.transaction((userId: string, planId: string, periodStart: number) => {
  const plan = getPlanById(planId);
  const monthly = plan?.kind === "subscription" ? plan.monthly_seconds : planMonthlySeconds("free");
  db.prepare(`
    UPDATE users
    SET quota_seconds = ?, used_seconds = 0, period_start = ?, updated_at = ?
    WHERE id = ?
  `).run(monthly, periodStart, Date.now(), userId);
});

export function ensureCurrentPeriod(user: UserRow) {
  const currentPeriod = startOfPeriod(Date.now());
  if (user.period_start >= currentPeriod) return user;
  resetPeriodTx(user.id, user.plan, currentPeriod);
  return getUserById(user.id) ?? user;
}

// Trừ hạn mức TRƯỚC khi gọi dịch vụ tốn tiền, bằng một câu UPDATE có điều kiện.
// Nhờ vậy nhiều request song song không thể cùng vượt qua bước kiểm tra rồi cùng gọi LLM.
// Trả về false khi không đủ hạn mức để trừ.
export function tryConsumeSeconds(userId: string, seconds: number) {
  const amount = Math.max(0, Math.floor(seconds));
  if (!amount) return true;
  const user = getUserById(userId);
  if (!user) return false;
  const current = ensureCurrentPeriod(user);
  // Gói không giới hạn: vẫn ghi nhận để thống kê (giống addUsedSeconds), không chặn.
  if (current.quota_seconds === 0) {
    db.prepare("UPDATE users SET used_seconds = used_seconds + ?, updated_at = ? WHERE id = ?")
      .run(amount, Date.now(), userId);
    return true;
  }

  const monthlyLeft = Math.max(0, current.quota_seconds - current.used_seconds);
  const fromMonthly = Math.min(monthlyLeft, amount);
  const fromBonus = amount - fromMonthly;
  const result = db.prepare(`
    UPDATE users
    SET used_seconds = used_seconds + ?, bonus_seconds = bonus_seconds - ?, updated_at = ?
    WHERE id = ? AND bonus_seconds >= ?
  `).run(fromMonthly, fromBonus, Date.now(), userId, fromBonus);
  return result.changes > 0;
}

// Hoàn lại phần đã trừ khi lời gọi dịch vụ thất bại.
export function refundSeconds(userId: string, seconds: number) {
  const amount = Math.max(0, Math.floor(seconds));
  if (!amount) return;
  db.prepare(`
    UPDATE users
    SET used_seconds = MAX(0, used_seconds - ?), updated_at = ?
    WHERE id = ?
  `).run(amount, Date.now(), userId);
}

export function addUsedSeconds(userId: string, seconds: number) {
  const amount = Math.max(0, Math.floor(seconds));
  if (!amount) return getUserById(userId);
  const user = getUserById(userId);
  if (!user) return undefined;
  const current = ensureCurrentPeriod(user);

  // Gói không giới hạn: vẫn ghi nhận để thống kê, không đụng hạn mức mua thêm.
  if (current.quota_seconds === 0) {
    db.prepare("UPDATE users SET used_seconds = used_seconds + ?, updated_at = ? WHERE id = ?")
      .run(amount, Date.now(), userId);
    return getUserById(userId);
  }

  // Tiêu hạn mức tháng trước, phần dư mới trừ vào hạn mức mua thêm.
  const monthlyLeft = Math.max(0, current.quota_seconds - current.used_seconds);
  const fromMonthly = Math.min(monthlyLeft, amount);
  const fromBonus = amount - fromMonthly;
  db.prepare(`
    UPDATE users
    SET used_seconds = used_seconds + ?, bonus_seconds = MAX(0, bonus_seconds - ?), updated_at = ?
    WHERE id = ?
  `).run(fromMonthly, fromBonus, Date.now(), userId);
  return getUserById(userId);
}

export type PaymentRow = {
  id: string;
  provider: string;
  provider_txn_id: string;
  order_id: string | null;
  user_id: string | null;
  received_vnd: number;
  transfer_code: string | null;
  matched: number;
  raw_payload: string;
  created_at: number;
};

// Ghi nhận mọi lần nhận tiền. Trả về null khi giao dịch đã được xử lý trước đó,
// nhờ vậy webhook gửi lặp lại không nâng cấp thêm lần nữa.
export function recordPayment(input: {
  providerTxnId: string;
  orderId: string | null;
  userId: string | null;
  receivedVnd: number;
  transferCode: string | null;
  matched: boolean;
  rawPayload: string;
}) {
  const id = makeId("pay_");
  const result = db.prepare(`
    INSERT INTO payments (
      id, provider, provider_txn_id, order_id, user_id,
      received_vnd, transfer_code, matched, raw_payload, created_at
    ) VALUES (?, 'sepay', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_txn_id) DO NOTHING
  `).run(
    id,
    input.providerTxnId,
    input.orderId,
    input.userId,
    input.receivedVnd,
    input.transferCode,
    input.matched ? 1 : 0,
    input.rawPayload.slice(0, 4_000),
    Date.now(),
  );
  if (!result.changes) return undefined;
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow;
}

export function findPaymentByTxnId(providerTxnId: string) {
  return db.prepare("SELECT * FROM payments WHERE provider_txn_id = ?").get(providerTxnId) as PaymentRow | undefined;
}

export function markPaymentMatched(paymentId: string, userId: string | null) {
  db.prepare(`
    UPDATE payments SET matched = 1, user_id = COALESCE(?, user_id) WHERE id = ?
  `).run(userId, paymentId);
}

export function listUnmatchedPayments(limit = 50) {
  return db.prepare(`
    SELECT * FROM payments WHERE matched = 0 ORDER BY created_at DESC LIMIT ?
  `).all(limit) as PaymentRow[];
}

export function listPaymentsForOrder(orderId: string) {
  return db.prepare(`
    SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC
  `).all(orderId) as PaymentRow[];
}

// Admin cộng tay cho giao dịch không khớp (khách chuyển thiếu mã hoặc chuyển thừa).
export function creditUserSeconds(userId: string, seconds: number, plan?: UserPlan) {
  const amount = Math.max(0, Math.floor(seconds));
  const user = getUserById(userId);
  if (!user) return undefined;
  if (plan) {
    db.prepare(`
      UPDATE users SET plan = ?, quota_seconds = quota_seconds + ?, updated_at = ? WHERE id = ?
    `).run(plan, amount, Date.now(), userId);
  } else if (amount > 0) {
    db.prepare(`
      UPDATE users SET quota_seconds = quota_seconds + ?, updated_at = ? WHERE id = ?
    `).run(amount, Date.now(), userId);
  }
  return getUserById(userId);
}

const insertOrder = db.prepare(`
  INSERT INTO orders (
    id, user_id, amount_vnd, transfer_code, status, created_at, paid_at,
    plan_id, grant_seconds, kind
  ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?)
`);

export function createOrder(input: {
  userId: string;
  amountVnd: number;
  planId: string;
  grantSeconds: number;
  kind: PlanKind;
}) {
  const id = makeId("ord_");
  const now = Date.now();
  // Mã chuyển khoản chỉ có 24 bit nên có thể trùng; thử lại thay vì để lỗi UNIQUE thành 500.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const transferCode = `RELAY${randomBytes(3).toString("hex").toUpperCase()}`;
    if (getOrderByTransferCode(transferCode)) continue;
    insertOrder.run(
      id, input.userId, input.amountVnd, transferCode, now,
      input.planId, input.grantSeconds, input.kind,
    );
    return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
  }
  throw new Error("Không tạo được mã chuyển khoản duy nhất, vui lòng thử lại.");
}

export function getOrderById(id: string) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
}

export function getOrderByTransferCode(transferCode: string) {
  return db.prepare("SELECT * FROM orders WHERE transfer_code = ? COLLATE NOCASE").get(transferCode) as OrderRow | undefined;
}

const markOrderPaidTx = db.transaction((orderId: string, grant: Grant) => {
  db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?
  `).run(Date.now(), orderId);
  applyGrant(grant.userId, grant);
});

export type Grant = {
  userId: string;
  planId: string;
  kind: PlanKind;
  // Gói thuê bao: số giây mỗi tháng. Gói sự kiện: số giây cộng một lần.
  seconds: number;
};

// Cấp quyền lợi sau khi thanh toán thành công.
// - Gói thuê bao: đổi plan, đặt lại kỳ và cộng đè hạn mức tháng của gói mới.
// - Gói sự kiện: chỉ cộng vào bonus_seconds, không đổi plan.
function applyGrant(userId: string, grant: Grant) {
  const now = Date.now();
  if (grant.kind === "event") {
    db.prepare(`
      UPDATE users SET bonus_seconds = bonus_seconds + ?, updated_at = ? WHERE id = ?
    `).run(Math.max(0, Math.floor(grant.seconds)), now, userId);
    return;
  }
  db.prepare(`
    UPDATE users
    SET plan = ?, quota_seconds = ?, used_seconds = 0, period_start = ?, updated_at = ?
    WHERE id = ?
  `).run(grant.planId, Math.max(0, Math.floor(grant.seconds)), startOfPeriod(now), now, userId);
}

export function markOrderPaid(orderId: string, grant?: Grant) {
  const order = getOrderById(orderId);
  if (!order || order.status === "paid") return order;
  const effective: Grant = grant ?? {
    userId: order.user_id,
    planId: order.plan_id || "pro",
    kind: (order.kind as PlanKind) || "subscription",
    seconds: order.grant_seconds ?? proQuotaSeconds(),
  };
  // Đánh dấu đã trả và cấp quyền lợi phải cùng thành công, nếu không user sẽ mất tiền mà không có gói.
  markOrderPaidTx(orderId, effective);
  return getOrderById(orderId)!;
}

// Admin cấp tay: không tạo đơn, chỉ cộng thời gian.
export function grantPlanToUser(userId: string, planId: string, secondsOverride?: number) {
  const plan = getPlanById(planId);
  if (!plan) throw new Error("Không tìm thấy gói.");
  if (!getUserById(userId)) throw new Error("Không tìm thấy người dùng.");
  const seconds = secondsOverride ?? (plan.kind === "subscription" ? plan.monthly_seconds : plan.duration_seconds);
  applyGrant(userId, { userId, planId, kind: plan.kind, seconds });
  return getUserById(userId);
}

export function expireStaleOrders(maxAgeMs = 30 * 60 * 1_000) {
  const cutoff = Date.now() - maxAgeMs;
  db.prepare(`
    UPDATE orders
    SET status = 'expired'
    WHERE status = 'pending' AND created_at < ?
  `).run(cutoff);
}

export function publicUser(user: UserRow) {
  const remaining = remainingSeconds(user);
  const plan = getPlanById(user.plan);
  const periodResetsAt = nextPeriodStart(Date.now());
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    plan: user.plan,
    planName: plan?.name || user.plan,
    planKind: plan?.kind || "subscription",
    quotaSeconds: user.quota_seconds,
    usedSeconds: user.used_seconds,
    bonusSeconds: user.bonus_seconds || 0,
    remainingSeconds: Number.isFinite(remaining) ? remaining : null,
    unlimited: user.quota_seconds === 0,
    // Kỳ hạn mức hiện tại và thời điểm tự làm mới, để UI hiển thị rõ.
    periodStart: user.period_start,
    periodResetsAt,
  };
}
