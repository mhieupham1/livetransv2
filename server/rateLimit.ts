import type { NextFunction, Request, Response } from "express";

// Token bucket rất nhẹ, chạy trong bộ nhớ: mỗi user có một xô riêng cho từng nhóm endpoint.
// Đủ để chặn một script đốt tiền API; nếu chạy nhiều instance thì cần chuyển sang Redis.
type Bucket = { tokens: number; updatedAt: number };

export type RateLimitOptions = {
  name: string;
  capacity: number;
  refillPerSecond: number;
  // Cho phép vượt xô một chút để không chặn oan khi người dùng bấm nhanh vài lần.
  message?: string;
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function take(key: string, options: RateLimitOptions) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(key, { tokens: options.capacity - 1, updatedAt: now });
    return true;
  }
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// Xoá xô đã hồi đầy để Map không phình mãi khi có nhiều user.
function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 10 * 60 * 1_000) buckets.delete(key);
  }
}

export function rateLimit(options: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    // requireAuth chạy trước nên request.user đã có; dự phòng theo IP nếu chưa.
    const user = (request as Request & { user?: { id: string } }).user;
    const identity = user?.id || request.socket.remoteAddress || "unknown";
    if (take(`${options.name}:${identity}`, options)) {
      next();
      return;
    }
    const retryAfter = Math.ceil(1 / options.refillPerSecond);
    response.setHeader("Retry-After", String(retryAfter));
    response.status(429).json({
      error: options.message || "Bạn thao tác quá nhanh. Vui lòng thử lại sau ít giây.",
      code: "rate_limited",
    });
  };
}
