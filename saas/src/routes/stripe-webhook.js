/**
 * Stripe webhook handler.
 *
 * Mounted at /webhooks/stripe — outside /v1 (no auth middleware).
 * Authentication is via Stripe signature verification instead.
 *
 * Handles subscription lifecycle events to manage user plans:
 *   - checkout.session.completed → upgrade to pro
 *   - customer.subscription.deleted → downgrade to free
 *   - customer.subscription.updated → handle status changes
 *   - invoice.payment_failed → log warning (Stripe retries automatically)
 */

import { Hono } from "hono";
import { verifyWebhookSignature } from "../services/stripe.js";
import { getControlDb } from "../db/connection.js";
import { logAuditEvent } from "../services/audit.js";

const stripeWebhook = new Hono();

stripeWebhook.post("/", async (c) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  // Read raw body for signature verification — must be the exact bytes Stripe sent
  const rawBody = await c.req.text();
  const sigHeader = c.req.header("stripe-signature");

  let event;
  try {
    const result = await verifyWebhookSignature(rawBody, sigHeader, webhookSecret);
    event = result.event;
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    logAuditEvent(null, "webhook.rejected", { details: "invalid signature" });
    return c.json({ error: "Invalid signature" }, 400);
  }

  const controlDb = getControlDb();

  // --- Idempotency: skip duplicate events (Stripe retries on timeout/error) ---
  const existing = await controlDb.execute({
    sql: "SELECT 1 FROM processed_webhook_events WHERE event_id = ?",
    args: [event.id],
  });
  if (existing.rows.length > 0) {
    console.log(`Duplicate webhook event ${event.id}, skipping`);
    return c.json({ received: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(controlDb, event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(controlDb, event.data.object);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(controlDb, event.data.object);
        break;

      case "invoice.payment_failed":
        console.warn(
          `Payment failed for customer ${event.data.object.customer}`,
          `invoice ${event.data.object.id}`
        );
        break;

      default:
        // Unhandled event type — acknowledge without processing
        break;
    }

    // Record successful processing for idempotency
    // TODO: Add scheduled cleanup of events older than 90 days in scheduler.js
    await controlDb.execute({
      sql: "INSERT INTO processed_webhook_events (event_id, event_type) VALUES (?, ?)",
      args: [event.id, event.type],
    });
  } catch (err) {
    // Log but still return 200 — Stripe will retry on non-2xx,
    // and a bug in our handler shouldn't cause infinite retries
    console.error(`Error handling ${event.type}:`, err);
  }

  // Always return 200 to Stripe
  return c.json({ received: true });
});

/**
 * Handle checkout.session.completed — upgrade user to pro.
 *
 * Uses client_reference_id (appended to payment link URL) to identify
 * the user. Stores Stripe customer ID and subscription ID for future
 * lifecycle events.
 */
async function handleCheckoutCompleted(db, session) {
  const userId = session.client_reference_id;
  if (!userId) {
    console.info("checkout.session.completed missing client_reference_id — likely a direct Stripe purchase without our flow");
    return;
  }

  // Validate payment actually completed
  if (session.payment_status !== "paid") {
    console.warn(`SECURITY: checkout for user ${userId} has payment_status '${session.payment_status}', not 'paid' — skipping upgrade`);
    return;
  }

  // Validate this is a subscription checkout, not a one-time payment
  if (session.mode !== "subscription") {
    console.warn(`SECURITY: checkout for user ${userId} has mode '${session.mode}', not 'subscription' — skipping upgrade`);
    return;
  }

  // Validate price ID if configured (Stripe payment links may not include line items in webhook)
  const expectedPriceId = process.env.STRIPE_PRO_PRICE_ID;
  if (expectedPriceId) {
    const priceId = session.metadata?.price_id;
    if (priceId && priceId !== expectedPriceId) {
      console.warn(`SECURITY: checkout for user ${userId} has price_id '${priceId}', expected '${expectedPriceId}' — skipping upgrade`);
      return;
    }
    if (!priceId) {
      console.info(`checkout for user ${userId}: no price_id in metadata (payment link flow) — validated payment_status and mode`);
    }
  } else {
    console.info("STRIPE_PRO_PRICE_ID not set — skipping price validation");
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const checkoutEmail = session.customer_details?.email || null;

  await db.execute({
    sql: `UPDATE users
          SET plan = 'pro',
              stripe_customer_id = ?,
              stripe_subscription_id = ?,
              email = CASE
                WHEN ? IS NOT NULL AND email LIKE '%@memento.local' THEN ?
                ELSE email
              END,
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [customerId, subscriptionId, checkoutEmail, checkoutEmail, userId],
  });

  logAuditEvent(db, "plan.upgraded", { userId, details: "free → pro" });
  console.log(`User ${userId} upgraded to pro (customer: ${customerId})`);
}

/**
 * Handle customer.subscription.deleted — downgrade user to free.
 *
 * This fires after all Stripe retry attempts are exhausted,
 * or when a subscription is explicitly canceled.
 */
async function handleSubscriptionDeleted(db, subscription) {
  const customerId = subscription.customer;

  const result = await db.execute({
    sql: `UPDATE users
          SET plan = 'free',
              stripe_subscription_id = NULL,
              updated_at = datetime('now')
          WHERE stripe_customer_id = ?`,
    args: [customerId],
  });

  if (result.rowsAffected === 0) {
    console.warn(`subscription.deleted: no user found for customer ${customerId}`);
    return;
  }

  logAuditEvent(db, "plan.downgraded", { details: "status: deleted" });
  console.log(`Customer ${customerId} downgraded to free (subscription deleted)`);
}

/**
 * Handle customer.subscription.updated — react to status changes.
 *
 * Covers all 8 Stripe subscription statuses:
 *   active, trialing        → ensure pro
 *   past_due, paused        → grace period (keep current plan)
 *   incomplete              → no upgrade (awaiting initial payment)
 *   canceled, unpaid,
 *   incomplete_expired      → downgrade to free
 *   (unknown)               → fail-safe downgrade to free
 */
async function handleSubscriptionUpdated(db, subscription) {
  const customerId = subscription.customer;
  const status = subscription.status;

  switch (status) {
    // Active states — ensure pro access
    case "active":
    case "trialing":
      await db.execute({
        sql: `UPDATE users
              SET plan = 'pro',
                  stripe_subscription_id = ?,
                  updated_at = datetime('now')
              WHERE stripe_customer_id = ?`,
        args: [subscription.id, customerId],
      });
      break;

    // Grace period — keep current plan, payment is being retried
    case "past_due":
    case "paused":
      console.warn(`Customer ${customerId} subscription is ${status} — grace period active`);
      break;

    // Initial payment incomplete — do NOT upgrade (e.g. 3D Secure pending)
    case "incomplete":
      console.warn(`Customer ${customerId} subscription incomplete — awaiting initial payment`);
      break;

    // Terminal states — downgrade to free
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      await db.execute({
        sql: `UPDATE users
              SET plan = 'free',
                  stripe_subscription_id = NULL,
                  updated_at = datetime('now')
              WHERE stripe_customer_id = ?`,
        args: [customerId],
      });
      logAuditEvent(db, "plan.downgraded", { details: `status: ${status}` });
      console.log(`Customer ${customerId} downgraded to free (status: ${status})`);
      break;

    // Unknown status — fail-safe downgrade (better to accidentally downgrade than grant access)
    default:
      await db.execute({
        sql: `UPDATE users
              SET plan = 'free',
                  stripe_subscription_id = NULL,
                  updated_at = datetime('now')
              WHERE stripe_customer_id = ?`,
        args: [customerId],
      });
      logAuditEvent(db, "plan.downgraded", { details: `status: ${status}` });
      console.warn(`Customer ${customerId}: unknown subscription status '${status}' — fail-safe downgrade to free`);
      break;
  }
}

export default stripeWebhook;
