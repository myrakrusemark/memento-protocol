/**
 * Relevance scoring service.
 *
 * Combined score = keyword * recency * accessBoost * lastAccessRecency
 *
 * - Keyword (0-1): fraction of query terms found in content + tags
 * - Recency (0-1): exponential decay with 7-day half-life
 * - Access boost (1.0-2.0): log2-based lift from access_count
 * - Last-access recency (1.0-1.5): temporary boost for memories accessed in last 48h
 */

/**
 * Parse a JSON tags string into a lowercase array.
 * Returns [] on invalid JSON.
 */
function parseTags(tagsStr) {
  try {
    return JSON.parse(tagsStr || "[]").map((t) => String(t).toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Score a single memory against a set of query terms.
 *
 * @param {object} memory - { content, tags, created_at, access_count, last_accessed_at }
 * @param {string[]} queryTerms - Lowercase query terms
 * @param {Date} now - Current timestamp (for deterministic testing)
 * @returns {number} Combined relevance score. 0 if no keyword match.
 */
export function scoreMemory(memory, queryTerms, now) {
  // --- Keyword score (0-1) — gate: zero match = zero final score ---
  if (!queryTerms.length) {
    // No query terms means we skip keyword gating — used by decay service
    return recencyScore(memory.created_at, now) *
           accessBoostScore(memory.access_count) *
           lastAccessRecencyScore(memory.last_accessed_at, now);
  }

  const contentLower = (memory.content || "").toLowerCase();
  const tags = parseTags(memory.tags);
  const searchable = contentLower + " " + tags.join(" ");

  const hits = queryTerms.filter((term) => searchable.includes(term)).length;
  const keyword = hits / queryTerms.length;

  if (keyword === 0) return 0;

  const recency = recencyScore(memory.created_at, now);
  const accessBoost = accessBoostScore(memory.access_count);
  const lastAccess = lastAccessRecencyScore(memory.last_accessed_at, now);

  return keyword * recency * accessBoost * lastAccess;
}

/**
 * Recency score: exponential decay with 7-day (168h) half-life.
 * @returns {number} 0-1
 */
function recencyScore(createdAt, now) {
  if (!createdAt) return 1.0;
  const ageHours = (now.getTime() - new Date(createdAt).getTime()) / 3_600_000;
  if (ageHours <= 0) return 1.0;
  return Math.pow(0.5, ageHours / 168);
}

/**
 * Access boost: 1 + log2(1 + accessCount) * 0.3, capped at 2.0.
 * @returns {number} 1.0-2.0
 */
function accessBoostScore(accessCount) {
  const count = accessCount || 0;
  return Math.min(2.0, 1 + Math.log2(1 + count) * 0.3);
}

/**
 * Last-access recency: temporary boost for recently accessed memories.
 * 1 + 0.5 * pow(0.5, hoursSinceLastAccess / 48). Falls off after 48h.
 * @returns {number} 1.0-1.5
 */
function lastAccessRecencyScore(lastAccessedAt, now) {
  if (!lastAccessedAt) return 1.0;
  const hoursSince = (now.getTime() - new Date(lastAccessedAt).getTime()) / 3_600_000;
  if (hoursSince < 0) return 1.5;
  return 1 + 0.5 * Math.pow(0.5, hoursSince / 48);
}

/**
 * Score and rank an array of memories against a query string.
 *
 * @param {object[]} memories - Array of memory row objects
 * @param {string} query - Raw query string
 * @param {Date} now - Current timestamp
 * @param {number} limit - Max results to return
 * @returns {Array<{ memory: object, score: number }>} Sorted by score desc
 */
export function scoreAndRankMemories(memories, query, now, limit) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = [];
  for (const memory of memories) {
    const score = scoreMemory(memory, queryTerms, now);
    if (score > 0) {
      scored.push({ memory, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak: newer first
    return new Date(b.memory.created_at) - new Date(a.memory.created_at);
  });

  return scored.slice(0, limit);
}

/**
 * Merge keyword and vector search results using weighted reciprocal rank fusion.
 *
 * @param {Array<{memory: object, score: number}>} keywordResults - From scoreAndRankMemories
 * @param {Array<{id: string, score: number}>} vectorResults - From semanticSearch
 * @param {number} [alpha=0.5] - Weight for keyword score (1-alpha for vector)
 * @param {number} [limit=10] - Max results to return
 * @returns {Array<{memory: object|null, score: number, keywordScore: number, vectorScore: number, memoryId: string}>}
 *   Sorted by final score desc. `memory` is null for vector-only results (caller fetches from DB).
 */
export function hybridRank(keywordResults, vectorResults, alpha = 0.5, limit = 10) {
  // Normalize keyword scores to 0-1
  const maxKeyword = keywordResults.length > 0
    ? Math.max(...keywordResults.map((r) => r.score))
    : 1;

  // Normalize vector scores to 0-1
  const maxVector = vectorResults.length > 0
    ? Math.max(...vectorResults.map((r) => r.score))
    : 1;

  // Build merged map: memoryId -> { memory, keywordScore, vectorScore }
  const merged = new Map();

  for (const kr of keywordResults) {
    const id = kr.memory.id;
    merged.set(id, {
      memoryId: id,
      memory: kr.memory,
      keywordScore: maxKeyword > 0 ? kr.score / maxKeyword : 0,
      vectorScore: 0,
    });
  }

  for (const vr of vectorResults) {
    const id = vr.id;
    const normalizedVector = maxVector > 0 ? vr.score / maxVector : 0;

    if (merged.has(id)) {
      merged.get(id).vectorScore = normalizedVector;
    } else {
      // Vector-only result — memory is null, caller must fetch from DB
      merged.set(id, {
        memoryId: id,
        memory: null,
        keywordScore: 0,
        vectorScore: normalizedVector,
      });
    }
  }

  // Compute final score and sort
  const results = [];
  for (const entry of merged.values()) {
    entry.score = alpha * entry.keywordScore + (1 - alpha) * entry.vectorScore;
    results.push(entry);
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak: higher vector score first (semantic relevance)
    return b.vectorScore - a.vectorScore;
  });

  return results.slice(0, limit);
}
