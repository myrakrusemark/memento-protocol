/**
 * Memory consolidation service.
 *
 * Groups related memories by tag overlap using a union-find (connected
 * components) approach, then generates summaries (AI-powered when
 * available, template-based as fallback) and creates consolidation
 * records. Source memories are marked as consolidated but never deleted.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Union-Find helpers
// ---------------------------------------------------------------------------

/**
 * Create a union-find structure.
 * @returns {{ find: (x: string) => string, union: (a: string, b: string) => void }}
 */
function createUnionFind() {
  const parent = new Map();
  const rank = new Map();

  function find(x) {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x))); // path compression
    }
    return parent.get(x);
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;

    const rankA = rank.get(rootA);
    const rankB = rank.get(rootB);

    if (rankA < rankB) {
      parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      parent.set(rootB, rootA);
    } else {
      parent.set(rootB, rootA);
      rank.set(rootA, rankA + 1);
    }
  }

  return { find, union };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Find consolidation groups among the given memories using tag overlap.
 *
 * Two memories belong to the same group if they share at least one tag.
 * Grouping is transitive: if A shares a tag with B, and B shares a tag
 * with C, then A, B, and C are in the same group.
 *
 * @param {Array<{ id: string, content: string, type: string, tags: string[], created_at: string }>} memories
 * @returns {Array<Array<{ id: string, content: string, type: string, tags: string[], created_at: string }>>}
 *   Groups with 3+ members, each group being an array of memory objects.
 */
export function findConsolidationGroups(memories) {
  // Filter out memories with no tags
  const tagged = memories.filter((m) => Array.isArray(m.tags) && m.tags.length > 0);

  if (tagged.length === 0) return [];

  const uf = createUnionFind();

  // Build adjacency: for each unique tag, collect memory IDs that have it.
  // Union all memories sharing the same tag.
  const tagToIds = new Map();

  for (const mem of tagged) {
    for (const tag of mem.tags) {
      const normalizedTag = tag.toLowerCase();
      if (!tagToIds.has(normalizedTag)) {
        tagToIds.set(normalizedTag, []);
      }
      tagToIds.get(normalizedTag).push(mem.id);
    }
  }

  for (const ids of tagToIds.values()) {
    for (let i = 1; i < ids.length; i++) {
      uf.union(ids[0], ids[i]);
    }
  }

  // Collect groups by root
  const groups = new Map();

  for (const mem of tagged) {
    const root = uf.find(mem.id);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(mem);
  }

  // Only return groups with 3+ members
  return Array.from(groups.values()).filter((g) => g.length >= 3);
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a template-based summary for a group of related memories.
 *
 * @param {Array<{ id: string, content: string, type: string, tags: string[], created_at: string }>} group
 * @returns {string} The formatted summary string.
 */
export function generateSummary(group) {
  // Collect all unique tags from the group
  const allTags = new Set();
  for (const mem of group) {
    if (Array.isArray(mem.tags)) {
      for (const tag of mem.tags) {
        allTags.add(tag);
      }
    }
  }

  const tagList = Array.from(allTags).sort();
  const header = `[${tagList.join(", ")}] \u2014 ${group.length} memories consolidated`;

  const bullets = group
    .map((mem) => `\u2022 ${mem.content} (${mem.type}, ${mem.created_at})`)
    .join("\n");

  return `${header}\n\n${bullets}`;
}

// ---------------------------------------------------------------------------
// AI-powered summary generation
// ---------------------------------------------------------------------------

/**
 * Generate an AI-powered summary for a group of related memories.
 * Uses Workers AI (@cf/meta/llama-3.1-8b-instruct) when available,
 * falls back to template-based summary on failure or missing binding.
 *
 * @param {object} env - Workers environment (must have env.AI for AI summaries)
 * @param {Array<{ id: string, content: string, type: string, tags: string[], created_at: string }>} group
 * @returns {Promise<{ summary: string, method: "ai"|"template" }>}
 */
export async function generateAISummary(env, group) {
  // Check AI binding
  if (!env || !env.AI) {
    return { summary: generateSummary(group), method: "template" };
  }

  try {
    const memoriesText = group.map((m, i) => {
      const tags = Array.isArray(m.tags) ? m.tags.join(", ") : "";
      return `${i + 1}. ${m.content} (type: ${m.type}, tags: [${tags}])`;
    }).join("\n");

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content: "You are a memory consolidation system. Synthesize related memories into concise, actionable summaries. Focus on key insights, decisions, and patterns. Be specific, not generic. Write 2-3 paragraphs.",
        },
        {
          role: "user",
          content: `Synthesize these ${group.length} related memories:\n\n${memoriesText}`,
        },
      ],
      max_tokens: 500,
    });

    if (result && result.response) {
      return { summary: result.response, method: "ai" };
    }
    // Fallback
    return { summary: generateSummary(group), method: "template" };
  } catch {
    return { summary: generateSummary(group), method: "template" };
  }
}

// ---------------------------------------------------------------------------
// Main consolidation entry point
// ---------------------------------------------------------------------------

/**
 * Run consolidation on a workspace's memories.
 *
 * 1. Fetches all non-consolidated, non-expired memories
 * 2. Parses their tags from JSON strings to arrays
 * 3. Finds consolidation groups (3+ memories sharing tags)
 * 4. For each group: creates a consolidation record (AI or template summary), marks source memories
 * 5. Returns { consolidated: number of groups, created: total memories consolidated }
 *
 * @param {import("@libsql/client").Client} db - Workspace database client
 * @param {object} [env] - Workers environment (optional; enables AI summaries when env.AI is present)
 * @returns {Promise<{ consolidated: number, created: number }>}
 */
export async function consolidateMemories(db, env) {
  const now = new Date().toISOString();

  // 1. Fetch all non-consolidated, non-expired memories
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at
          FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)`,
    args: [now],
  });

  if (result.rows.length === 0) {
    return { consolidated: 0, created: 0 };
  }

  // 2. Parse tags from JSON strings to arrays
  const memories = result.rows.map((row) => {
    let tags;
    try {
      tags = JSON.parse(row.tags || "[]");
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      content: row.content,
      type: row.type,
      tags,
      created_at: row.created_at,
    };
  });

  // 3. Find consolidation groups
  const groups = findConsolidationGroups(memories);

  if (groups.length === 0) {
    return { consolidated: 0, created: 0 };
  }

  let totalMemories = 0;

  // 4. For each group: create consolidation record, mark sources
  for (const group of groups) {
    const consolidationId = randomUUID().slice(0, 8);
    const templateSummary = generateSummary(group);
    const { summary, method } = await generateAISummary(env, group);
    const sourceIds = group.map((m) => m.id);

    // Collect union of all tags
    const allTags = new Set();
    for (const mem of group) {
      for (const tag of mem.tags) {
        allTags.add(tag);
      }
    }

    // Insert consolidation record
    await db.execute({
      sql: `INSERT INTO consolidations (id, summary, source_ids, tags, type, method, template_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        consolidationId,
        summary,
        JSON.stringify(sourceIds),
        JSON.stringify(Array.from(allTags).sort()),
        "auto",
        method,
        templateSummary,
      ],
    });

    // Mark source memories as consolidated
    for (const mem of group) {
      await db.execute({
        sql: `UPDATE memories SET consolidated = 1, consolidated_into = ? WHERE id = ?`,
        args: [consolidationId, mem.id],
      });
    }

    totalMemories += group.length;
  }

  return { consolidated: groups.length, created: totalMemories };
}
