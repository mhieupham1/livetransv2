import { createHash, timingSafeEqual } from "node:crypto";
import {
  createOrder,
  deleteSetting,
  expireStaleOrders,
  findPaymentByTxnId,
  getOrderById,
  getOrderByTransferCode,
  getPlanById,
  getSetting,
  getSettingUpdatedAt,
  markOrderPaid,
  recordPayment,
  setSetting,
  type OrderRow,
} from "./db.ts";

// Cấu hình thanh toán đọc từ bảng settings; biến môi trường chỉ dùng làm giá trị mặc định
// cho lần chạy đầu tiên, sau đó trang admin là nguồn duy nhất.
function settingValue(key: string, envKey: string, fallback = "") {
  const stored = getSetting(key);
  if (stored !== undefined) return stored.trim();
  return (process.env[envKey] || fallback).trim();
}

export function upgradeAmountVnd() {
  const value = Number(settingValue("upgrade_amount_vnd", "UPGRADE_AMOUNT_VND", "99000"));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 99_000;
}

export function bankConfig() {
  return {
    bin: settingValue("bank_bin", "BANK_BIN"),
    account: settingValue("bank_account", "BANK_ACCOUNT"),
    accountName: settingValue("bank_account_name", "BANK_ACCOUNT_NAME"),
  };
}

export type BillingSettingsInput = {
  bankBin: string;
  bankAccount: string;
  bankAccountName: string;
  upgradeAmountVnd: number;
  sepayWebhookApiKey: string | null;
};

export function saveBillingSettings(input: BillingSettingsInput) {
  if (!/^\d{6}$/.test(input.bankBin)) throw new Error("Mã BIN ngân hàng phải gồm 6 chữ số.");
  if (!/^[0-9A-Za-z]{4,30}$/.test(input.bankAccount)) throw new Error("Số tài khoản không hợp lệ.");
  if (input.bankAccountName.trim().length < 2) throw new Error("Tên chủ tài khoản không hợp lệ.");
  if (!Number.isFinite(input.upgradeAmountVnd) || input.upgradeAmountVnd < 1_000) {
    throw new Error("Giá nâng cấp phải từ 1.000đ.");
  }
  setSetting("bank_bin", input.bankBin);
  setSetting("bank_account", input.bankAccount);
  setSetting("bank_account_name", input.bankAccountName.trim().toUpperCase());
  setSetting("upgrade_amount_vnd", String(Math.floor(input.upgradeAmountVnd)));
  // Chuỗi rỗng nghĩa là xóa về mặc định .env; null nghĩa là giữ nguyên khóa hiện tại.
  if (input.sepayWebhookApiKey !== null) {
    if (input.sepayWebhookApiKey.trim()) setSetting("sepay_webhook_api_key", input.sepayWebhookApiKey.trim());
    else deleteSetting("sepay_webhook_api_key");
  }
}

export function billingSettingsForAdmin() {
  const bank = bankConfig();
  const updatedAt = getSettingUpdatedAt("bank_bin");
  return {
    bankBin: bank.bin,
    bankAccount: bank.account,
    bankAccountName: bank.accountName,
    upgradeAmountVnd: upgradeAmountVnd(),
    configured: billingConfigured(),
    // Không bao giờ trả khóa webhook về client, chỉ báo đã có hay chưa.
    hasSepayKey: Boolean(sepayWebhookKey()),
    updatedAt,
    source: getSetting("bank_bin") !== undefined ? "database" : "environment",
  };
}

export function billingConfigured() {
  const bank = bankConfig();
  return Boolean(bank.bin && bank.account && bank.accountName);
}

export function vietQrImageUrl(order: OrderRow) {
  const bank = bankConfig();
  if (!bank.bin || !bank.account) return "";
  const params = new URLSearchParams({
    amount: String(order.amount_vnd),
    addInfo: order.transfer_code,
    accountName: bank.accountName,
  });
  return `https://img.vietqr.io/image/${bank.bin}-${bank.account}-compact2.png?${params.toString()}`;
}

export function publicOrder(order: OrderRow) {
  expireStaleOrders();
  const fresh = getOrderById(order.id) || order;
  const bank = bankConfig();
  const plan = fresh.plan_id ? getPlanById(fresh.plan_id) : undefined;
  return {
    id: fresh.id,
    amountVnd: fresh.amount_vnd,
    transferCode: fresh.transfer_code,
    status: fresh.status,
    createdAt: fresh.created_at,
    paidAt: fresh.paid_at,
    planId: fresh.plan_id,
    planName: plan?.name || null,
    kind: fresh.kind,
    grantSeconds: fresh.grant_seconds,
    qrImageUrl: vietQrImageUrl(fresh),
    bankBin: bank.bin,
    bankAccount: bank.account,
    bankAccountName: bank.accountName,
  };
}

// Tạo đơn cho một gói cụ thể. Gói sự kiện và thuê bao khác nhau ở chỗ cộng một lần
// hay làm mới theo tháng; chi tiết cấp quyền nằm trong db.applyGrant.
export function createOrderForPlan(userId: string, planId: string) {
  if (!billingConfigured()) {
    throw new Error("Chưa cấu hình tài khoản ngân hàng VietQR. Vào /admin/settings để thiết lập.");
  }
  const plan = getPlanById(planId);
  if (!plan || !plan.active) throw new Error("Gói không tồn tại hoặc đã ngừng bán.");
  if (plan.price_vnd <= 0) throw new Error("Gói này không cần thanh toán.");
  expireStaleOrders();
  const grantSeconds = plan.kind === "subscription" ? plan.monthly_seconds : plan.duration_seconds;
  return createOrder({
    userId,
    amountVnd: plan.price_vnd,
    planId: plan.id,
    grantSeconds,
    kind: plan.kind,
  });
}

// Giữ tương thích với luồng cũ (nút "Nâng cấp Pro" chưa chọn gói).
export function createUpgradeOrder(userId: string, planId = "pro") {
  return createOrderForPlan(userId, planId);
}

export function sepayWebhookKey() {
  return settingValue("sepay_webhook_api_key", "SEPAY_WEBHOOK_API_KEY");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual ném lỗi khi độ dài khác nhau, nên kiểm tra độ dài trước.
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertSepayAuthorized(request: { header(name: string): string | undefined }) {
  const expected = sepayWebhookKey();
  if (!expected) {
    throw new Error("Chưa cấu hình SEPAY_WEBHOOK_API_KEY.");
  }
  const authorization = request.header("authorization") || "";
  const apikeyHeader = request.header("x-api-key") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const apikey = authorization.toLowerCase().startsWith("apikey ")
    ? authorization.slice(7).trim()
    : apikeyHeader.trim();
  const provided = bearer || apikey || authorization.trim();
  if (!safeEqual(provided, expected)) {
    const error = new Error("Webhook không hợp lệ.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

export type SepayPayload = {
  id?: unknown;
  content?: unknown;
  description?: unknown;
  transferAmount?: unknown;
  amount?: unknown;
  referenceCode?: unknown;
  accountNumber?: unknown;
  transferType?: unknown;
  gateway?: unknown;
};

// Sepay gửi kèm id giao dịch. Nếu thiếu, ghép các trường nhận dạng còn lại để vẫn
// chặn được webhook gửi lặp lại.
function providerTxnId(body: SepayPayload) {
  const rawId = body.id;
  if (typeof rawId === "number" && Number.isFinite(rawId)) return `sepay:${rawId}`;
  if (typeof rawId === "string" && rawId.trim()) return `sepay:${rawId.trim()}`;
  const reference = typeof body.referenceCode === "string" ? body.referenceCode.trim() : "";
  const account = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
  const amount = String(Number(body.transferAmount ?? body.amount));
  if (reference) return `sepay:${account}:${reference}:${amount}`;
  // Không có mã tham chiếu: băm payload để vẫn idempotent.
  return `sepay:hash:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`;
}

export function applySepayPayment(body: SepayPayload) {
  expireStaleOrders();

  const receivedVnd = Number(body.transferAmount ?? body.amount);
  const content = [body.content, body.description, body.referenceCode]
    .filter((value) => typeof value === "string")
    .join(" ");
  const matchedCode = content.toUpperCase().match(/RELAY[A-F0-9]{6}/)?.[0] || null;
  const txnId = providerTxnId(body);

  const existing = findPaymentByTxnId(txnId);
  if (existing) {
    // Webhook gửi lại: trả lại kết quả cũ, không cộng thêm hạn mức.
    const order = existing.order_id ? getOrderById(existing.order_id) : undefined;
    return order
      ? { matched: true as const, order, already: true as const }
      : { matched: false as const, already: true as const, reason: "Giao dịch đã được ghi nhận trước đó." };
  }

  const record = (input: {
    orderId: string | null;
    userId: string | null;
    matched: boolean;
  }) => recordPayment({
    providerTxnId: txnId,
    orderId: input.orderId,
    userId: input.userId,
    receivedVnd: Number.isFinite(receivedVnd) ? Math.round(receivedVnd) : 0,
    transferCode: matchedCode,
    matched: input.matched,
    rawPayload: JSON.stringify(body),
  });

  // Tiền ra (chuyển khoản đi) không bao giờ là thanh toán; ghi lại để đối soát.
  if (typeof body.transferType === "string" && body.transferType.toLowerCase() !== "in") {
    record({ orderId: null, userId: null, matched: false });
    return { matched: false as const, reason: "Bỏ qua giao dịch tiền ra (transferType khác 'in')." };
  }

  // Chỉ nhận tiền vào đúng tài khoản đã cấu hình, tránh webhook từ tài khoản khác.
  const bank = bankConfig();
  const incomingAccount = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
  if (bank.account && incomingAccount && incomingAccount.replace(/\s/g, "") !== bank.account.replace(/\s/g, "")) {
    record({ orderId: null, userId: null, matched: false });
    return { matched: false as const, reason: `Tiền vào tài khoản ${incomingAccount}, không phải tài khoản nhận đã cấu hình.` };
  }

  const order = matchedCode ? getOrderByTransferCode(matchedCode) : undefined;
  if (!order) {
    record({ orderId: null, userId: null, matched: false });
    return { matched: false as const, reason: "Không tìm thấy đơn khớp mã chuyển khoản." };
  }

  if (order.status === "paid") {
    record({ orderId: order.id, userId: order.user_id, matched: false });
    return { matched: true as const, order, already: true as const, reason: "Đơn đã được thanh toán trước đó; tiền được ghi nhận để hoàn/cộng bù." };
  }

  if (!Number.isFinite(receivedVnd) || receivedVnd < order.amount_vnd) {
    record({ orderId: order.id, userId: order.user_id, matched: false });
    return { matched: false as const, reason: "Số tiền chuyển khoản chưa đủ." };
  }

  record({ orderId: order.id, userId: order.user_id, matched: true });
  const paid = markOrderPaid(order.id)!;
  return { matched: true as const, order: paid, already: false as const };
}
