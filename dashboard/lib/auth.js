/**
 * Authentication helpers for the analytics dashboard.
 * Uses Web Crypto API — native to Cloudflare Workers, no dependencies.
 */

const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Verify a password against a PBKDF2-SHA256 hash.
 * Hash format: `<iterations>:<base64(salt)>:<base64(derived_key)>`
 */
export async function verifyPassword(password, storedHash) {
  const [iterStr, saltB64, hashB64] = storedHash.split(":");
  if (!iterStr || !saltB64 || !hashB64) return false;

  const iterations = parseInt(iterStr, 10);
  const salt = base64ToBuffer(saltB64);
  const expectedHash = base64ToBuffer(hashB64);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );

  const derived = new Uint8Array(derivedBits);
  if (derived.length !== expectedHash.length) return false;

  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < derived.length; i++) {
    diff |= derived[i] ^ expectedHash[i];
  }
  return diff === 0;
}

/**
 * Create a signed JWT with HMAC-SHA256.
 */
export async function createJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bufferToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a JWT. Returns the payload or null if invalid/expired.
 */
export async function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = base64UrlToBuffer(encodedSignature);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(signingInput)
  );

  if (!valid) return null;

  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;

  return payload;
}

/**
 * Parse the auth cookie from a request.
 */
export function getTokenFromCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Build a Set-Cookie header for the JWT.
 */
export function buildCookieHeader(token, maxAge = JWT_EXPIRY_SECONDS) {
  return `token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// --- Base64 / Base64URL helpers ---

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

function bufferToBase64Url(buf) {
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const binary = atob(s);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}
