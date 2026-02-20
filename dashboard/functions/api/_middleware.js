/**
 * Middleware for all /api/* routes.
 * - Rate limits login attempts (5 per IP per 15 minutes)
 * - Validates JWT cookie on all routes except /api/login
 */

import { verifyJwt, getTokenFromCookie } from "../../lib/auth.js";

// In-memory rate limit tracker. Resets on isolate recycle — acceptable for admin-only.
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil(
      (entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

export function recordLoginAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { windowStart: now, count: 1 });
  } else {
    entry.count++;
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";

  // Rate limit login attempts
  if (url.pathname === "/api/login" && request.method === "POST") {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return new Response(
        JSON.stringify({ error: "Too many login attempts", retryAfter: limit.retryAfter }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(limit.retryAfter) } }
      );
    }
    // Store IP in context for the login handler to record on failure
    context.data = { ...context.data, clientIp: ip };
    return next();
  }

  // Login and logout don't need JWT
  if (url.pathname === "/api/login" || url.pathname === "/api/logout") {
    return next();
  }

  // All other /api routes require valid JWT
  const token = getTokenFromCookie(request);
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  context.data = { ...context.data, user: payload };
  return next();
}
