/**
 * Tests for structured audit logging.
 *
 * Verifies that audit events are recorded for auth failures, plan changes,
 * key rotation, and that no PII appears in the details field.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

/**
 * Build a valid Stripe webhook signature header.
 */
async function signPayload(payload, secret, timestamp) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );
  const sig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { header: `t=${ts},v1=${sig}`, timestamp: ts };
}

const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests";

/**
 * Helper: get all audit log entries from the test DB.
 */
async function getAuditLog(db) {
  const result = await db.execute(
    "SELECT event_type, user_id, details, ip FROM audit_log ORDER BY id"
  );
  return result.rows;
}

describe("Audit logging", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    h.cleanup();
  });

  // -----------------------------------------------------------------------
  // Auth failure events
  // -----------------------------------------------------------------------

  describe("auth failures", () => {
    it("logs auth.failed for missing header", async () => {
      await h.app.request(
        new Request("http://localhost/v1/health", {
          headers: {},
        })
      );

      // Give fire-and-forget a moment
      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const authFailed = logs.filter((l) => l.event_type === "auth.failed");
      assert.ok(authFailed.length >= 1, "should log auth.failed");
      assert.equal(authFailed[0].details, "no header");
    });

    it("logs auth.failed for invalid key with key prefix", async () => {
      await h.app.request(
        new Request("http://localhost/v1/health", {
          headers: {
            Authorization: "Bearer mp_live_deadbeef1234567890abcdef12345678",
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const authFailed = logs.filter((l) => l.event_type === "auth.failed");
      assert.ok(authFailed.length >= 1);
      assert.ok(authFailed[0].details.startsWith("key prefix:"));
      // Verify no full key in details
      assert.ok(!authFailed[0].details.includes("deadbeef1234567890abcdef12345678"));
    });

    it("logs auth.revoked_key_used for revoked key", async () => {
      // Revoke the test key
      await h.db.execute({
        sql: "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?",
        args: [h.seed.apiKeyId],
      });

      await h.request("GET", "/v1/health");

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const revoked = logs.filter((l) => l.event_type === "auth.revoked_key_used");
      assert.ok(revoked.length >= 1, "should log auth.revoked_key_used");
      assert.equal(revoked[0].user_id, h.seed.userId);
      assert.ok(revoked[0].details.startsWith("key prefix:"));
    });
  });

  // -----------------------------------------------------------------------
  // Plan change events
  // -----------------------------------------------------------------------

  describe("plan changes", () => {
    it("logs plan.upgraded on checkout", async () => {
      const event = {
        id: "evt_audit_upgrade",
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: h.seed.userId,
            customer: "cus_audit_123",
            subscription: "sub_audit_456",
            payment_status: "paid",
            mode: "subscription",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const upgraded = logs.filter((l) => l.event_type === "plan.upgraded");
      assert.ok(upgraded.length >= 1, "should log plan.upgraded");
      assert.equal(upgraded[0].user_id, h.seed.userId);
      assert.ok(upgraded[0].details.includes("free → pro"));
    });

    it("logs plan.downgraded on subscription deleted", async () => {
      await h.db.execute({
        sql: `UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_audit_down', stripe_subscription_id = 'sub_audit_down' WHERE id = ?`,
        args: [h.seed.userId],
      });

      const event = {
        id: "evt_audit_downgrade",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_audit_down",
            customer: "cus_audit_down",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const downgraded = logs.filter((l) => l.event_type === "plan.downgraded");
      assert.ok(downgraded.length >= 1, "should log plan.downgraded");
      assert.ok(downgraded[0].details.includes("status: deleted"));
    });
  });

  // -----------------------------------------------------------------------
  // Key rotation events
  // -----------------------------------------------------------------------

  describe("key rotation", () => {
    it("logs key.rotated with old key prefix", async () => {
      const res = await h.request("POST", "/v1/auth/rotate");
      assert.equal(res.status, 200);

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      const rotated = logs.filter((l) => l.event_type === "key.rotated");
      assert.ok(rotated.length >= 1, "should log key.rotated");
      assert.equal(rotated[0].user_id, h.seed.userId);
      assert.ok(rotated[0].details.startsWith("old key prefix:"));
    });
  });

  // -----------------------------------------------------------------------
  // PII safety
  // -----------------------------------------------------------------------

  describe("PII safety", () => {
    it("never logs email addresses in details", async () => {
      // Trigger a checkout with email to generate audit events
      await h.db.execute({
        sql: "UPDATE users SET email = ? WHERE id = ?",
        args: [`anon_${h.seed.userId}@memento.local`, h.seed.userId],
      });

      const event = {
        id: "evt_audit_pii",
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: h.seed.userId,
            customer: "cus_pii_123",
            subscription: "sub_pii_456",
            payment_status: "paid",
            mode: "subscription",
            customer_details: { email: "secret@private.com" },
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      for (const log of logs) {
        if (log.details) {
          assert.ok(!log.details.includes("secret@private.com"), `PII leak in audit log: ${log.details}`);
          assert.ok(!log.details.includes("@memento.local"), `PII leak in audit log: ${log.details}`);
        }
      }
    });

    it("never logs full API keys in details", async () => {
      // Trigger rotation to generate audit events
      await h.request("POST", "/v1/auth/rotate");

      await new Promise((r) => setTimeout(r, 50));

      const logs = await getAuditLog(h.db);
      for (const log of logs) {
        if (log.details) {
          // Full keys are 40 chars — prefixes are 10-12 chars
          assert.ok(!log.details.includes(h.seed.apiKey), `Full API key leaked in audit log`);
        }
      }
    });
  });
});
