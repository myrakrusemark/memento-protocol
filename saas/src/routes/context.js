/**
 * Context hook endpoint — THE PRODUCT.
 *
 * POST /v1/context — Single call that returns everything relevant for a message.
 * Replaces the entire hook chain: working memory + memory recall + skip check + identity.
 */

import { Hono } from "hono";
import { scoreAndRankMemories, hybridRank } from "../services/scoring.js";
import { semanticSearch } from "../services/embeddings.js";

const context = new Hono();

function safeParseTags(tagsStr) {
  try {
    return JSON.parse(tagsStr || "[]");
  } catch {
    return [];
  }
}

/**
 * Extract keywords from a message for memory matching.
 * Strips common stop words, returns lowercase terms.
 */
function extractKeywords(message) {
  const stopWords = new Set([
    "a", "an", "the", "is", "it", "in", "on", "at", "to", "for",
    "of", "and", "or", "but", "not", "with", "this", "that", "from",
    "by", "as", "be", "was", "were", "been", "are", "have", "has",
    "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "can", "i", "you", "we", "they", "he", "she",
    "my", "your", "our", "their", "what", "how", "when", "where",
    "why", "which", "who", "me", "him", "her", "us", "them",
  ]);

  return message
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

// POST /v1/context — The product endpoint
context.post("/", async (c) => {
  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");
  const body = await c.req.json();

  const message = body.message || "";
  const include = body.include || ["working_memory", "memories", "skip_list", "identity"];
  const now = new Date();
  const nowISO = now.toISOString();

  const result = { meta: { workspace: workspaceName, last_updated: nowISO } };

  // 1. Working memory items
  if (include.includes("working_memory")) {
    const itemsResult = await db.execute(
      `SELECT * FROM working_memory_items
       WHERE status IN ('active', 'paused')
       ORDER BY priority DESC, created_at DESC`
    );

    const totalResult = await db.execute(
      "SELECT COUNT(*) as count FROM working_memory_items WHERE status IN ('active', 'paused')"
    );

    result.working_memory = {
      items: itemsResult.rows.map((row) => ({
        ...row,
        tags: safeParseTags(row.tags),
      })),
      total_active: totalResult.rows[0].count,
    };
  }

  // 2. Memory recall — keyword scoring + optional semantic search (hybrid)
  if (include.includes("memories") && message) {
    const keywords = extractKeywords(message);

    const memoriesResult = await db.execute({
      sql: `SELECT id, content, type, tags, created_at, expires_at,
                   access_count, last_accessed_at, linkages
            FROM memories
            WHERE consolidated = 0
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC`,
      args: [nowISO],
    });

    // Keyword scoring (existing behavior)
    const keywordResults = scoreAndRankMemories(memoriesResult.rows, message, now, 20);

    // Semantic search (parallel, gracefully degrades to [])
    const vectorResults = await semanticSearch(c.env, workspaceName, message, 10);

    let topResults;
    let isHybrid = false;

    if (vectorResults.length > 0) {
      // Read alpha from workspace_settings (default 0.5)
      let alpha = 0.5;
      try {
        const alphaResult = await db.execute({
          sql: "SELECT value FROM workspace_settings WHERE key = 'recall_alpha'",
          args: [],
        });
        if (alphaResult.rows.length > 0) {
          const parsed = parseFloat(alphaResult.rows[0].value);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
            alpha = parsed;
          }
        }
      } catch {
        // Use default alpha
      }

      const hybridResults = hybridRank(keywordResults, vectorResults, alpha, 10);

      // Fetch memory objects for vector-only results (those without a memory object)
      for (const hr of hybridResults) {
        if (!hr.memory && hr.memoryId) {
          const memRow = await db.execute({
            sql: `SELECT id, content, type, tags, created_at, expires_at,
                         access_count, last_accessed_at, linkages
                  FROM memories WHERE id = ? AND consolidated = 0`,
            args: [hr.memoryId],
          });
          if (memRow.rows.length > 0) {
            hr.memory = memRow.rows[0];
          }
        }
      }

      // Filter out results where memory could not be fetched
      topResults = hybridResults
        .filter((hr) => hr.memory)
        .map((hr) => ({
          memory: hr.memory,
          score: hr.score,
          keywordScore: hr.keywordScore,
          vectorScore: hr.vectorScore,
        }));
      isHybrid = true;
    } else {
      // Pure keyword fallback (no vector bindings or no results)
      topResults = keywordResults;
    }

    // Log access for scored results (fire-and-forget)
    for (const r of topResults) {
      db.execute({
        sql: "INSERT INTO access_log (memory_id, query) VALUES (?, ?)",
        args: [r.memory.id, message.slice(0, 200)],
      }).catch(() => {});
      db.execute({
        sql: "UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
        args: [r.memory.id],
      }).catch(() => {});
    }

    const matches = topResults.map((r) => {
      const match = {
        id: r.memory.id,
        content: r.memory.content,
        type: r.memory.type,
        tags: safeParseTags(r.memory.tags),
        score: Math.round(r.score * 1000) / 1000,
      };
      if (isHybrid) {
        match.keyword_score = Math.round((r.keywordScore || 0) * 1000) / 1000;
        match.vector_score = Math.round((r.vectorScore || 0) * 1000) / 1000;
      }
      return match;
    });

    // If include_graph is requested, attach linkages to each match
    if (body.include_graph) {
      for (const match of matches) {
        const mem = topResults.find((r) => r.memory.id === match.id);
        if (mem?.memory?.linkages) {
          try {
            match.linkages = JSON.parse(mem.memory.linkages || "[]");
          } catch {
            match.linkages = [];
          }
        } else {
          match.linkages = [];
        }
      }
    }

    result.memories = {
      matches,
      query_terms: keywords,
      ranking: isHybrid ? "hybrid" : "keyword",
    };

    // Also count total memories for meta
    const countResult = await db.execute({
      sql: "SELECT COUNT(*) as count FROM memories WHERE consolidated = 0 AND (expires_at IS NULL OR expires_at > ?)",
      args: [nowISO],
    });
    result.meta.memory_count = countResult.rows[0].count;
  }

  // 3. Skip list check
  if (include.includes("skip_list") && message) {
    // Purge expired
    await db.execute({
      sql: "DELETE FROM skip_list WHERE expires_at <= ?",
      args: [nowISO],
    });

    const skipResult = await db.execute(
      "SELECT id, item, reason, expires_at FROM skip_list"
    );

    const keywords = extractKeywords(message);
    const skipMatches = [];

    for (const row of skipResult.rows) {
      const itemLower = row.item.toLowerCase();
      const matched = keywords.some((kw) => itemLower.includes(kw)) ||
        keywords.length > 0 && itemLower.split(/\s+/).some((word) =>
          message.toLowerCase().includes(word)
        );

      if (matched) {
        skipMatches.push({
          item: row.item,
          reason: row.reason,
          expires: row.expires_at,
        });
      }
    }

    result.skip_matches = skipMatches;
  }

  // 4. Identity crystal
  if (include.includes("identity")) {
    const identityResult = await db.execute(
      "SELECT crystal FROM identity_snapshots ORDER BY created_at DESC LIMIT 1"
    );

    result.identity = identityResult.rows.length > 0
      ? identityResult.rows[0].crystal
      : null;
  }

  return c.json(result);
});

export default context;
