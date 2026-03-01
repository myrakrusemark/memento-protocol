/**
 * Stripe utilities for Cloudflare Workers.
 *
 * Uses Web Crypto API instead of the stripe npm package — the SDK pulls
 * Node.js-only deps that break on Workers. We only need webhook signature
 * verification (HMAC-SHA256) and optional REST API calls.
 */

const STRIPE_API_BASE = "https://api.stripe.com";
const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Constant-time string comparison to prevent timing attacks.
 * Workers lack crypto.timingSafeEqual, so we implement our own.
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify a Stripe webhook signature using Web Crypto API.
 *
 * Stripe signs with HMAC-SHA256: `v1=hex(hmac(timestamp.payload, secret))`
 * We check the timestamp is within tolerance and the signature matches.
 *
 * @param {string} rawBody - Raw request body string
 * @param {string} sigHeader - Stripe-Signature header value
 * @param {string} secret - Webhook endpoint signing secret (whsec_...)
 * @returns {Promise<{event: object}>} Parsed event on success
 * @throws {Error} On invalid/missing signature or replay
 */
export async function verifyWebhookSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) {
    throw new Error("Missing Stripe-Signature header");
  }

  // Parse header: t=timestamp,v1=sig1,v1=sig2,...
  const parts = {};
  for (const item of sigHeader.split(",")) {
    const [key, ...valueParts] = item.split("=");
    const value = valueParts.join("=");
    if (!parts[key]) parts[key] = [];
    parts[key].push(value);
  }

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];

  if (!timestamp || signatures.length === 0) {
    throw new Error("Invalid Stripe-Signature header format");
  }

  // Replay protection — reject if timestamp is too old or too far in the future
  const timestampAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(timestampAge) || Math.abs(timestampAge) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance (possible replay)");
  }

  // Compute expected signature
  const payload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Check if any v1 signature matches (Stripe may include multiple)
  const match = signatures.some((sig) => timingSafeEqual(sig, expectedSig));
  if (!match) {
    throw new Error("Invalid webhook signature");
  }

  return { event: JSON.parse(rawBody) };
}

/**
 * Thin fetch wrapper for the Stripe REST API.
 *
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g., "/v1/subscriptions/sub_123")
 * @param {object} [params] - Form-encoded body params
 * @param {string} secretKey - Stripe secret key
 * @returns {Promise<object>} Parsed JSON response
 */
export async function stripeRequest(method, path, params, secretKey) {
  const url = `${STRIPE_API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const init = { method, headers };
  if (params && (method === "POST" || method === "PUT")) {
    init.body = new URLSearchParams(params).toString();
  }

  const res = await fetch(url, init);
  const body = await res.json();

  if (!res.ok) {
    const msg = body.error?.message || `Stripe API error: ${res.status}`;
    throw new Error(msg);
  }

  return body;
}
