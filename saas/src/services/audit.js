/**
 * Structured audit logging — fire-and-forget, never fails the request.
 *
 * Events are written to the control plane audit_log table.
 * No PII (emails, full keys) should ever appear in the details field.
 */

import { getControlDb } from "../db/connection.js";

/**
 * Log an audit event. Fire-and-forget — never blocks or fails the caller.
 *
 * @param {import("@libsql/client").Client} db - Control plane database client
 * @param {string} eventType - Event identifier (e.g. "auth.failed", "plan.upgraded")
 * @param {object} [opts]
 * @param {string} [opts.userId] - User ID associated with the event
 * @param {string} [opts.details] - Human-readable details (no PII)
 * @param {string} [opts.ip] - Request IP address
 */
export function logAuditEvent(db, eventType, { userId, details, ip } = {}) {
  (db || getControlDb())
    .execute({
      sql: "INSERT INTO audit_log (event_type, user_id, details, ip) VALUES (?, ?, ?, ?)",
      args: [eventType, userId || null, details || null, ip || null],
    })
    .catch((err) => console.error("Audit log write failed:", err.message));
}
