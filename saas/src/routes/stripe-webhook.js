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
    return c.json({ error: "Invalid signature" }, 400);
  }

  const controlDb = getControlDb();

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
    console.error("checkout.session.completed missing client_reference_id");
    return;
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;

  await db.execute({
    sql: `UPDATE users
          SET plan = 'pro',
              stripe_customer_id = ?,
              stripe_subscription_id = ?,
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [customerId, subscriptionId, userId],
  });

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

  console.log(`Customer ${customerId} downgraded to free (subscription deleted)`);
}

/**
 * Handle customer.subscription.updated — react to status changes.
 *
 * - active/trialing → ensure pro
 * - canceled/unpaid → downgrade to free
 * - past_due → no action (grace period while Stripe retries)
 */
async function handleSubscriptionUpdated(db, subscription) {
  const customerId = subscription.customer;
  const status = subscription.status;

  if (status === "active" || status === "trialing") {
    await db.execute({
      sql: `UPDATE users
            SET plan = 'pro',
                stripe_subscription_id = ?,
                updated_at = datetime('now')
            WHERE stripe_customer_id = ?`,
      args: [subscription.id, customerId],
    });
  } else if (status === "canceled" || status === "unpaid") {
    await db.execute({
      sql: `UPDATE users
            SET plan = 'free',
                stripe_subscription_id = NULL,
                updated_at = datetime('now')
            WHERE stripe_customer_id = ?`,
      args: [customerId],
    });
    console.log(`Customer ${customerId} downgraded to free (status: ${status})`);
  } else if (status === "past_due") {
    // Grace period — user keeps pro access while Stripe retries payment
    console.warn(`Customer ${customerId} is past_due — grace period active`);
  }
}

export default stripeWebhook;
