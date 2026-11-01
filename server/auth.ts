import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { ensureCurrentPeriod, getUserById, hasQuota, publicUser, remainingSeconds, type UserRow } from "./db.ts";

// Ngưỡng cảnh báo hạn mức, dùng chung với giao diện.
const QUOTA_WARNING_SECONDS = 300;

const SESSION_COOKIE = "relay_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type AuthedRequest = Request & { user?: UserRow };

export function sessionSecret() {
  const secret = (process.env.SESSION_SECRET || "").trim();
  if (secret.length < 16) {
    throw new Error("Chưa cấu hình SESSION_SECRET (tối thiểu 16 ký tự).");
  }
  return new TextEncoder().encode(secret);
}

export function assertSessionSecret() {
  sessionSecret();
}

function googleClientId() {
  return (process.env.GOOGLE_CLIENT_ID || "").trim();
}

export function authConfigured() {
  return Boolean(googleClientId());
}

export function publicGoogleClientId() {
  return googleClientId();
}

export function readCookie(request: { headers: { cookie?: string | string[] } }, name: string) {
  const raw = request.headers.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join("; ") : (raw || "");
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      try {
        return decodeURIComponent(part.slice(name.length + 1));
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function readSessionToken(request: { headers: { cookie?: string | string[] } }) {
  return readCookie(request, SESSION_COOKIE);
}

export async function createSessionToken(user: Pick<UserRow, "id" | "session_version">) {
  return new SignJWT({ sub: user.id, sv: user.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionSecret());
}

export async function verifySessionToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    const userId = typeof payload.sub === "string" ? payload.sub : "";
    if (!userId) return null;
    const user = getUserById(userId);
    if (!user) return null;
    // Token phát trước lần đăng xuất gần nhất mang session_version cũ -> từ chối.
    const version = typeof payload.sv === "number" ? payload.sv : 0;
    if (version !== user.session_version) return null;
    return user;
  } catch {
    return null;
  }
}

export async function verifyGoogleCredential(credential: string) {
  const clientId = googleClientId();
  if (!clientId) throw new Error("Backend chưa cấu hình GOOGLE_CLIENT_ID.");
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google không trả về thông tin người dùng hợp lệ.");
  }
  if (!payload.email_verified) {
    throw new Error("Email Google chưa được xác minh.");
  }
  return {
    googleSub: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || "",
  };
}

export function setSessionCookie(response: Response, token: string) {
  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  response.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(response: Response) {
  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  response.setHeader("Set-Cookie", parts.join("; "));
}

export async function loadUserFromRequest(request: { headers: { cookie?: string | string[] } }) {
  const token = readSessionToken(request);
  if (!token) return null;
  return verifySessionToken(token);
}

export async function requireAuth(request: AuthedRequest, response: Response, next: NextFunction) {
  const user = await loadUserFromRequest(request);
  if (!user) {
    response.status(401).json({ error: "Vui lòng đăng nhập Google.", code: "auth_required" });
    return;
  }
  request.user = user;
  next();
}

export async function requireQuota(request: AuthedRequest, response: Response, next: NextFunction) {
  const loaded = request.user || await loadUserFromRequest(request);
  if (!loaded) {
    response.status(401).json({ error: "Vui lòng đăng nhập Google.", code: "auth_required" });
    return;
  }
  // Sang tháng mới thì hạn mức được làm mới ngay ở request đầu tiên, không cần job nền.
  const user = ensureCurrentPeriod(loaded);
  request.user = user;
  if (!hasQuota(user)) {
    response.status(402).json({
      error: "Đã hết hạn mức tháng này. Mua thêm phút hoặc nâng cấp để tiếp tục.",
      code: "quota_exhausted",
      user: publicUser(user),
    });
    return;
  }
  // Còn dưới ngưỡng cảnh báo thì gắn header để client hiển thị banner ngay cả khi
  // heartbeat không chạy (chế độ nhập tay).
  const remaining = remainingSeconds(user);
  if (Number.isFinite(remaining) && remaining <= QUOTA_WARNING_SECONDS) {
    response.setHeader("X-Quota-Remaining", String(Math.floor(remaining)));
  }
  next();
}
