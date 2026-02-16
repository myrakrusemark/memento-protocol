/**
 * Identity crystallization service.
 *
 * Gathers working memory sections, top memories by relevance, and recent
 * consolidations to produce a structured "identity crystal" — a text
 * snapshot of the agent's current state. Stored in identity_snapshots
 * for retrieval as startup context.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Crystal generation (pure function)
// ---------------------------------------------------------------------------

/**
 * Build a structured text crystal from workspace data.
 *
 * @param {Array<{ section_key: string, heading: string, content: string }>} sections
 * @param {Array<{ id: string, content: string, type: string, tags: string }>} memories
 * @param {Array<{ id: string, summary: string, tags: string }>} consolidations
 * @returns {string} The formatted crystal text.
 */
export function generateCrystal(sections, memories, consolidations) {
  const timestamp = new Date().toISOString();
  const parts = [`# Identity Crystal\n\nGenerated: ${timestamp}`];

  // -- Working Memory sections --
  const nonEmpty = sections.filter((s) => s.content && s.content.trim().length > 0);
  if (nonEmpty.length > 0) {
    parts.push("## Working Memory");
    for (const s of nonEmpty) {
      parts.push(`### ${s.heading}\n${s.content}`);
    }
  }

  // -- Core Memories --
  if (memories.length > 0) {
    parts.push("---");
    parts.push(`## Core Memories (top ${memories.length} by relevance)`);

    const memBlocks = memories.map((m) => {
      let tags;
      try {
        tags = typeof m.tags === "string" ? JSON.parse(m.tags) : m.tags || [];
      } catch {
        tags = [];
      }
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return `**${m.id}** (${m.type})${tagStr}\n${m.content}`;
    });

    parts.push(memBlocks.join("\n\n"));
  }

  // -- Consolidated Patterns --
  if (consolidations.length > 0) {
    parts.push("---");
    parts.push("## Consolidated Patterns");

    const conBlocks = consolidations.map((c) => {
      let tags;
      try {
        tags = typeof c.tags === "string" ? JSON.parse(c.tags) : c.tags || [];
      } catch {
        tags = [];
      }
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return `**${c.id}**${tagStr}\n${c.summary}`;
    });

    parts.push(conBlocks.join("\n\n"));
  }

  // -- Source count footer --
  parts.push("---");
  parts.push(
    `Sources: ${nonEmpty.length} working memory sections, ${memories.length} memories, ${consolidations.length} consolidations`
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main crystallization entry point
// ---------------------------------------------------------------------------

/**
 * Run identity crystallization for a workspace.
 *
 * 1. Fetches all working memory sections
 * 2. Fetches top 30 memories by relevance (non-consolidated, non-expired)
 * 3. Fetches 10 most recent consolidations
 * 4. Generates a template-based crystal
 * 5. Stores in identity_snapshots
 * 6. Returns { id, crystal, sourceCount }
 *
 * @param {import("@libsql/client").Client} db - Workspace database client
 * @returns {Promise<{ id: string, crystal: string, sourceCount: number }>}
 */
export async function crystallizeIdentity(db) {
  const now = new Date().toISOString();

  // 1. Fetch all working memory sections
  const sectionsResult = await db.execute(
    "SELECT section_key, heading, content FROM working_memory_sections ORDER BY rowid"
  );
  const sections = sectionsResult.rows;

  // 2. Fetch top 30 memories by relevance (non-consolidated, non-expired)
  const memoriesResult = await db.execute({
    sql: `SELECT id, content, type, tags
          FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY relevance DESC
          LIMIT 30`,
    args: [now],
  });
  const memories = memoriesResult.rows;

  // 3. Fetch 10 most recent consolidations
  const consolidationsResult = await db.execute(
    "SELECT id, summary, tags FROM consolidations ORDER BY created_at DESC LIMIT 10"
  );
  const consolidations = consolidationsResult.rows;

  // 4. Count total sources
  const sourceCount = sections.length + memories.length + consolidations.length;

  // 5. Generate the crystal text
  const crystal = generateCrystal(sections, memories, consolidations);

  // 6. Store in identity_snapshots
  const id = randomUUID().slice(0, 8);
  await db.execute({
    sql: `INSERT INTO identity_snapshots (id, crystal, source_count, created_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [id, crystal, sourceCount],
  });

  return { id, crystal, sourceCount };
}
