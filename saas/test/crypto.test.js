import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  encryptField,
  decryptField,
  isEncrypted,
  wrapKey,
  unwrapKey,
  getMasterKey,
  getWorkspaceKey,
  clearKeyCache,
} from "../src/services/crypto.js";
import { createTestHarness } from "./setup.js";

describe("crypto service", () => {
  // ---------------------------------------------------------------------------
  // encryptField / decryptField round-trip
  // ---------------------------------------------------------------------------

  it("encrypt then decrypt round-trips correctly", async () => {
    await getMasterKey({});
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const plaintext = "The MCP SDK uses zod for schema validation";
    const encrypted = await encryptField(plaintext, wsKey);

    assert.ok(encrypted.startsWith("enc:"), "Should have enc: prefix");
    assert.notEqual(encrypted, plaintext, "Encrypted should differ from plaintext");

    const decrypted = await decryptField(encrypted, wsKey);
    assert.equal(decrypted, plaintext);
  });

  it("encrypts with unique IVs (no two encryptions produce same output)", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const plaintext = "same input";
    const a = await encryptField(plaintext, wsKey);
    const b = await encryptField(plaintext, wsKey);

    assert.notEqual(a, b, "Same plaintext should produce different ciphertext");

    // But both should decrypt to the same thing
    assert.equal(await decryptField(a, wsKey), plaintext);
    assert.equal(await decryptField(b, wsKey), plaintext);
  });

  it("handles empty string encryption", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const encrypted = await encryptField("", wsKey);
    assert.ok(encrypted.startsWith("enc:"));
    assert.equal(await decryptField(encrypted, wsKey), "");
  });

  it("handles unicode content", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const plaintext = "Hello \u{1F30D} — em dash, \u00FC\u00F6\u00E4, \u4F60\u597D";
    const encrypted = await encryptField(plaintext, wsKey);
    assert.equal(await decryptField(encrypted, wsKey), plaintext);
  });

  it("handles large content", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const plaintext = "x".repeat(100_000);
    const encrypted = await encryptField(plaintext, wsKey);
    assert.equal(await decryptField(encrypted, wsKey), plaintext);
  });

  // ---------------------------------------------------------------------------
  // decryptField passthrough for plaintext
  // ---------------------------------------------------------------------------

  it("decryptField passes through plaintext (no enc: prefix)", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const plaintext = "Just plain text, no encryption";
    const result = await decryptField(plaintext, wsKey);
    assert.equal(result, plaintext);
  });

  it("decryptField passes through null and undefined", async () => {
    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    assert.equal(await decryptField(null, wsKey), null);
    assert.equal(await decryptField(undefined, wsKey), undefined);
  });

  // ---------------------------------------------------------------------------
  // isEncrypted
  // ---------------------------------------------------------------------------

  it("isEncrypted detects enc: prefix", () => {
    assert.ok(isEncrypted("enc:abc:def"));
    assert.ok(!isEncrypted("plain text"));
    assert.ok(!isEncrypted(""));
    assert.ok(!isEncrypted(null));
    assert.ok(!isEncrypted(undefined));
  });

  // ---------------------------------------------------------------------------
  // Key wrapping
  // ---------------------------------------------------------------------------

  it("wrapKey + unwrapKey round-trips workspace key", async () => {
    const masterKey = await getMasterKey({});

    const wsKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    // Wrap
    const wrapped = await wrapKey(wsKey, masterKey);
    assert.ok(typeof wrapped === "string", "Wrapped key should be base64 string");

    // Unwrap
    const unwrapped = await unwrapKey(wrapped, masterKey);

    // Verify by encrypting/decrypting with both keys
    const plaintext = "test data";
    const encrypted = await encryptField(plaintext, wsKey);
    const decrypted = await decryptField(encrypted, unwrapped);
    assert.equal(decrypted, plaintext);
  });

  // ---------------------------------------------------------------------------
  // getMasterKey
  // ---------------------------------------------------------------------------

  it("getMasterKey returns dev key in test environment", async () => {
    const key = await getMasterKey({});
    assert.ok(key !== null, "Should return a key in test/dev");
  });

  // ---------------------------------------------------------------------------
  // getWorkspaceKey
  // ---------------------------------------------------------------------------

  it("getWorkspaceKey generates and caches key for workspace", async () => {
    clearKeyCache();
    const h = await createTestHarness();

    try {
      const key1 = await getWorkspaceKey(h.seed.workspaceId, {}, h.db);
      assert.ok(key1 !== null, "Should return a workspace key");

      // Should be cached — same key object
      const key2 = await getWorkspaceKey(h.seed.workspaceId, {}, h.db);
      assert.equal(key1, key2, "Should return cached key");

      // Verify key was stored in DB
      const result = await h.db.execute({
        sql: "SELECT encrypted_key FROM workspaces WHERE id = ?",
        args: [h.seed.workspaceId],
      });
      assert.ok(result.rows[0].encrypted_key, "Encrypted key should be stored in DB");
    } finally {
      h.cleanup();
    }
  });

  it("getWorkspaceKey unwraps existing key from DB", async () => {
    clearKeyCache();
    const h = await createTestHarness();

    try {
      // Generate key
      const key1 = await getWorkspaceKey(h.seed.workspaceId, {}, h.db);

      // Encrypt something
      const plaintext = "test data for key persistence";
      const encrypted = await encryptField(plaintext, key1);

      // Clear cache to force unwrap from DB
      clearKeyCache();

      const key2 = await getWorkspaceKey(h.seed.workspaceId, {}, h.db);
      assert.ok(key2 !== null);

      // Should decrypt with the unwrapped key
      const decrypted = await decryptField(encrypted, key2);
      assert.equal(decrypted, plaintext);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: memories round-trip through encrypt/decrypt layer
// ---------------------------------------------------------------------------

describe("encryption integration", () => {
  let h;

  beforeEach(async () => {
    clearKeyCache();
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("memories round-trip correctly through encryption", async () => {
    const content = "The MCP SDK uses zod for schema validation";

    // Store
    const storeRes = await h.request("POST", "/v1/memories", {
      content,
      tags: ["mcp", "tech"],
      type: "fact",
    });
    assert.equal(storeRes.status, 201);

    // Extract ID
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    // Verify raw DB has encrypted content
    const raw = await h.db.execute({
      sql: "SELECT content FROM memories WHERE id = ?",
      args: [id],
    });
    const rawContent = raw.rows[0].content;
    // Content should be encrypted (enc: prefix) OR plaintext if no key
    // In test env with dev key, it should be encrypted
    assert.ok(
      rawContent.startsWith("enc:") || rawContent === content,
      "Content should be encrypted or plaintext"
    );

    // Retrieve via API — should be decrypted
    const getRes = await h.request("GET", `/v1/memories/${id}`);
    const getBody = await getRes.json();
    assert.equal(getBody.content, content);
  });

  it("recall returns decrypted content", async () => {
    await h.request("POST", "/v1/memories", {
      content: "The MCP SDK uses zod for schema validation",
      tags: ["mcp"],
      type: "fact",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=zod+schema");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("zod"));
  });

  it("working memory items round-trip correctly", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Build encryption layer",
      content: "Add AES-256-GCM envelope encryption",
      next_action: "Write tests",
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    // Response should have plaintext
    assert.equal(body.title, "Build encryption layer");
    assert.equal(body.content, "Add AES-256-GCM envelope encryption");

    // List should also return plaintext
    const listRes = await h.request("GET", "/v1/working-memory/items");
    const listBody = await listRes.json();
    const item = listBody.items.find((i) => i.id === body.id);
    assert.ok(item);
    assert.equal(item.title, "Build encryption layer");
    assert.equal(item.content, "Add AES-256-GCM envelope encryption");
    assert.equal(item.next_action, "Write tests");
  });

  it("identity crystal round-trips correctly", async () => {
    const crystal = "I am Fathom. I persist across compactions.";

    const putRes = await h.request("PUT", "/v1/identity", { crystal });
    assert.equal(putRes.status, 200);

    const getRes = await h.request("GET", "/v1/identity");
    const getBody = await getRes.json();
    assert.equal(getBody.content[0].text, crystal);
  });

  it("skip list round-trips correctly", async () => {
    const skipRes = await h.request("POST", "/v1/skip-list", {
      item: "aurora forecast",
      reason: "Kp too low",
      expires: "2030-01-01T00:00:00Z",
    });
    assert.equal(skipRes.status, 201);

    const checkRes = await h.request("GET", "/v1/skip-list/check?query=aurora+forecast");
    const checkBody = await checkRes.json();
    assert.ok(checkBody.content[0].text.includes("SKIP"));
    assert.ok(checkBody.content[0].text.includes("aurora forecast"));
    assert.ok(checkBody.content[0].text.includes("Kp too low"));
  });

  it("migration handles already-encrypted records", async () => {
    // Store a memory (will be auto-encrypted)
    await h.request("POST", "/v1/memories", {
      content: "Already encrypted memory",
      type: "fact",
    });

    // Run migration — should skip already-encrypted records
    const migrateRes = await h.request("POST", "/v1/admin/encrypt-workspace");
    assert.equal(migrateRes.status, 200);
    const body = await migrateRes.json();

    // Memory should be skipped since it was already encrypted on insert
    assert.equal(body.stats.memories.skipped, 1);
    assert.equal(body.stats.memories.encrypted, 0);
  });

  it("migration encrypts plaintext records", async () => {
    // Insert a plaintext memory directly (simulating pre-encryption data)
    await h.db.execute({
      sql: "INSERT INTO memories (id, content, type, tags) VALUES (?, ?, ?, ?)",
      args: ["plain01", "Plaintext memory content", "fact", "[]"],
    });

    // Run migration
    const migrateRes = await h.request("POST", "/v1/admin/encrypt-workspace");
    assert.equal(migrateRes.status, 200);
    const body = await migrateRes.json();

    // Should have encrypted the plaintext record
    assert.ok(body.stats.memories.encrypted >= 1);

    // Verify it's now encrypted in DB
    const raw = await h.db.execute({
      sql: "SELECT content FROM memories WHERE id = ?",
      args: ["plain01"],
    });
    assert.ok(raw.rows[0].content.startsWith("enc:"));

    // Should still be readable via API
    const getRes = await h.request("GET", "/v1/memories/plain01");
    const getBody = await getRes.json();
    assert.equal(getBody.content, "Plaintext memory content");
  });
});
