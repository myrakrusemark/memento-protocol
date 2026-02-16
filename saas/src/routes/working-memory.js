/**
 * Working memory routes.
 *
 * GET /v1/working-memory           — Read full working memory (all sections as markdown)
 * GET /v1/working-memory/:section  — Read a specific section
 * PUT /v1/working-memory/:section  — Update a section's content
 */

import { Hono } from "hono";

const workingMemory = new Hono();

/** Map section shorthand keys to display headings (matches reference server). */
const SECTION_MAP = {
  active_work: "Active Work",
  standing_decisions: "Standing Decisions",
  skip_list: "Skip List",
  activity_log: "Activity Log",
  session_notes: "Session Notes",
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

// GET /v1/working-memory — Full working memory as markdown
workingMemory.get("/", async (c) => {
  const db = c.get("workspaceDb");

  const result = await db.execute(
    "SELECT section_key, heading, content FROM working_memory_sections ORDER BY rowid"
  );

  if (result.rows.length === 0) {
    return c.json({
      content: [{ type: "text", text: "Working memory is empty. No sections found." }],
    });
  }

  const markdown = result.rows
    .map((row) => {
      const body = row.content || "(empty)";
      return `## ${row.heading}\n\n${body}`;
    })
    .join("\n\n---\n\n");

  const full = `# Working Memory\n\n---\n\n${markdown}`;

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
  return c.json({
    content: [
      {
        type: "text",
        text: `## ${row.heading}\n\n${row.content || "(empty)"}`,
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
      args: [key, heading, newContent],
    });
  } else {
    await db.execute({
      sql: `UPDATE working_memory_sections
            SET content = ?, updated_at = datetime('now')
            WHERE section_key = ?`,
      args: [newContent, key],
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
