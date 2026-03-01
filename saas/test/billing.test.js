/**
 * Tests for billing upgrade flow.
 *
 * Covers pre-checkout (public), checkout (authenticated), status,
 * rate limiting, and edge cases.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, createTestDb, seedTestData } from "./setup.js";
import { setTestDb } from "../src/db/connection.js";
import { createApp } from "../src/server.js";
import { resetBillingRateLimits } from "../src/routes/billing.js";

const TEST_PAYMENT_LINK = "https://buy.stripe.com/test_abc123";

// ---------------------------------------------------------------------------
// POST /v1/billing/pre-checkout (public, no auth)
// ---------------------------------------------------------------------------

describe("POST /v1/billing/pre-checkout", () => {
  let h;

  beforeEach(async () => {
    resetBillingRateLimits();
    h = await createTestHarness();
    process.env.STRIPE_PAYMENT_LINK_URL = TEST_PAYMENT_LINK;
  });

  afterEach(() => {
    delete process.env.STRIPE_PAYMENT_LINK_URL;
    h.cleanup();
  });

  async function preCheckout(body) {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return h.app.request(
      new Request("http://localhost/v1/billing/pre-checkout", init)
    );
  }

  it("rejects missing body", async () => {
    const res = await h.app.request(
      new Request("http://localhost/v1/billing/pre-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    assert.equal(res.status, 400);
  });

  it("rejects missing api_key", async () => {
    const res = await preCheckout({});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "Invalid API key format");
  });

  it("rejects invalid api_key format", async () => {
    const res = await preCheckout({ api_key: "not-a-valid-key" });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "Invalid API key format");
  });

  it("rejects api_key with wrong prefix", async () => {
    const res = await preCheckout({
      api_key: "mp_fake_0123456789abcdef0123456789abcdef",
    });
    assert.equal(res.status, 400);
  });

  it("rejects unknown api_key with 401", async () => {
    const res = await preCheckout({
      api_key: "mp_test_0123456789abcdef0123456789abcdef",
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "Invalid API key");
  });

  it("returns checkout URL for valid free user", async () => {
    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.url, "should return a URL");
    assert.ok(
      data.url.startsWith(TEST_PAYMENT_LINK),
      "URL starts with payment link"
    );
    assert.ok(
      data.url.includes(`client_reference_id=${h.seed.userId}`),
      "URL includes userId"
    );
  });

  it("returns already_subscribed for pro user", async () => {
    await h.db.execute({
      sql: "UPDATE users SET plan = 'pro' WHERE id = ?",
      args: [h.seed.userId],
    });

    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.already_subscribed, true);
    assert.equal(data.plan, "pro");
    assert.ok(data.limits, "should include limits");
  });

  it("returns already_subscribed for full user", async () => {
    await h.db.execute({
      sql: "UPDATE users SET plan = 'full' WHERE id = ?",
      args: [h.seed.userId],
    });

    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.already_subscribed, true);
    assert.equal(data.plan, "full");
  });

  it("rate limits after 5 requests", async () => {
    for (let i = 0; i < 5; i++) {
      await preCheckout({ api_key: h.seed.apiKey });
    }

    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.error, "rate_limited");
  });

  it("returns 503 when STRIPE_PAYMENT_LINK_URL is not configured", async () => {
    delete process.env.STRIPE_PAYMENT_LINK_URL;

    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, "Billing not configured");
  });

  it("rejects revoked api key", async () => {
    await h.db.execute({
      sql: "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?",
      args: [h.seed.apiKeyId],
    });

    const res = await preCheckout({ api_key: h.seed.apiKey });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/billing/checkout (authenticated)
// ---------------------------------------------------------------------------

describe("GET /v1/billing/checkout", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
    process.env.STRIPE_PAYMENT_LINK_URL = TEST_PAYMENT_LINK;
  });

  afterEach(() => {
    delete process.env.STRIPE_PAYMENT_LINK_URL;
    h.cleanup();
  });

  it("returns checkout URL for free user", async () => {
    const res = await h.request("GET", "/v1/billing/checkout");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.url);
    assert.ok(data.url.includes(`client_reference_id=${h.seed.userId}`));
  });

  it("returns already_subscribed for pro user", async () => {
    await h.db.execute({
      sql: "UPDATE users SET plan = 'pro' WHERE id = ?",
      args: [h.seed.userId],
    });

    const res = await h.request("GET", "/v1/billing/checkout");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.already_subscribed, true);
    assert.equal(data.plan, "pro");
  });

  it("requires authentication", async () => {
    const res = await h.request("GET", "/v1/billing/checkout", undefined, {
      Authorization: undefined,
    });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/billing/status (authenticated)
// ---------------------------------------------------------------------------

describe("GET /v1/billing/status", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("returns free plan info by default", async () => {
    const res = await h.request("GET", "/v1/billing/status");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, "free");
    assert.deepEqual(data.limits, { memories: 100, items: 20, workspaces: 1 });
    assert.equal(data.has_subscription, false);
    assert.ok(data.member_since);
  });

  it("returns pro plan info for upgraded user", async () => {
    await h.db.execute({
      sql: `UPDATE users SET plan = 'pro', stripe_subscription_id = 'sub_test' WHERE id = ?`,
      args: [h.seed.userId],
    });

    const res = await h.request("GET", "/v1/billing/status");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, "pro");
    assert.deepEqual(data.limits, {
      memories: 1000,
      items: 100,
      workspaces: 5,
    });
    assert.equal(data.has_subscription, true);
  });

  it("requires authentication", async () => {
    const res = await h.request("GET", "/v1/billing/status", undefined, {
      Authorization: undefined,
    });
    assert.equal(res.status, 401);
  });
});
