import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { readCookie, sessionSecret } from "./auth.ts";
import { countAdminAccounts, getAdminAccountByUsername, touchAdminLogin, type AdminAccountRow } from "./db.ts";

// Tài khoản quản trị là danh tính riêng, tách hẳn khỏi người dùng Google của ứng dụng:
// đăng nhập admin không cấp quyền dùng micro/API và ngược lại.
export const ADMIN_COOKIE = "relay_admin";
const ADMIN_TTL_SECONDS = 60 * 60 * 8;
const SCRYPT_KEY_LENGTH = 64;

export type AdminRequest = Request & { adminId?: string; adminAccount?: AdminAccountRow };

function scrypt(password: string, salt: Buffer) {
  return scryptSync(password, salt, SCRYPT_KEY_LENGTH);
}

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminConfigured() {
  return countAdminAccounts() > 0;
}

// Định dạng lưu: scrypt$<salt hex>$<hash hex>. Không lưu mật khẩu gốc.
export function encodePasswordHash(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scrypt(password, salt).toString("hex")}`;
}

function decodePasswordHash(value: string) {
  const [scheme, saltHex, hashHex] = value.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return null;
  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");
  if (!salt.length || !hash.length) return null;
  return { salt, hash };
}

export function verifyPasswordHash(password: string, storedHash: string) {
  const decoded = decodePasswordHash(storedHash);
  if (!decoded) return false;
  return safeEqual(scrypt(password, decoded.salt), decoded.hash);
}

export function generateAdminPassword(length = 16) {
  // Bỏ các ký tự dễ nhầm khi đọc lại (0/O, 1/l/I).
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// Chỉ dùng để kiểm tra tài khoản khi đăng nhập; khi username sai vẫn phải chạy một phép
// so sánh hash để thời gian phản hồi không tiết lộ username tồn tại hay không.
const DUMMY_HASH = encodePasswordHash(randomBytes(16).toString("hex"));

export function authenticateAdmin(username: string, password: string) {
  const account = getAdminAccountByUsername(username);
  const passwordOk = verifyPasswordHash(password, account?.password_hash || DUMMY_HASH);
  if (!account || !passwordOk) return null;
  touchAdminLogin(account.username);
  return account;
}

function adminSessionFingerprint(account: AdminAccountRow) {
  // Đổi mật khẩu sẽ làm fingerprint đổi, thu hồi mọi phiên admin cũ của tài khoản đó.
  return createHash("sha256")
    .update(`${account.username}\n${account.password_hash}`)
    .digest("hex")
    .slice(0, 16);
}

export async function createAdminToken(account: AdminAccountRow) {
  return new SignJWT({ sub: account.username, fp: adminSessionFingerprint(account) })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("relay-admin")
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_TTL_SECONDS}s`)
    .sign(sessionSecret());
}

export async function verifyAdminToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { audience: "relay-admin" });
    if (typeof payload.sub !== "string") return null;
    const account = getAdminAccountByUsername(payload.sub);
    if (!account || payload.fp !== adminSessionFingerprint(account)) return null;
    return account;
  } catch {
    return null;
  }
}

export function setAdminCookie(response: Response, token: string) {
  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  response.setHeader("Set-Cookie", parts.join("; "));
}

export function clearAdminCookie(response: Response) {
  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
  const parts = [
    `${ADMIN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  response.setHeader("Set-Cookie", parts.join("; "));
}

export async function loadAdminFromRequest(request: { headers: { cookie?: string | string[] } }) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return null;
  return verifyAdminToken(token);
}

export async function requireAdmin(request: AdminRequest, response: Response, next: NextFunction) {
  const account = await loadAdminFromRequest(request);
  if (!account) {
    response.status(401).json({ error: "Vui lòng đăng nhập quản trị.", code: "admin_auth_required" });
    return;
  }
  request.adminId = account.username;
  request.adminAccount = account;
  next();
}
