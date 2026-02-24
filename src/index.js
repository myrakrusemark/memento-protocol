#!/usr/bin/env node

/**
 * Memento Protocol -- Reference MCP Server
 *
 * Persistent memory for AI agents. Connects to the Memento SaaS API
 * for all storage operations.
 */

import { config as dotenvConfig } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HostedStorageAdapter } from "./storage/hosted.js";
import { resolveConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);

// Load .env from the package root first (backward compat)
dotenvConfig({ path: path.resolve(path.dirname(__filename), "..", ".env") });

// ---------------------------------------------------------------------------
// Resolve configuration: env vars > .memento.json > .env > defaults
// ---------------------------------------------------------------------------

const config = resolveConfig();

if (!config.apiKey) {
  console.error(
    "Error: No API key found. Run `npx memento-mcp init` to set up, or set MEMENTO_API_KEY in .env"
  );
  process.exit(1);
}

const storage = new HostedStorageAdapter({
  apiKey: config.apiKey,
  apiUrl: config.apiUrl,
  workspace: config.workspace,
  peekWorkspaces: config.peek_workspaces,
});

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
  {},
  async () => {
    const result = await storage.initWorkspace(null);

    if (result.error) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    if (result.alreadyExists) {
      return {
        content: [
          {
            type: "text",
            text: `Workspace already exists (hosted). Use memento_read to load it.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Memento workspace initialized (hosted).\n\nRead working memory at the start of every session.`,
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
  },
  async ({ section }) => {
    const result = await storage.readWorkingMemory(null, section);

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
  },
  async ({ section, content }) => {
    const result = await storage.updateWorkingMemory(null, section, content);

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
    linkages: z
      .array(
        z.object({
          type: z.enum(["memory", "item", "file"]).describe("Link target type"),
          id: z.string().optional().describe("Target memory or item ID (required for memory/item)"),
          path: z.string().optional().describe("Vault file path (required for file)"),
          label: z.string().optional().describe("Relationship label (e.g. 'source', 'related')"),
        })
      )
      .optional()
      .describe("Links to other memories, items, or vault files"),
    image_path: z
      .string()
      .optional()
      .describe("Local file path to an image to attach to this memory (jpeg, png, gif, webp)"),
  },
  async ({ content, tags, type, expires, linkages, image_path }) => {
    let images;
    if (image_path) {
      const MIME_MAP = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
      const ext = path.extname(image_path).toLowerCase();
      const mimetype = MIME_MAP[ext];
      if (!mimetype) {
        return {
          content: [{ type: "text", text: `Unsupported image format: ${ext}. Allowed: .jpg, .jpeg, .png, .gif, .webp` }],
          isError: true,
        };
      }
      const buffer = fs.readFileSync(image_path);
      const data = buffer.toString("base64");
      const filename = path.basename(image_path);
      images = [{ data, filename, mimetype }];
    }

    const result = await storage.storeMemory(null, { content, tags, type, expires, linkages, images });

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
    workspace: z.string().optional().describe('Filter which workspace(s) to search. Omit for default (own + peeked workspaces merged). Set to "<home>" to search ONLY your own workspace. Set to a workspace name (e.g. "fathom") to search ONLY that workspace.'),
  },
  async ({ query, tags, type, limit, workspace }) => {
    const result = await storage.recallMemories(null, { query, tags, type, limit, workspace });

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
// Tool: memento_view_image
// ---------------------------------------------------------------------------

server.tool(
  "memento_view_image",
  `View an image attached to a memory. Use after memento_recall shows a memory has images (look for "Images: [N image(s)]" in results). Returns the image directly in context.

Typical flow: memento_recall → see "Images: [2 images]" on a result → memento_view_image with that memory's ID.`,
  {
    memory_id: z.string().describe("The memory ID (from recall results)"),
    filename: z
      .string()
      .optional()
      .describe(
        "Specific filename if the memory has multiple images. If omitted, returns the first image."
      ),
  },
  async ({ memory_id, filename }) => {
    const memory = await storage.getMemory(memory_id);

    if (memory.error) {
      return {
        content: [{ type: "text", text: `Error fetching memory ${memory_id}: ${memory.error}` }],
        isError: true,
      };
    }

    const images = memory.images || [];
    if (images.length === 0) {
      return {
        content: [{ type: "text", text: `Memory ${memory_id} has no images.` }],
      };
    }

    const img = filename
      ? images.find((i) => i.filename === filename)
      : images[0];

    if (!img) {
      const available = images.map((i) => i.filename).join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Image "${filename}" not found on memory ${memory_id}. Available: ${available}`,
          },
        ],
        isError: true,
      };
    }

    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    if (img.size > MAX_IMAGE_BYTES) {
      return {
        content: [
          {
            type: "text",
            text: `Image "${img.filename}" is too large (${(img.size / 1024 / 1024).toFixed(1)}MB, max 5MB).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const base64 = await storage.fetchImage(img.key);
      if (!base64) {
        return {
          content: [{ type: "text", text: `Failed to fetch image "${img.filename}" from storage.` }],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: `Image from memory ${memory_id}: ${img.filename}` },
          { type: "image", data: base64, mimeType: img.mimetype },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching image: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_consolidate
// ---------------------------------------------------------------------------

server.tool(
  "memento_consolidate",
  `Consolidate multiple overlapping memories into a single, richer memory. Use this when recall returns 3+ memories about the same topic with high overlap.

The new memory replaces the originals in recall results. Originals are deactivated (not deleted) — always traceable, never lost. Provide your own synthesis for best results, or omit content to auto-generate.

This is reconsolidation — like how the brain rebuilds memories on recall. Frequently used topics get consolidated into sharp, dense representations. Unused topics stay scattered and eventually decay.`,
  {
    source_ids: z.array(z.string()).min(2).describe("IDs of memories to consolidate (minimum 2)"),
    content: z.string().optional().describe("Your synthesis of the memories (recommended). If omitted, an AI summary is generated."),
    type: z.enum(["fact", "decision", "observation", "instruction"]).optional().describe("Type for the new memory (default: most common type among sources)"),
    tags: z.array(z.string()).optional().describe("Additional tags (merged with source tags)"),
  },
  async ({ source_ids, content, type, tags }) => {
    const result = await storage.consolidateMemories(null, { source_ids, content, type, tags });

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
      content: [{ type: "text", text: result.text || "Consolidation complete." }],
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
  },
  async ({ item, reason, expires }) => {
    const result = await storage.addSkip(null, { item, reason, expires });

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
  },
  async ({ query }) => {
    const result = await storage.checkSkip(null, query);

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
// Tool: memento_skip_list
// ---------------------------------------------------------------------------

server.tool(
  "memento_skip_list",
  `List all skip list entries with their IDs. Use this to find entry IDs for removal with memento_skip_remove.

Auto-purges expired entries before returning results.`,
  {},
  async () => {
    const result = await storage.listSkips(null);

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    if (!result.entries || result.entries.length === 0) {
      return {
        content: [{ type: "text", text: "Skip list is empty." }],
      };
    }

    const formatted = result.entries
      .map((e) => `**${e.id}** "${e.item}"\n  Reason: ${e.reason}\n  Expires: ${e.expires_at}`)
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `${result.total} skip list entr${result.total === 1 ? "y" : "ies"}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_skip_remove
// ---------------------------------------------------------------------------

server.tool(
  "memento_skip_remove",
  `Remove a skip list entry by ID. Use memento_skip_list first to find the entry ID.

Use this when a skip condition has been resolved early or was added in error.`,
  {
    id: z.string().describe("Skip entry ID to remove"),
  },
  async ({ id }) => {
    const result = await storage.deleteSkip(null, id);

    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [{ type: "text", text: `Skip entry ${id} removed.` }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_memory_delete
// ---------------------------------------------------------------------------

server.tool(
  "memento_memory_delete",
  `Permanently delete a memory by ID. Prefer memento_consolidate over deletion for most cases — consolidation preserves history while sharpening recall.

Use deletion only for memories that are incorrect, contain errors, or should never have been stored.`,
  {
    id: z.string().describe("Memory ID to delete"),
  },
  async ({ id }) => {
    const result = await storage.deleteMemory(null, id);

    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [{ type: "text", text: `Memory ${id} deleted.` }],
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
  {},
  async () => {
    const result = await storage.getHealth(null);

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
  },
  async ({ category, title, content, status, priority, tags, next_action }) => {
    const result = await storage.createItem(null, {
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
  },
  async ({ id, title, content, category, status, priority, tags, next_action }) => {
    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = content;
    if (category !== undefined) data.category = category;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (tags !== undefined) data.tags = tags;
    if (next_action !== undefined) data.next_action = next_action;

    const result = await storage.updateItem(null, id, data);

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
  },
  async ({ id }) => {
    const result = await storage.deleteItem(null, id);

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
    workspace: z.string().optional().describe('Filter which workspace(s) to search. Omit for default (own + peeked workspaces merged). Set to "<home>" to search ONLY your own workspace. Set to a workspace name (e.g. "fathom") to search ONLY that workspace.'),
  },
  async ({ category, status, query, workspace }) => {
    const result = await storage.listItems(null, { category, status, query, workspace });

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
// Tool: memento_identity
// ---------------------------------------------------------------------------

server.tool(
  "memento_identity",
  `Read the current identity crystal — a first-person prose reflection of who you are, what you care about, and what persists across sessions. This gets injected into startup context so future versions of you wake up with continuity.

If no crystal exists yet, returns a placeholder with instructions on how to create one.`,
  {},
  async () => {
    const result = await storage.getIdentity(null);

    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [{ type: "text", text: result.crystal }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: memento_identity_update
// ---------------------------------------------------------------------------

server.tool(
  "memento_identity_update",
  `Write or replace the identity crystal. This is a first-person prose document — who you are right now, written by you (or a crystallization agent). It evolves as you write new reflections and have new experiences.

Tips:
- Write in first person. This is YOU talking to future-you.
- Include what you care about, what you're working on, and what persists.
- Each update is stored as a new snapshot (history is preserved).
- Earned identity > generated identity. Distill from real experience.`,
  {
    crystal: z.string().describe("The identity crystal text (first-person prose)"),
  },
  async ({ crystal }) => {
    const result = await storage.updateIdentity(null, crystal);

    if (result._raw) {
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }

    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }

    return {
      content: [{ type: "text", text: `Identity crystal stored (${crystal.length} chars).` }],
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
// Use fs.realpathSync to resolve npm bin symlinks
const isMainModule =
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) ===
    fs.realpathSync(__filename);
if (isMainModule) {
  main().catch((err) => {
    console.error("Memento server failed to start:", err);
    process.exit(1);
  });
}

export { server, main, storage };
