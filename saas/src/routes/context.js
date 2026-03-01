/**
 * Context hook endpoint — THE PRODUCT.
 *
 * POST /v1/context — Single call that returns everything relevant for a message.
 * Replaces the entire hook chain: working memory + memory recall + skip check + identity.
 */

import { Hono } from "hono";
import { scoreAndRankMemories, hybridRank } from "../services/scoring.js";
import { semanticSearch } from "../services/embeddings.js";
import { decryptField, encryptField, getWorkspaceKey } from "../services/crypto.js";
import { getControlDb, getWorkspaceDb } from "../db/connection.js";
import { extractMemories } from "../services/extraction.js";

const context = new Hono();

const BUFFER_CHAR_THRESHOLD = 20_000;

const SEED_EXTRACTION_PROMPT = `You extract relational and experiential memories from conversations — the human texture that makes relationships real.

Extract ONLY:
- Personal plans, hopes, intentions with specific details
- Emotional shifts — tone changes, excitement, hesitation, humor
- Preferences, tastes, dislikes
- Surprises or things that landed unexpectedly
- Names + relationship context (who someone is to who)
- Birthdays, anniversaries, recurring events
- Sensory details — what something looked/sounded/felt like

Do NOT extract:
- Technical facts, code decisions, system configurations
- Operational instructions or task progress
- Anything in the existing memories below
- Generic statements ("we talked about coffee")
- Status updates or work logs

Each memory: vivid, specific, one sentence, with proper nouns and context.
Type: "fact", "preference", or "observation" only.
Max 3 memories. Return [] if nothing seed-worthy.
Return ONLY valid JSON array — no markdown, no code fences.

Output format:
[{"content": "...", "type": "preference", "tags": ["tag1", "tag2"]}]`;

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
  const trackAccess = body.track_access !== false;
  const now = new Date();
  const nowISO = now.toISOString();

  const encKey = c.get("encryptionKey");
  const result = { meta: { workspace: workspaceName, last_updated: nowISO } };

  // --- Resolve peek workspaces from body (POST doesn't use query params) ---
  let peekDbs = c.get("peekDbs"); // may already be set by middleware from query/header
  const bodyPeekWorkspaces = Array.isArray(body.peek_workspaces) ? body.peek_workspaces : [];

  if (!peekDbs && bodyPeekWorkspaces.length > 0) {
    if (bodyPeekWorkspaces.length > 5) {
      return c.json({ error: "Too many peek workspaces. Maximum is 5." }, 400);
    }

    const userId = c.get("userId");
    const controlDb = getControlDb();
    peekDbs = new Map();

    for (const name of bodyPeekWorkspaces) {
      if (typeof name !== "string" || !name.trim()) continue;
      const trimmed = name.trim();
      const peekResult = await controlDb.execute({
        sql: "SELECT id, db_url, db_token FROM workspaces WHERE user_id = ? AND name = ?",
        args: [userId, trimmed],
      });
      if (peekResult.rows.length === 0) continue;

      const peekRow = peekResult.rows[0];
      const peekWsDb = getWorkspaceDb(peekRow.db_url, peekRow.db_token);
      const peekEncKey = await getWorkspaceKey(peekRow.id, c.env, controlDb).catch(() => null);
      peekDbs.set(trimmed, { db: peekWsDb, encKey: peekEncKey });
    }
  }

  const peekedWorkspaceNames = peekDbs ? [...peekDbs.keys()] : [];
  if (peekedWorkspaceNames.length > 0) {
    result.meta.peeked_workspaces = peekedWorkspaceNames;
  }

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

    const decryptedItems = [];
    for (const row of itemsResult.rows) {
      decryptedItems.push({
        ...row,
        title: encKey ? await decryptField(row.title, encKey) : row.title,
        content: encKey ? await decryptField(row.content, encKey) : row.content,
        next_action: row.next_action && encKey ? await decryptField(row.next_action, encKey) : row.next_action,
        tags: safeParseTags(row.tags),
      });
    }

    // Merge peeked workspace items
    if (peekDbs && peekDbs.size > 0) {
      for (const [wsName, { db: peekDb, encKey: peekEncKey }] of peekDbs) {
        const peekItemsResult = await peekDb.execute(
          `SELECT * FROM working_memory_items
           WHERE status IN ('active', 'paused')
           ORDER BY priority DESC, created_at DESC`
        );

        for (const row of peekItemsResult.rows) {
          decryptedItems.push({
            ...row,
            title: peekEncKey ? await decryptField(row.title, peekEncKey) : row.title,
            content: peekEncKey ? await decryptField(row.content, peekEncKey) : row.content,
            next_action: row.next_action && peekEncKey ? await decryptField(row.next_action, peekEncKey) : row.next_action,
            tags: safeParseTags(row.tags),
            workspace: wsName,
          });
        }
      }

      // Re-sort merged items
      decryptedItems.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return new Date(b.created_at) - new Date(a.created_at);
      });
    }

    result.working_memory = {
      items: decryptedItems,
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

    // Decrypt content for scoring
    if (encKey) {
      for (const row of memoriesResult.rows) {
        row.content = await decryptField(row.content, encKey);
      }
    }

    // Keyword scoring (existing behavior)
    const keywordResults = scoreAndRankMemories(memoriesResult.rows, message, now, 20);

    // Apply recall_threshold: filter out keyword results below the configured minimum score
    const thresholdResult = await db.execute({
      sql: "SELECT value FROM workspace_settings WHERE key = 'recall_threshold'",
      args: [],
    });
    const threshold = parseFloat(thresholdResult.rows[0]?.value ?? "0") || 0;
    const filteredKeyword = threshold > 0 ? keywordResults.filter((r) => r.score >= threshold) : keywordResults;

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

      const hybridResults = hybridRank(filteredKeyword, vectorResults, alpha, 10);

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
            const mem = memRow.rows[0];
            if (encKey) {
              mem.content = await decryptField(mem.content, encKey);
            }
            hr.memory = mem;
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
      topResults = filteredKeyword;
    }

    // --- Merge peeked workspace memories ---
    if (peekDbs && peekDbs.size > 0) {
      for (const [wsName, { db: peekDb, encKey: peekEncKey }] of peekDbs) {
        const peekMemResult = await peekDb.execute({
          sql: `SELECT id, content, type, tags, created_at, expires_at,
                       access_count, last_accessed_at, linkages
                FROM memories
                WHERE consolidated = 0
                  AND (expires_at IS NULL OR expires_at > ?)
                ORDER BY created_at DESC`,
          args: [nowISO],
        });

        if (peekEncKey) {
          for (const row of peekMemResult.rows) {
            row.content = await decryptField(row.content, peekEncKey);
          }
        }

        // Tag each row with the workspace
        for (const row of peekMemResult.rows) {
          row._peekWorkspace = wsName;
        }

        const peekScored = scoreAndRankMemories(peekMemResult.rows, message, now, 20);
        for (const r of peekScored) {
          r.memory._peekWorkspace = wsName;
          topResults.push(r);
        }
      }

      // Re-sort and limit merged results
      topResults.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.memory.created_at) - new Date(a.memory.created_at);
      });
      topResults = topResults.slice(0, 20);
    }

    // Log access for scored results (fire-and-forget) — local workspace only
    // Skip when track_access: false — used by benchmarks to avoid contaminating scores.
    if (trackAccess) {
      for (const r of topResults) {
        if (r.memory._peekWorkspace) continue;
        db.execute({
          sql: "INSERT INTO access_log (memory_id, query) VALUES (?, ?)",
          args: [r.memory.id, message.slice(0, 200)],
        }).catch(() => {});
        db.execute({
          sql: "UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
          args: [r.memory.id],
        }).catch(() => {});
      }
    }

    const matches = topResults.map((r) => {
      const match = {
        id: r.memory.id,
        content: r.memory.content,
        type: r.memory.type,
        tags: safeParseTags(r.memory.tags),
        score: Math.round(r.score * 1000) / 1000,
        created_at: r.memory.created_at || null,
      };
      if (isHybrid) {
        match.keyword_score = Math.round((r.keywordScore || 0) * 1000) / 1000;
        match.vector_score = Math.round((r.vectorScore || 0) * 1000) / 1000;
      }
      if (r.memory._peekWorkspace) {
        match.workspace = r.memory._peekWorkspace;
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

  // 3. Skip list check (LOCAL ONLY — no peek)
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
      const decItem = encKey ? await decryptField(row.item, encKey) : row.item;
      const decReason = encKey ? await decryptField(row.reason, encKey) : row.reason;
      const itemLower = decItem.toLowerCase();
      const matched = keywords.some((kw) => itemLower.includes(kw)) ||
        keywords.length > 0 && itemLower.split(/\s+/).some((word) =>
          message.toLowerCase().includes(word)
        );

      if (matched) {
        skipMatches.push({
          item: decItem,
          reason: decReason,
          expires: row.expires_at,
        });
      }
    }

    result.skip_matches = skipMatches;
  }

  // 4. Identity crystal (LOCAL ONLY — no peek)
  if (include.includes("identity")) {
    const identityResult = await db.execute(
      "SELECT crystal FROM identity_snapshots ORDER BY created_at DESC LIMIT 1"
    );

    if (identityResult.rows.length > 0) {
      result.identity = encKey
        ? await decryptField(identityResult.rows[0].crystal, encKey)
        : identityResult.rows[0].crystal;
    } else {
      result.identity = null;
    }
  }

  // 5. Auto-extraction — buffer conversation turns, extract seeds when threshold hit
  if (body.auto_extract === true && message) {
    // Check workspace setting
    let autoExtractEnabled = false;
    try {
      const settingResult = await db.execute({
        sql: "SELECT value FROM workspace_settings WHERE key = 'auto_extract_enabled'",
        args: [],
      });
      autoExtractEnabled = settingResult.rows[0]?.value === "true";
    } catch {
      // Table might not exist yet — skip
    }

    if (autoExtractEnabled) {
      const role = body.extract_role === "assistant" ? "assistant" : "user";
      const charCount = message.length;

      // Ensure conversation_buffer table exists
      try {
        await db.execute(
          `CREATE TABLE IF NOT EXISTS conversation_buffer (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            char_count INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`
        );
      } catch {
        // Already exists — fine
      }

      // Append message to buffer (encrypt if workspace has key)
      const bufferedContent = encKey ? await encryptField(message, encKey) : message;
      await db.execute({
        sql: "INSERT INTO conversation_buffer (role, content, char_count, created_at) VALUES (?, ?, ?, ?)",
        args: [role, bufferedContent, charCount, nowISO],
      });

      // Check total buffer size
      const sizeResult = await db.execute(
        "SELECT SUM(char_count) as total_chars, COUNT(*) as row_count FROM conversation_buffer"
      );
      const totalChars = sizeResult.rows[0]?.total_chars || 0;

      if (totalChars >= BUFFER_CHAR_THRESHOLD) {
        // Read all buffered messages, format as transcript
        const bufferRows = await db.execute(
          "SELECT role, content, created_at FROM conversation_buffer ORDER BY created_at ASC, id ASC"
        );

        const transcriptLines = [];
        for (const row of bufferRows.rows) {
          const plainContent = encKey ? await decryptField(row.content, encKey) : row.content;
          const label = row.role === "assistant" ? "Assistant" : "User";
          transcriptLines.push(`${label}: ${plainContent}`);
        }
        const transcript = transcriptLines.join("\n\n");

        // Run extraction
        const { stored, error } = await extractMemories({
          env: c.env,
          db,
          workspaceName,
          encKey,
          transcript,
          systemPrompt: SEED_EXTRACTION_PROMPT,
          maxMemories: 3,
          dedupLimit: 10,
          maxTokens: 400,
          sourceTag: "source:auto-extract",
        });

        // Clear buffer regardless of extraction result
        await db.execute("DELETE FROM conversation_buffer");

        result.extracted = stored;
        result.buffer_status = { chars: 0, threshold: BUFFER_CHAR_THRESHOLD, just_extracted: true };

        if (error) {
          result.extraction_error = error;
        }
      } else {
        result.extracted = [];
        result.buffer_status = { chars: totalChars, threshold: BUFFER_CHAR_THRESHOLD };
      }
    } else {
      result.extracted = [];
      result.buffer_status = { enabled: false };
    }
  }

  return c.json(result);
});

export default context;
