#!/usr/bin/env node

/**
 * Memento Protocol — Reference MCP Server
 *
 * Persistent memory for AI agents. File-based, zero external dependencies
 * beyond the MCP SDK. Designed for Claude Code but works with any
 * MCP-compatible client.
 *
 * Storage layout:
 *   .memento/
 *   ├── working-memory.md    — The core document. Read every session.
 *   ├── memories/            — Discrete stored memories (JSON per entry)
 *   └── skip-index.json      — Queryable skip list index
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the memento workspace path. */
function workspacePath(customPath) {
  return path.resolve(customPath || path.join(process.cwd(), ".memento"));
}

/** Read a file, return null if missing. Throws on non-ENOENT errors. */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Ensure a directory exists. */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Read the skip index. Returns an array of skip entries. */
function readSkipIndex(ws) {
  const raw = readFileSafe(path.join(ws, "skip-index.json"));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Write the skip index. */
function writeSkipIndex(ws, entries) {
  fs.writeFileSync(path.join(ws, "skip-index.json"), JSON.stringify(entries, null, 2), "utf-8");
}

/** Purge expired skip entries. Returns cleaned list. */
function purgeExpiredSkips(entries) {
  const now = new Date();
  return entries.filter((e) => new Date(e.expires) > now);
}

/**
 * Extract a named section from the working memory markdown.
 * Sections are delimited by `## Section Name` headings.
 * Returns the content between the heading and the next `---` or `##`.
 */
function extractSection(markdown, sectionName) {
  const pattern = new RegExp(
    `^## ${escapeRegex(sectionName)}\\s*\\n([\\s\\S]*?)(?=\\n---\\s*\\n|\\n## |(?![\\s\\S]))`,
    "m"
  );
  const match = markdown.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Replace a named section's content in the working memory markdown.
 */
function replaceSection(markdown, sectionName, newContent) {
  const pattern = new RegExp(
    `(^## ${escapeRegex(sectionName)}\\s*\\n)([\\s\\S]*?)(?=\\n---\\s*\\n|\\n## |(?![\\s\\S]))`,
    "m"
  );
  const match = markdown.match(pattern);
  if (!match) {
    // Section not found — append it
    return markdown.trimEnd() + `\n\n---\n\n## ${sectionName}\n\n${newContent}\n`;
  }
  return markdown.replace(pattern, `$1\n${newContent}\n`);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Map section shorthand names to actual heading text. */
const SECTION_MAP = {
  active_work: "Active Work",
  standing_decisions: "Standing Decisions",
  skip_list: "Skip List",
  activity_log: "Activity Log",
  session_notes: "Session Notes",
};

function resolveSectionName(key) {
  return SECTION_MAP[key] || key;
}

// ---------------------------------------------------------------------------
// Auto-detect workspace
// ---------------------------------------------------------------------------

/**
 * Walk up from cwd looking for an existing .memento/ directory.
 * Falls back to cwd/.memento if none found.
 */
function detectWorkspace() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".memento");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".memento");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "memento-protocol",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: memento_init
// ---------------------------------------------------------------------------

/**
 * Initialize a new Memento workspace.
 * Creates the storage directory structure and working memory from template.
 */
server.tool(
  "memento_init",
  "Initialize a new Memento workspace with working memory template and storage directories",
  {
    path: z.string().optional().describe("Workspace path (default: .memento/ in cwd)"),
  },
  async ({ path: customPath }) => {
    const ws = workspacePath(customPath);

    if (fs.existsSync(path.join(ws, "working-memory.md"))) {
      return {
        content: [
          {
            type: "text",
            text: `Workspace already exists at ${ws}. Use memento_read to load it.`,
          },
        ],
      };
    }

    ensureDir(ws);
    ensureDir(path.join(ws, "memories"));

    // Copy template
    const templatePath = path.join(__dirname, "..", "templates", "working-memory.md");
    const template = readFileSafe(templatePath);
    if (!template) {
      return {
        content: [
          {
            type: "text",
            text: `Error: template not found at ${templatePath}`,
          },
        ],
        isError: true,
      };
    }

    fs.writeFileSync(path.join(ws, "working-memory.md"), template, "utf-8");
    writeSkipIndex(ws, []);

    return {
      content: [
        {
          type: "text",
          text: `Memento workspace initialized at ${ws}\n\nCreated:\n  working-memory.md\n  memories/\n  skip-index.json\n\nRead working-memory.md at the start of every session.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_read
// ---------------------------------------------------------------------------

/**
 * Read the full working memory document, or a specific section.
 */
server.tool(
  "memento_read",
  "Read working memory — the full document or a specific section",
  {
    section: z
      .string()
      .optional()
      .describe(
        "Section to read: active_work, standing_decisions, skip_list, activity_log, session_notes"
      ),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ section, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();
    const wmPath = path.join(ws, "working-memory.md");
    const content = readFileSafe(wmPath);

    if (!content) {
      return {
        content: [
          {
            type: "text",
            text: `No working memory found at ${wmPath}. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    if (section) {
      const heading = resolveSectionName(section);
      const extracted = extractSection(content, heading);
      if (extracted === null) {
        return {
          content: [
            {
              type: "text",
              text: `Section "${heading}" not found in working memory.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `## ${heading}\n\n${extracted}` }],
      };
    }

    return { content: [{ type: "text", text: content }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_update
// ---------------------------------------------------------------------------

/**
 * Update a specific section of working memory.
 */
server.tool(
  "memento_update",
  "Update a section of working memory (active_work, standing_decisions, skip_list, activity_log, session_notes)",
  {
    section: z
      .string()
      .describe(
        "Section to update: active_work, standing_decisions, skip_list, activity_log, session_notes"
      ),
    content: z.string().describe("New content for the section"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ section, content, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();
    const wmPath = path.join(ws, "working-memory.md");
    const existing = readFileSafe(wmPath);

    if (!existing) {
      return {
        content: [
          {
            type: "text",
            text: `No working memory found at ${wmPath}. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    const heading = resolveSectionName(section);
    const updated = replaceSection(existing, heading, content);
    fs.writeFileSync(wmPath, updated, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `Updated section "${heading}" in working memory.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_store
// ---------------------------------------------------------------------------

/**
 * Store a discrete memory with metadata.
 */
server.tool(
  "memento_store",
  "Store a discrete memory (fact, decision, observation, instruction) with tags and optional expiration",
  {
    content: z.string().describe("The memory content"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    type: z
      .enum(["fact", "decision", "observation", "instruction"])
      .optional()
      .describe("Memory type (default: observation)"),
    expires: z.string().optional().describe("ISO date string when this memory expires"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ content, tags, type, expires, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();
    const memoriesDir = path.join(ws, "memories");

    if (!fs.existsSync(memoriesDir)) {
      return {
        content: [
          {
            type: "text",
            text: `Memories directory not found. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    const id = randomUUID().slice(0, 8);
    const memory = {
      id,
      content,
      type: type || "observation",
      tags: tags || [],
      created: new Date().toISOString(),
      expires: expires || null,
    };

    fs.writeFileSync(
      path.join(memoriesDir, `${id}.json`),
      JSON.stringify(memory, null, 2),
      "utf-8"
    );

    return {
      content: [
        {
          type: "text",
          text: `Stored memory ${id} (${memory.type})${memory.tags.length ? ` [${memory.tags.join(", ")}]` : ""}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_recall
// ---------------------------------------------------------------------------

/**
 * Search stored memories by keyword and/or tag.
 * Simple keyword matching — no vectors, no relevance scoring.
 */
server.tool(
  "memento_recall",
  "Search stored memories by keyword, tag, or type",
  {
    query: z.string().describe("Search query (matched against memory content)"),
    tags: z.array(z.string()).optional().describe("Filter by tags (matches any)"),
    type: z
      .string()
      .optional()
      .describe("Filter by type: fact, decision, observation, instruction"),
    limit: z.number().optional().describe("Max results (default: 10)"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ query, tags, type, limit, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();
    const memoriesDir = path.join(ws, "memories");

    if (!fs.existsSync(memoriesDir)) {
      return {
        content: [
          {
            type: "text",
            text: `No memories directory found. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    const files = fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".json"));
    const maxResults = limit || 10;
    const now = new Date();
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    const results = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(memoriesDir, file), "utf-8");
        const memory = JSON.parse(raw);

        // Skip expired
        if (memory.expires && new Date(memory.expires) < now) continue;

        // Filter by type
        if (type && memory.type !== type) continue;

        // Filter by tags (match any)
        if (tags && tags.length > 0) {
          const memTags = (memory.tags || []).map((mt) => mt.toLowerCase());
          const hasTag = tags.some((t) => memTags.includes(t.toLowerCase()));
          if (!hasTag) continue;
        }

        // Keyword match — count how many query terms appear in content
        const contentLower = memory.content.toLowerCase();
        const hits = queryTerms.filter((term) => contentLower.includes(term)).length;
        if (hits === 0) continue;

        results.push({ memory, score: hits / queryTerms.length });
      } catch {
        // Skip malformed files
      }
    }

    // Sort by score descending, then by created descending
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.memory.created) - new Date(a.memory.created);
    });

    const topResults = results.slice(0, maxResults);

    if (topResults.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found matching "${query}".` }],
      };
    }

    const formatted = topResults
      .map((r) => {
        const m = r.memory;
        const tagStr = m.tags && m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const expStr = m.expires ? ` (expires: ${m.expires})` : "";
        return `**${m.id}** (${m.type})${tagStr}${expStr}\n${m.content}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${topResults.length} memor${topResults.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_skip_add
// ---------------------------------------------------------------------------

/**
 * Add an item to the skip list.
 * Skip list = anti-memory. Things the agent should NOT do right now.
 */
server.tool(
  "memento_skip_add",
  "Add an item to the skip list — things to NOT do right now, with expiration",
  {
    item: z.string().describe("What to skip"),
    reason: z.string().describe("Why it should be skipped"),
    expires: z.string().describe("When this skip expires (ISO date string, e.g. '2026-02-20')"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ item, reason, expires, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();

    if (!fs.existsSync(ws)) {
      return {
        content: [
          {
            type: "text",
            text: `Workspace not found at ${ws}. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    const entries = readSkipIndex(ws);
    entries.push({
      id: randomUUID().slice(0, 8),
      item,
      reason,
      expires,
      added: new Date().toISOString(),
    });
    writeSkipIndex(ws, entries);

    // Also update the skip list section in working memory
    const wmPath = path.join(ws, "working-memory.md");
    const wm = readFileSafe(wmPath);
    if (wm) {
      const activeEntries = purgeExpiredSkips(entries);
      const tableRows = activeEntries
        .map((e) => `| ${e.item} | ${e.reason} | ${e.expires} |`)
        .join("\n");
      const tableContent = `| Skip | Reason | Expires |\n|------|--------|---------|${tableRows ? "\n" + tableRows : ""}`;
      const updated = replaceSection(wm, "Skip List", tableContent);
      fs.writeFileSync(wmPath, updated, "utf-8");
    }

    return {
      content: [
        {
          type: "text",
          text: `Added to skip list: "${item}" (expires ${expires})`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_skip_check
// ---------------------------------------------------------------------------

/**
 * Check if something should be skipped. Auto-clears expired entries.
 */
server.tool(
  "memento_skip_check",
  "Check if a topic/action is on the skip list. Auto-clears expired entries.",
  {
    query: z.string().describe("What to check against the skip list"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ query, path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();

    if (!fs.existsSync(ws)) {
      return {
        content: [
          {
            type: "text",
            text: `Workspace not found at ${ws}. Run memento_init first.`,
          },
        ],
        isError: true,
      };
    }

    let entries = readSkipIndex(ws);
    const before = entries.length;
    entries = purgeExpiredSkips(entries);

    // Write back if we purged anything
    if (entries.length !== before) {
      writeSkipIndex(ws, entries);
    }

    const queryLower = query.toLowerCase();
    const match = entries.find(
      (e) => e.item.toLowerCase().includes(queryLower) || queryLower.includes(e.item.toLowerCase())
    );

    if (match) {
      return {
        content: [
          {
            type: "text",
            text: `SKIP: "${match.item}"\nReason: ${match.reason}\nExpires: ${match.expires}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Not on skip list. Proceed with "${query}".` }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_health
// ---------------------------------------------------------------------------

/**
 * Report memory system health and stats.
 */
server.tool(
  "memento_health",
  "Report memory system health — stats, staleness, expired entries",
  {
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ path: customPath }) => {
    const ws = customPath ? workspacePath(customPath) : detectWorkspace();

    if (!fs.existsSync(ws)) {
      return {
        content: [
          {
            type: "text",
            text: `No workspace found at ${ws}. Run memento_init to create one.`,
          },
        ],
        isError: true,
      };
    }

    const stats = { workspace: ws };

    // Working memory
    const wmPath = path.join(ws, "working-memory.md");
    if (fs.existsSync(wmPath)) {
      const wmStat = fs.statSync(wmPath);
      stats.workingMemory = {
        lastModified: wmStat.mtime.toISOString(),
        sizeBytes: wmStat.size,
      };
      const hoursSinceUpdate = (Date.now() - wmStat.mtime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceUpdate > 24) {
        stats.workingMemory.stale = true;
        stats.workingMemory.stalenessWarning = `Working memory hasn't been updated in ${Math.round(hoursSinceUpdate)} hours.`;
      }
    } else {
      stats.workingMemory = { missing: true };
    }

    // Memories
    const memoriesDir = path.join(ws, "memories");
    if (fs.existsSync(memoriesDir)) {
      const files = fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".json"));
      let expired = 0;
      const now = new Date();
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(memoriesDir, file), "utf-8");
          const m = JSON.parse(raw);
          if (m.expires && new Date(m.expires) < now) expired++;
        } catch {
          // skip
        }
      }
      stats.memories = {
        total: files.length,
        expired,
        active: files.length - expired,
      };
    } else {
      stats.memories = { total: 0 };
    }

    // Skip list
    const skipEntries = readSkipIndex(ws);
    const activeSkips = purgeExpiredSkips(skipEntries);
    stats.skipList = {
      total: skipEntries.length,
      active: activeSkips.length,
      expired: skipEntries.length - activeSkips.length,
    };

    // Format output
    const lines = [
      `**Memento Health Report**`,
      `Workspace: ${stats.workspace}`,
      ``,
      `**Working Memory**`,
    ];

    if (stats.workingMemory.missing) {
      lines.push(`  Status: MISSING — run memento_init`);
    } else {
      lines.push(`  Last modified: ${stats.workingMemory.lastModified}`);
      lines.push(`  Size: ${stats.workingMemory.sizeBytes} bytes`);
      if (stats.workingMemory.stale) {
        lines.push(`  ⚠ ${stats.workingMemory.stalenessWarning}`);
      }
    }

    lines.push(``);
    lines.push(`**Stored Memories**`);
    lines.push(
      `  Total: ${stats.memories.total} (${stats.memories.active || 0} active, ${stats.memories.expired || 0} expired)`
    );

    lines.push(``);
    lines.push(`**Skip List**`);
    lines.push(
      `  Total: ${stats.skipList.total} (${stats.skipList.active} active, ${stats.skipList.expired} expired)`
    );

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start the server when run directly (not when imported for testing)
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main().catch((err) => {
    console.error("Memento server failed to start:", err);
    process.exit(1);
  });
}

// Exported for testing
export {
  workspacePath,
  readFileSafe,
  ensureDir,
  readSkipIndex,
  writeSkipIndex,
  purgeExpiredSkips,
  extractSection,
  replaceSection,
  escapeRegex,
  detectWorkspace,
  SECTION_MAP,
  resolveSectionName,
  server,
  main,
};
