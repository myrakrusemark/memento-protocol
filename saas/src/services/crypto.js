/**
 * Envelope encryption for Memento SaaS.
 *
 * Architecture:
 *   Master key (env secret) → wraps → Workspace key (per-workspace, random)
 *   Workspace key → encrypts → Individual field values (AES-256-GCM)
 *
 * Encrypted fields are prefixed with "enc:" so plaintext records can be
 * detected for migration. Format: enc:<base64(iv)>:<base64(ciphertext+tag)>
 *
 * Uses the Web Crypto API (available in Cloudflare Workers and Node 20+).
 */

const ENC_PREFIX = "enc:";
const IV_BYTES = 12; // 96-bit IV for AES-GCM
const KEY_BITS = 256;

// Dev-only fallback master key (64 hex chars = 32 bytes).
// Only used when ENCRYPTION_MASTER_KEY is not set AND env is development/test.
const DEV_MASTER_KEY = "0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  // Works in both Node and Workers
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Core crypto operations
// ---------------------------------------------------------------------------

/**
 * Import raw key bytes as a CryptoKey for AES-256-GCM.
 * @param {Uint8Array} rawBytes - 32 bytes
 * @param {KeyUsage[]} usages - e.g. ["encrypt", "decrypt"] or ["wrapKey", "unwrapKey"]
 */
async function importKey(rawBytes, usages) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, true, usages);
}

/**
 * Encrypt plaintext with a workspace key.
 * @param {string} plaintext - The text to encrypt
 * @param {CryptoKey} workspaceKey - AES-256-GCM key
 * @returns {string} "enc:<base64iv>:<base64ciphertext>"
 */
export async function encryptField(plaintext, workspaceKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    workspaceKey,
    encoded
  );
  return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt a field value encrypted by encryptField.
 * If the value doesn't have the enc: prefix, returns it as-is (plaintext passthrough).
 * @param {string} ciphertext - "enc:<base64iv>:<base64ciphertext>" or plaintext
 * @param {CryptoKey} workspaceKey - AES-256-GCM key
 * @returns {string} Decrypted plaintext
 */
export async function decryptField(ciphertext, workspaceKey) {
  if (!ciphertext || !ciphertext.startsWith(ENC_PREFIX)) {
    return ciphertext;
  }
  const withoutPrefix = ciphertext.slice(ENC_PREFIX.length);
  const colonIdx = withoutPrefix.indexOf(":");
  if (colonIdx === -1) {
    throw new Error("Invalid encrypted field format: missing IV separator");
  }
  const ivB64 = withoutPrefix.slice(0, colonIdx);
  const ctB64 = withoutPrefix.slice(colonIdx + 1);

  const iv = base64ToBytes(ivB64);
  const ct = base64ToBytes(ctB64);

  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    workspaceKey,
    ct
  );
  return new TextDecoder().decode(plainBytes);
}

/**
 * Check if a field value is already encrypted.
 * @param {string} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/**
 * Wrap (encrypt) a workspace key with the master key.
 * @param {CryptoKey} workspaceKey - The workspace's AES-256-GCM key
 * @param {CryptoKey} masterKey - The master wrapping key
 * @returns {string} Base64-encoded wrapped key blob (iv + wrapped bytes)
 */
export async function wrapKey(workspaceKey, masterKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.wrapKey("raw", workspaceKey, masterKey, {
    name: "AES-GCM",
    iv,
  });
  // Concatenate iv + wrapped key bytes
  const combined = new Uint8Array(iv.length + wrapped.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(wrapped), iv.length);
  return bytesToBase64(combined);
}

/**
 * Unwrap (decrypt) a workspace key blob with the master key.
 * @param {string} wrappedB64 - Base64-encoded wrapped key blob (from wrapKey)
 * @param {CryptoKey} masterKey - The master wrapping key
 * @returns {CryptoKey} The unwrapped workspace AES-256-GCM key
 */
export async function unwrapKey(wrappedB64, masterKey) {
  const combined = base64ToBytes(wrappedB64);
  const iv = combined.slice(0, IV_BYTES);
  const wrapped = combined.slice(IV_BYTES);
  return crypto.subtle.unwrapKey(
    "raw",
    wrapped,
    masterKey,
    { name: "AES-GCM", iv },
    { name: "AES-GCM", length: KEY_BITS },
    true,
    ["encrypt", "decrypt"]
  );
}

// ---------------------------------------------------------------------------
// Master key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the master key from environment.
 * Falls back to DEV_MASTER_KEY only in development/test.
 * @param {object} env - Workers env or process.env
 * @returns {CryptoKey|null} Master key, or null if encryption is not configured
 */
export async function getMasterKey(env) {
  const masterKeyHex =
    env?.ENCRYPTION_MASTER_KEY ||
    process.env.ENCRYPTION_MASTER_KEY;

  if (masterKeyHex) {
    const bytes = hexToBytes(masterKeyHex);
    if (bytes.length !== 32) {
      throw new Error("ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes)");
    }
    return importKey(bytes, ["wrapKey", "unwrapKey"]);
  }

  // Dev/test fallback
  const environment = env?.ENVIRONMENT || process.env.ENVIRONMENT || process.env.NODE_ENV;
  if (environment === "development" || environment === "test" || !environment) {
    return importKey(hexToBytes(DEV_MASTER_KEY), ["wrapKey", "unwrapKey"]);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Workspace key management
// ---------------------------------------------------------------------------

/** In-memory cache of unwrapped workspace keys (per-isolate lifecycle). */
const workspaceKeyCache = new Map();

/**
 * Clear the workspace key cache. Used in tests.
 */
export function clearKeyCache() {
  workspaceKeyCache.clear();
}

/**
 * Get or create the encryption key for a workspace.
 *
 * - If the workspace already has a wrapped key in the control DB, unwrap and return it.
 * - If not, generate a new random key, wrap it, store it, and return it.
 * - Returns null if encryption is not configured (no master key).
 *
 * @param {string} workspaceId - The workspace ID
 * @param {object} env - Workers env bindings
 * @param {import("@libsql/client").Client} controlDb - Control plane database
 * @returns {CryptoKey|null}
 */
export async function getWorkspaceKey(workspaceId, env, controlDb) {
  // Check cache first
  if (workspaceKeyCache.has(workspaceId)) {
    return workspaceKeyCache.get(workspaceId);
  }

  const masterKey = await getMasterKey(env);
  if (!masterKey) {
    return null;
  }

  // Check if workspace already has a key stored
  const result = await controlDb.execute({
    sql: "SELECT encrypted_key FROM workspaces WHERE id = ?",
    args: [workspaceId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (row.encrypted_key) {
    // Unwrap existing key
    const wsKey = await unwrapKey(row.encrypted_key, masterKey);
    workspaceKeyCache.set(workspaceId, wsKey);
    return wsKey;
  }

  // Generate a new workspace key
  const wsKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: KEY_BITS },
    true,
    ["encrypt", "decrypt"]
  );

  // Wrap and store
  const wrappedKey = await wrapKey(wsKey, masterKey);
  await controlDb.execute({
    sql: "UPDATE workspaces SET encrypted_key = ? WHERE id = ?",
    args: [wrappedKey, workspaceId],
  });

  workspaceKeyCache.set(workspaceId, wsKey);
  return wsKey;
}

// ---------------------------------------------------------------------------
// Batch encrypt/decrypt helpers for route handlers
// ---------------------------------------------------------------------------

/**
 * Encrypt multiple fields on an object. Modifies in-place.
 * Skips fields that are null/undefined or already encrypted.
 * @param {object} obj - The object to modify
 * @param {string[]} fields - Field names to encrypt
 * @param {CryptoKey} key - Workspace encryption key
 */
export async function encryptFields(obj, fields, key) {
  for (const field of fields) {
    if (obj[field] != null && !isEncrypted(obj[field])) {
      obj[field] = await encryptField(String(obj[field]), key);
    }
  }
}

/**
 * Decrypt multiple fields on an object. Modifies in-place.
 * Skips fields that are null/undefined or not encrypted.
 * @param {object} obj - The object to modify
 * @param {string[]} fields - Field names to decrypt
 * @param {CryptoKey} key - Workspace encryption key
 */
export async function decryptFields(obj, fields, key) {
  for (const field of fields) {
    if (obj[field] != null && isEncrypted(obj[field])) {
      obj[field] = await decryptField(obj[field], key);
    }
  }
}
