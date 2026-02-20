#!/usr/bin/env node

/**
 * Generate a PBKDF2-SHA256 password hash for the ADMIN_PASS_HASH secret.
 *
 * Usage: node scripts/hash-password.js <password>
 * Output: <iterations>:<base64(salt)>:<base64(derived_key)>
 *
 * Then: wrangler secret put ADMIN_PASS_HASH
 *       (paste the output)
 */

import { webcrypto } from "node:crypto";

const ITERATIONS = 100_000;
const password = process.argv[2];

if (!password) {
  console.error("Usage: node scripts/hash-password.js <password>");
  process.exit(1);
}

const salt = webcrypto.getRandomValues(new Uint8Array(16));

const keyMaterial = await webcrypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"]
);

const derivedBits = await webcrypto.subtle.deriveBits(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  keyMaterial,
  256
);

const saltB64 = Buffer.from(salt).toString("base64");
const hashB64 = Buffer.from(derivedBits).toString("base64");

console.log(`${ITERATIONS}:${saltB64}:${hashB64}`);
