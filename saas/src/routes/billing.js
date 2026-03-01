/**
 * Billing routes — upgrade flow (Mullvad model).
 *
 * The API key IS the account number. No usernames, no emails, no passwords.
 *
 * POST /v1/billing/pre-checkout (public, no auth)
 *   - Accepts { api_key } → verifies → returns Stripe checkout URL
 *   - Rate limited by IP (5/hr, reusing auth.js pattern)
 *
 * GET /v1/billing/checkout (authenticated)
 *   - Same flow but uses existing auth context
 *
 * GET /v1/billing/status (authenticated)
 *   - Returns plan info and limits
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getControlDb } from "../db/connection.js";
import { PLANS } from "../config/plans.js";

// ---------------------------------------------------------------------------
// Rate limiting (mirrors auth.js pattern)
// ---------------------------------------------------------------------------

const rateLimits = new Map();
const RATE_LIMIT_HOUR = 5;

export function resetBillingRateLimits() {
  rateLimits.clear();
}

function checkRateLimit(ip) {
  const key = ip || "unknown";
  const now = Date.now();
  const hourAgo = now - 3600_000;

  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }

  const timestamps = rateLimits.get(key);
  const pruned = timestamps.filter((t) => t > hourAgo);
  rateLimits.set(key, pruned);

  if (pruned.length >= RATE_LIMIT_HOUR) {
    return { allowed: false, retryAfter: 3600 };
  }

  return { allowed: true };
}

function recordRequest(ip) {
  const key = ip || "unknown";
  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }
  rateLimits.get(key).push(Date.now());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

function validateApiKeyFormat(key) {
  if (typeof key !== "string") return false;
  if (!key.startsWith("mp_live_") && !key.startsWith("mp_test_")) return false;
  if (key.length < 16 || key.length > 50) return false;
  return true;
}

function buildCheckoutUrl(userId) {
  const paymentLinkUrl = process.env.STRIPE_PAYMENT_LINK_URL;
  if (!paymentLinkUrl) return null;

  const separator = paymentLinkUrl.includes("?") ? "&" : "?";
  return `${paymentLinkUrl}${separator}client_reference_id=${userId}`;
}

async function lookupUserByKeyHash(keyHash) {
  const db = getControlDb();
  const result = await db.execute({
    sql: `SELECT u.id AS user_id, u.plan, u.stripe_customer_id, u.stripe_subscription_id, u.created_at
          FROM api_keys ak JOIN users u ON ak.user_id = u.id
          WHERE ak.key_hash = ? AND ak.revoked_at IS NULL`,
    args: [keyHash],
  });
  return result.rows.length > 0 ? result.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Public routes (mounted outside auth middleware)
// ---------------------------------------------------------------------------

export function registerBillingPublicRoutes(app) {
  app.post("/v1/billing/pre-checkout", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown";

    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return c.json(
        {
          error: "rate_limited",
          message: `Too many requests. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`,
          retry_after: limit.retryAfter,
        },
        429
      );
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const apiKey = body?.api_key;
    if (!apiKey || !validateApiKeyFormat(apiKey)) {
      return c.json({ error: "Invalid API key format" }, 400);
    }

    const keyHash = hashApiKey(apiKey);
    const user = await lookupUserByKeyHash(keyHash);

    if (!user) {
      recordRequest(ip);
      return c.json({ error: "Invalid API key" }, 401);
    }

    recordRequest(ip);

    if (user.plan === "pro" || user.plan === "full") {
      return c.json({
        already_subscribed: true,
        plan: user.plan,
        limits: PLANS[user.plan] || PLANS.pro,
      });
    }

    const url = buildCheckoutUrl(user.user_id);
    if (!url) {
      return c.json({ error: "Billing not configured" }, 503);
    }

    return c.json({ url });
  });
}

// ---------------------------------------------------------------------------
// Authenticated routes (mounted inside /v1 with auth middleware)
// ---------------------------------------------------------------------------

const billingAuthenticated = new Hono();

billingAuthenticated.get("/checkout", async (c) => {
  const userId = c.get("userId");
  const plan = c.get("userPlan");

  if (plan === "pro" || plan === "full") {
    return c.json({
      already_subscribed: true,
      plan,
      limits: PLANS[plan] || PLANS.pro,
    });
  }

  const url = buildCheckoutUrl(userId);
  if (!url) {
    return c.json({ error: "Billing not configured" }, 503);
  }

  return c.json({ url });
});

billingAuthenticated.get("/status", async (c) => {
  const userId = c.get("userId");
  const db = getControlDb();

  const result = await db.execute({
    sql: `SELECT plan, stripe_customer_id, stripe_subscription_id, created_at
          FROM users WHERE id = ?`,
    args: [userId],
  });

  if (result.rows.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  const user = result.rows[0];
  const plan = user.plan || "free";

  return c.json({
    plan,
    limits: PLANS[plan] || PLANS.free,
    has_subscription: !!user.stripe_subscription_id,
    member_since: user.created_at,
  });
});

export { billingAuthenticated };
