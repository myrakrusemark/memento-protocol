/**
 * Memory decay service.
 *
 * Runs as a background job to recalculate the `relevance` column for all
 * active memories. Uses the same exponential-decay formula as the scoring
 * service but without the keyword component (keyword is query-time only).
 *
 * Relevance = recency * accessBoost * lastAccessRecency
 */

import { scoreMemory } from "./scoring.js";

/**
 * Calculate the decay factor for a given creation time.
 * Exponential decay: 0.5^(ageHours / halfLifeHours).
 *
 * @param {string|Date} createdAt - Memory creation timestamp
 * @param {Date} now - Current timestamp
 * @param {number} halfLifeHours - Half-life in hours (default: 168 = 7 days)
 * @returns {number} Decay factor between 0 and 1
 */
export function decayFactor(createdAt, now, halfLifeHours = 168) {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ageHours = (now.getTime() - created.getTime()) / 3_600_000;
  if (ageHours <= 0) return 1.0;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/**
 * Apply decay to all non-consolidated, non-expired memories in the database.
 * Recalculates the `relevance` column using recency * accessBoost * lastAccessRecency
 * (no keyword component — that's query-time only).
 *
 * @param {import("@libsql/client").Client} db - Workspace database client
 * @param {Date} [now] - Current timestamp (defaults to new Date())
 * @returns {Promise<{ decayed: number }>} Count of memories that had decay applied
 */
export async function applyDecay(db, now) {
  const timestamp = now || new Date();
  const nowIso = timestamp.toISOString();

  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, access_count, last_accessed_at, relevance
          FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)`,
    args: [nowIso],
  });

  let decayed = 0;

  for (const row of result.rows) {
    // scoreMemory with empty queryTerms array — skips keyword gate,
    // returns recency * accessBoost * lastAccessRecency
    const newRelevance = scoreMemory(row, [], timestamp);

    // Only update if value actually changed (avoid unnecessary writes)
    const oldRelevance = row.relevance ?? 1.0;
    if (Math.abs(newRelevance - oldRelevance) > 0.0001) {
      await db.execute({
        sql: "UPDATE memories SET relevance = ? WHERE id = ?",
        args: [newRelevance, row.id],
      });
      decayed++;
    }
  }

  return { decayed };
}
