/**
 * Tests for Stripe webhook integration.
 *
 * Covers signature verification, checkout upgrade, subscription deletion
 * downgrade, subscription status updates, and unknown event handling.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";
import { timingSafeEqual } from "../src/services/stripe.js";

/**
 * Build a valid Stripe webhook signature header.
 * Mirrors Stripe's signing: v1=hmac_sha256(timestamp.payload, secret)
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

describe("Stripe webhook", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.MEMENTO_ADMIN_USER_ID;
    h.cleanup();
  });

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  describe("signature verification", () => {
    it("rejects requests with missing Stripe-Signature header", async () => {
      const body = JSON.stringify({ type: "checkout.session.completed" });
      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
        })
      );
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, "Invalid signature");
    });

    it("rejects requests with invalid signature", async () => {
      const body = JSON.stringify({ type: "checkout.session.completed" });
      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": "t=123456,v1=invalidsignature",
          },
        })
      );
      assert.equal(res.status, 400);
    });

    it("accepts requests with valid signature", async () => {
      const event = {
        type: "invoice.payment_failed",
        data: { object: { id: "inv_123", customer: "cus_test" } },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.received, true);
    });
  });

  // -----------------------------------------------------------------------
  // checkout.session.completed → upgrade to pro
  // -----------------------------------------------------------------------

  describe("checkout.session.completed", () => {
    it("upgrades user to pro and stores Stripe IDs", async () => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: h.seed.userId,
            customer: "cus_test_123",
            subscription: "sub_test_456",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);

      // Verify user was upgraded
      const user = await h.db.execute({
        sql: "SELECT plan, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "pro");
      assert.equal(user.rows[0].stripe_customer_id, "cus_test_123");
      assert.equal(user.rows[0].stripe_subscription_id, "sub_test_456");
    });

    it("handles missing client_reference_id gracefully", async () => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_orphan",
            subscription: "sub_orphan",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      // Should still return 200 — don't cause Stripe retries
      assert.equal(res.status, 200);

      // User should NOT be modified
      const user = await h.db.execute({
        sql: "SELECT plan FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "free");
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.deleted → downgrade to free
  // -----------------------------------------------------------------------

  describe("customer.subscription.deleted", () => {
    it("downgrades user to free when subscription is deleted", async () => {
      // First set up user as pro with Stripe IDs
      await h.db.execute({
        sql: `UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_down_123', stripe_subscription_id = 'sub_down_456' WHERE id = ?`,
        args: [h.seed.userId],
      });

      const event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_down_456",
            customer: "cus_down_123",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);

      // Verify downgrade
      const user = await h.db.execute({
        sql: "SELECT plan, stripe_subscription_id FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "free");
      assert.equal(user.rows[0].stripe_subscription_id, null);
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.updated → status-based handling
  // -----------------------------------------------------------------------

  describe("customer.subscription.updated", () => {
    it("ensures pro on active status", async () => {
      // Set up user with Stripe customer ID but free plan (recovering from past_due)
      await h.db.execute({
        sql: `UPDATE users SET plan = 'free', stripe_customer_id = 'cus_upd_123' WHERE id = ?`,
        args: [h.seed.userId],
      });

      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_upd_456",
            customer: "cus_upd_123",
            status: "active",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);

      const user = await h.db.execute({
        sql: "SELECT plan FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "pro");
    });

    it("downgrades on canceled status", async () => {
      await h.db.execute({
        sql: `UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_canc_123', stripe_subscription_id = 'sub_canc_456' WHERE id = ?`,
        args: [h.seed.userId],
      });

      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_canc_456",
            customer: "cus_canc_123",
            status: "canceled",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);

      const user = await h.db.execute({
        sql: "SELECT plan, stripe_subscription_id FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "free");
      assert.equal(user.rows[0].stripe_subscription_id, null);
    });

    it("keeps pro on past_due (grace period)", async () => {
      await h.db.execute({
        sql: `UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_past_123', stripe_subscription_id = 'sub_past_456' WHERE id = ?`,
        args: [h.seed.userId],
      });

      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_past_456",
            customer: "cus_past_123",
            status: "past_due",
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);

      // User should STILL be pro
      const user = await h.db.execute({
        sql: "SELECT plan FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "pro");
    });
  });

  // -----------------------------------------------------------------------
  // Unknown events
  // -----------------------------------------------------------------------

  describe("unknown events", () => {
    it("returns 200 for unhandled event types", async () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_test" } },
      };
      const body = JSON.stringify(event);
      const { header } = await signPayload(body, TEST_WEBHOOK_SECRET);

      const res = await h.app.request(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": header,
          },
        })
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.received, true);
    });
  });

  // -----------------------------------------------------------------------
  // Admin plan endpoint lockdown
  // -----------------------------------------------------------------------

  describe("admin plan lockdown", () => {
    it("rejects non-admin plan changes with 403", async () => {
      process.env.MEMENTO_ADMIN_USER_ID = "some-other-user";
      const res = await h.request("PUT", "/v1/admin/plan", { plan: "pro" });
      assert.equal(res.status, 403);
    });

    it("allows admin to change plans", async () => {
      process.env.MEMENTO_ADMIN_USER_ID = h.seed.userId;
      const res = await h.request("PUT", "/v1/admin/plan", { plan: "pro" });
      assert.equal(res.status, 200);

      const user = await h.db.execute({
        sql: "SELECT plan FROM users WHERE id = ?",
        args: [h.seed.userId],
      });
      assert.equal(user.rows[0].plan, "pro");
    });

    it("allows admin to change another user's plan via user_id", async () => {
      // Create a second user
      const targetId = "target-user";
      await h.db.execute({
        sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
        args: [targetId, "target@example.com", "Target User"],
      });

      process.env.MEMENTO_ADMIN_USER_ID = h.seed.userId;
      const res = await h.request("PUT", "/v1/admin/plan", {
        plan: "full",
        user_id: targetId,
      });
      assert.equal(res.status, 200);

      const user = await h.db.execute({
        sql: "SELECT plan FROM users WHERE id = ?",
        args: [targetId],
      });
      assert.equal(user.rows[0].plan, "full");
    });
  });

  // -----------------------------------------------------------------------
  // timingSafeEqual utility
  // -----------------------------------------------------------------------

  describe("timingSafeEqual", () => {
    it("returns true for matching strings", () => {
      assert.equal(timingSafeEqual("abc123", "abc123"), true);
    });

    it("returns false for different strings", () => {
      assert.equal(timingSafeEqual("abc123", "abc124"), false);
    });

    it("returns false for different lengths", () => {
      assert.equal(timingSafeEqual("short", "longer_string"), false);
    });
  });
});
