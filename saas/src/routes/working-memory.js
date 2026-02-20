/**
 * Working memory routes.
 *
 * GET /v1/working-memory           — Read full working memory (all sections as markdown)
 * GET /v1/working-memory/:section  — Read a specific section
 * PUT /v1/working-memory/:section  — Update a section's content
 */

import { Hono } from "hono";
import { encryptField, decryptField } from "../services/crypto.js";

const workingMemory = new Hono();

/** Map section shorthand keys to display headings (matches reference server). */
const SECTION_MAP = {
  active_work: "Active Work",
  standing_decisions: "Standing Decisions",
  skip_list: "Skip List",
  activity_log: "Activity Log",
  session_notes: "Session Notes",
};

/** Map item categories to section headings for rendering items as markdown. */
const CATEGORY_HEADING_MAP = {
  active_work: "Active Work",
  standing_decision: "Standing Decisions",
  skip: "Skip List",
  waiting_for: "Waiting For",
  session_note: "Session Notes",
  activity_log: "Activity Log",
};

function resolveSectionKey(param) {
  // If the param is already a known key, use it directly
  if (SECTION_MAP[param]) return param;
  // Otherwise, try to reverse-map from heading name to key
  for (const [key, heading] of Object.entries(SECTION_MAP)) {
    if (heading.toLowerCase() === param.toLowerCase()) return key;
  }
  // Fall through: treat param as the section key
  return param;
}

function safeParseTags(tagsStr) {
  try {
    return JSON.parse(tagsStr || "[]");
  } catch {
    return [];
  }
}

/**
 * Render working memory items as markdown, grouped by category.
 */
function renderItemsAsMarkdown(items) {
  const grouped = {};
  for (const item of items) {
    const heading = CATEGORY_HEADING_MAP[item.category] || item.category;
    if (!grouped[heading]) grouped[heading] = [];
    grouped[heading].push(item);
  }

  const sections = [];
  // Render in a stable order
  const order = ["Active Work", "Standing Decisions", "Skip List", "Waiting For", "Activity Log", "Session Notes"];
  const seen = new Set();

  for (const heading of order) {
    if (grouped[heading]) {
      sections.push(renderSection(heading, grouped[heading]));
      seen.add(heading);
    }
  }
  // Any extra categories not in the predefined order
  for (const [heading, items] of Object.entries(grouped)) {
    if (!seen.has(heading)) {
      sections.push(renderSection(heading, items));
    }
  }

  if (sections.length === 0) {
    return "# Working Memory\n\n(empty)";
  }

  return `# Working Memory\n\n---\n\n${sections.join("\n\n---\n\n")}`;
}

function renderSection(heading, items) {
  const lines = [`## ${heading}\n`];
  for (const item of items) {
    const tags = safeParseTags(item.tags);
    const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
    const statusStr = item.status !== "active" ? ` *(${item.status})*` : "";
    lines.push(`### ${item.title}${statusStr}${tagStr}\n`);
    if (item.content) lines.push(item.content);
    if (item.next_action) lines.push(`\n**Next:** ${item.next_action}`);
    lines.push("");
  }
  return lines.join("\n");
}

// GET /v1/working-memory — Full working memory as markdown
workingMemory.get("/", async (c) => {
  const db = c.get("workspaceDb");
  const encKey = c.get("encryptionKey");

  // Try items table first
  const itemsResult = await db.execute(
    "SELECT * FROM working_memory_items WHERE status != 'archived' ORDER BY priority DESC, created_at DESC"
  );

  if (itemsResult.rows.length > 0) {
    // Decrypt item fields before rendering
    const decryptedItems = [];
    for (const row of itemsResult.rows) {
      decryptedItems.push({
        ...row,
        title: encKey ? await decryptField(row.title, encKey) : row.title,
        content: encKey ? await decryptField(row.content, encKey) : row.content,
        next_action: row.next_action && encKey ? await decryptField(row.next_action, encKey) : row.next_action,
      });
    }
    const markdown = renderItemsAsMarkdown(decryptedItems);
    return c.json({
      content: [{ type: "text", text: markdown }],
    });
  }

  // Fallback to legacy sections table
  const result = await db.execute(
    "SELECT section_key, heading, content FROM working_memory_sections ORDER BY rowid"
  );

  if (result.rows.length === 0) {
    return c.json({
      content: [{ type: "text", text: "Working memory is empty. No sections found." }],
    });
  }

  const markdown = [];
  for (const row of result.rows) {
    const body = encKey ? await decryptField(row.content, encKey) : row.content;
    markdown.push(`## ${row.heading}\n\n${body || "(empty)"}`);
  }

  const full = `# Working Memory\n\n---\n\n${markdown.join("\n\n---\n\n")}`;

  return c.json({
    content: [{ type: "text", text: full }],
  });
});

// GET /v1/working-memory/:section — Read specific section
workingMemory.get("/:section", async (c) => {
  const db = c.get("workspaceDb");
  const sectionParam = c.req.param("section");
  const key = resolveSectionKey(sectionParam);

  const result = await db.execute({
    sql: "SELECT heading, content FROM working_memory_sections WHERE section_key = ?",
    args: [key],
  });

  if (result.rows.length === 0) {
    return c.json(
      {
        content: [{ type: "text", text: `Section "${sectionParam}" not found in working memory.` }],
      },
      404
    );
  }

  const row = result.rows[0];
  const encKey = c.get("encryptionKey");
  const content = encKey ? await decryptField(row.content, encKey) : row.content;
  return c.json({
    content: [
      {
        type: "text",
        text: `## ${row.heading}\n\n${content || "(empty)"}`,
      },
    ],
  });
});

// PUT /v1/working-memory/:section — Update section
workingMemory.put("/:section", async (c) => {
  const db = c.get("workspaceDb");
  const sectionParam = c.req.param("section");
  const key = resolveSectionKey(sectionParam);
  const body = await c.req.json();

  const newContent = body.content;
  if (newContent === undefined || newContent === null) {
    return c.json(
      { content: [{ type: "text", text: 'Missing required field: "content".' }] },
      400
    );
  }

  const encKey = c.get("encryptionKey");
  const storedContent = encKey ? await encryptField(newContent, encKey) : newContent;

  // Check if section exists
  const existing = await db.execute({
    sql: "SELECT section_key FROM working_memory_sections WHERE section_key = ?",
    args: [key],
  });

  if (existing.rows.length === 0) {
    // Auto-create the section with the param as heading
    const heading = SECTION_MAP[key] || sectionParam;
    await db.execute({
      sql: `INSERT INTO working_memory_sections (section_key, heading, content, updated_at)
            VALUES (?, ?, ?, datetime('now'))`,
      args: [key, heading, storedContent],
    });
  } else {
    await db.execute({
      sql: `UPDATE working_memory_sections
            SET content = ?, updated_at = datetime('now')
            WHERE section_key = ?`,
      args: [storedContent, key],
    });
  }

  const heading = SECTION_MAP[key] || sectionParam;

  return c.json({
    content: [
      {
        type: "text",
        text: `Updated section "${heading}" in working memory.`,
      },
    ],
  });
});

export default workingMemory;
