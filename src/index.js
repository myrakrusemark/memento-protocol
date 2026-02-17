#!/usr/bin/env node

/**
 * Memento Protocol -- Reference MCP Server
 *
 * Persistent memory for AI agents. File-based, zero external dependencies
 * beyond the MCP SDK. Designed for Claude Code but works with any
 * MCP-compatible client.
 *
 * Storage layout:
 *   .memento/
 *   ├── working-memory.md    -- The core document. Read every session.
 *   ├── memories/            -- Discrete stored memories (JSON per entry)
 *   └── skip-index.json      -- Queryable skip list index
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStorageAdapter } from "./storage/local.js";
import { HostedStorageAdapter } from "./storage/hosted.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Storage adapter — switches based on environment variables
// ---------------------------------------------------------------------------

let storage;
if (process.env.MEMENTO_API_KEY) {
  storage = new HostedStorageAdapter({
    apiKey: process.env.MEMENTO_API_KEY,
    apiUrl: process.env.MEMENTO_API_URL || "http://localhost:3001",
    workspace: process.env.MEMENTO_WORKSPACE || "default",
  });
} else {
  storage = new LocalStorageAdapter();
}

/** Whether we're running in hosted mode (API key is set). */
const isHosted = !!process.env.MEMENTO_API_KEY;

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
    // Section not found -- append it
    return markdown.trimEnd() + `\n\n---\n\n## ${sectionName}\n\n${newContent}\n`;
  }
  return markdown.replace(pattern, `$1\n${newContent}\n`);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if all words in `query` appear somewhere in `text`.
 * Case-insensitive. Used for skip-check matching.
 */
function matchesAllWords(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return false;
  const textLower = text.toLowerCase();
  return queryWords.every((word) => textLower.includes(word));
}

/** Map section shorthand names to actual heading text. */
const SECTION_MAP = {
  active_work: "Active Work",
  standing_decisions: "Standing Decisions",
  skip_list: "Skip List",
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

/** Resolve workspace path from tool arguments. */
function resolveWs(customPath) {
  return customPath ? workspacePath(customPath) : detectWorkspace();
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

server.tool(
  "memento_init",
  `Initialize a new Memento workspace. Only needed once per project — creates the working memory structure and storage directories.

After initializing, run memento_health to verify, then start creating items with memento_item_create.`,
  {
    path: z.string().optional().describe("Workspace path (default: .memento/ in cwd)"),
  },
  async ({ path: customPath }) => {
    const ws = isHosted ? null : workspacePath(customPath);
    const result = await storage.initWorkspace(ws);

    if (result.error) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    if (result.alreadyExists) {
      const location = isHosted ? "(hosted)" : ws;
      return {
        content: [
          {
            type: "text",
            text: `Workspace already exists at ${location}. Use memento_read to load it.`,
          },
        ],
      };
    }

    const location = isHosted ? "(hosted)" : ws;
    return {
      content: [
        {
          type: "text",
          text: isHosted
            ? `Memento workspace initialized at ${location}.\n\nRead working memory at the start of every session.`
            : `Memento workspace initialized at ${location}\n\nCreated:\n  working-memory.md\n  memories/\n  skip-index.json\n\nRead working-memory.md at the start of every session.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_read
// ---------------------------------------------------------------------------

server.tool(
  "memento_read",
  `Read the working memory document — the full markdown or a specific section. This is the legacy markdown-based working memory; for structured data, prefer memento_item_list.

Sections: active_work, standing_decisions, skip_list, session_notes.`,
  {
    section: z
      .string()
      .optional()
      .describe(
        "Section to read: active_work, standing_decisions, skip_list, session_notes"
      ),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ section, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.readWorkingMemory(ws, section);

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: result.content }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_update
// ---------------------------------------------------------------------------

server.tool(
  "memento_update",
  `Update a section of the working memory markdown document. For structured items, prefer memento_item_update instead.

Sections: active_work, standing_decisions, skip_list, session_notes.`,
  {
    section: z
      .string()
      .describe(
        "Section to update: active_work, standing_decisions, skip_list, session_notes"
      ),
    content: z.string().describe("New content for the section"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ section, content, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.updateWorkingMemory(ws, section, content);

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated section "${result.heading}" in working memory.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_store
// ---------------------------------------------------------------------------

server.tool(
  "memento_store",
  `Store a discrete memory — a fact, decision, observation, or instruction — with tags and optional expiration.

IMPORTANT: Write memories as instructions, not logs.
- GOOD: "Skip aurora checks until Kp > 4 or Feb 20."
- BAD: "Checked aurora, Kp was 2.3, quiet."
The test: could a future agent, with zero context, read this memory and know exactly what to do?

Use tags generously — they power recall. Set expiration for time-sensitive facts.`,
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
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.storeMemory(ws, { content, tags, type, expires });

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Stored memory ${result.id} (${result.type})${result.tags.length ? ` [${result.tags.join(", ")}]` : ""}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_recall
// ---------------------------------------------------------------------------

server.tool(
  "memento_recall",
  `Search stored memories by keyword, tag, or type. Use this before starting work on any topic — someone may have already figured it out.

Results are ranked by relevance (keyword match + recency + access frequency). Each recall increments the memory's access count, reinforcing important memories and letting unused ones decay naturally.`,
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
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.recallMemories(ws, { query, tags, type, limit });

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    if (result.results.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found matching "${result.query}".` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.count} memor${result.count === 1 ? "y" : "ies"}:\n\n${result.formatted}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_skip_add
// ---------------------------------------------------------------------------

server.tool(
  "memento_skip_add",
  `Add an item to the skip list — anti-memory. Things to NOT investigate, NOT re-read, NOT act on right now.

Every skip MUST have an expiration. Skips are temporary by design — conditions change. If something should be permanently ignored, archive or delete it instead.

Examples: "Skip aurora until Kp > 4" (expires in 3 days), "Skip HN post about X" (expires tomorrow).`,
  {
    item: z.string().describe("What to skip"),
    reason: z.string().describe("Why it should be skipped"),
    expires: z.string().describe("When this skip expires (ISO date string, e.g. '2026-02-20')"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ item, reason, expires, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.addSkip(ws, { item, reason, expires });

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Added to skip list: "${result.item}" (expires ${result.expires})`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_skip_check
// ---------------------------------------------------------------------------

server.tool(
  "memento_skip_check",
  `Check if a topic is on the skip list before investigating it. Auto-clears expired entries.

Use this before routine checks (news, weather, HN stories) to avoid re-reading things you've already covered. If the skip list says stop, stop — trust past-you's judgment.`,
  {
    query: z.string().describe("What to check against the skip list"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ query, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.checkSkip(ws, query);

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    if (result.match) {
      return {
        content: [
          {
            type: "text",
            text: `SKIP: "${result.match.item}"\nReason: ${result.match.reason}\nExpires: ${result.match.expires}`,
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

server.tool(
  "memento_health",
  `Report memory system health. Run this FIRST at the start of every session — it tells you how many items, memories, and skip entries exist, and when things were last updated.

Boot sequence: (1) memento_health → (2) memento_item_list for active_work and skip_list → (3) memento_recall for the current task. Then start working.`,
  {
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.getHealth(ws);

    // Passthrough for hosted adapter
    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.formatted }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_item_create
// ---------------------------------------------------------------------------

server.tool(
  "memento_item_create",
  `Create a structured working memory item. Categories:
- active_work: Current projects and tasks with next actions
- standing_decision: Permanent rules and policies (e.g., "all code changes via agents")
- skip_list: Things to NOT do right now (use memento_skip_add for time-expiring skips)
- waiting_for: Blocked items awaiting external input
- session_note: Ephemeral notes for the current session only

Always include tags — they power search. Use next_action to tell future-you exactly what to do next. Priority is 0-10 (higher = more important).`,
  {
    category: z
      .enum(["active_work", "standing_decision", "skip_list", "waiting_for", "session_note"])
      .describe("Item category"),
    title: z.string().describe("Item title"),
    content: z.string().optional().describe("Item content/details"),
    status: z
      .enum(["active", "paused", "completed", "archived"])
      .optional()
      .describe("Item status (default: active)"),
    priority: z.number().optional().describe("Priority (higher = more important, default: 0)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    next_action: z.string().optional().describe("Next action to take"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ category, title, content, status, priority, tags, next_action, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.createItem(ws, {
      category,
      title,
      content,
      status,
      priority,
      tags,
      next_action,
    });

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    const tagStr = result.tags?.length ? ` [${result.tags.join(", ")}]` : "";
    return {
      content: [
        {
          type: "text",
          text: `Created item ${result.id} in ${result.category}: "${result.title}"${tagStr}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_item_update
// ---------------------------------------------------------------------------

server.tool(
  "memento_item_update",
  `Update a working memory item — partial update, only provided fields change. Use this to track progress:
- Update next_action when you make progress ("Last: checked Feb 16. Next: tomorrow.")
- Change status: active → paused (deprioritized), completed (done), archived (no longer relevant)
- Move between categories if an item's nature changes

When updating next_action, include what was done AND what comes next — this is how future-you avoids repeating work.`,
  {
    id: z.string().describe("Item ID to update"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New content"),
    category: z
      .enum(["active_work", "standing_decision", "skip_list", "waiting_for", "session_note"])
      .optional()
      .describe("New category"),
    status: z
      .enum(["active", "paused", "completed", "archived"])
      .optional()
      .describe("New status"),
    priority: z.number().optional().describe("New priority"),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
    next_action: z.string().optional().describe("New next action"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ id, title, content, category, status, priority, tags, next_action, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = content;
    if (category !== undefined) data.category = category;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (tags !== undefined) data.tags = tags;
    if (next_action !== undefined) data.next_action = next_action;

    const result = await storage.updateItem(ws, id, data);

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated item ${id}: "${result.title}" (${result.status})`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_item_delete
// ---------------------------------------------------------------------------

server.tool(
  "memento_item_delete",
  `Permanently delete a working memory item. Prefer archiving (status: archived) over deletion — archived items are hidden from default views but preserved for history. Only delete items created in error or containing incorrect information.`,
  {
    id: z.string().describe("Item ID to delete"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ id, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.deleteItem(ws, id);

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [{ type: "text", text: `Deleted item ${id}.` }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_item_list
// ---------------------------------------------------------------------------

server.tool(
  "memento_item_list",
  `List working memory items with optional filters. Use this to orient yourself at the start of a session:
- No filters: see everything active
- category=skip_list: check what to avoid before routine work
- category=active_work: see current projects and their next actions
- category=standing_decision: review permanent rules and policies
- status=completed: see what's been finished recently`,
  {
    category: z
      .enum(["active_work", "standing_decision", "skip_list", "waiting_for", "session_note"])
      .optional()
      .describe("Filter by category"),
    status: z
      .enum(["active", "paused", "completed", "archived"])
      .optional()
      .describe("Filter by status"),
    query: z.string().optional().describe("Search title and content"),
    path: z.string().optional().describe("Workspace path (auto-detected if omitted)"),
  },
  async ({ category, status, query, path: customPath }) => {
    const ws = isHosted ? null : resolveWs(customPath);
    const result = await storage.listItems(ws, { category, status, query });

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    if (!result.items || result.items.length === 0) {
      return {
        content: [{ type: "text", text: "No working memory items found." }],
      };
    }

    const formatted = result.items
      .map((item) => {
        const tagStr = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
        const statusStr = item.status !== "active" ? ` (${item.status})` : "";
        const nextStr = item.next_action ? `\n  Next: ${item.next_action}` : "";
        return `**${item.id}** ${item.category}: ${item.title}${statusStr}${tagStr}${nextStr}`;
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.total} item${result.total === 1 ? "" : "s"}:\n\n${formatted}`,
        },
      ],
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
  matchesAllWords,
  detectWorkspace,
  SECTION_MAP,
  resolveSectionName,
  server,
  main,
  storage,
  isHosted,
};
