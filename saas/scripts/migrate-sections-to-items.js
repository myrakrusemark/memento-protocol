#!/usr/bin/env node

/**
 * Migration: working_memory_sections → working_memory_items
 *
 * Parses existing markdown section content into structured items.
 * Safe to run multiple times — skips if items already exist.
 *
 * Usage:
 *   node scripts/migrate-sections-to-items.js [--workspace <name>]
 *
 * Environment:
 *   MEMENTO_DB_URL    — Database URL (default: file:./dev.db)
 *   MEMENTO_DB_TOKEN  — Auth token for Turso
 */

import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

const DB_URL = process.env.MEMENTO_DB_URL || "file:./dev.db";
const DB_TOKEN = process.env.MEMENTO_DB_TOKEN || undefined;

async function migrate(db) {
  // Check if items already exist
  const existing = await db.execute(
    "SELECT COUNT(*) as count FROM working_memory_items"
  );
  if (existing.rows[0].count > 0) {
    console.log(
      `Skipping — ${existing.rows[0].count} items already exist. Delete them first to re-migrate.`
    );
    return;
  }

  // Ensure items table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS working_memory_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      next_action TEXT,
      last_touched TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const sections = await db.execute(
    "SELECT section_key, heading, content FROM working_memory_sections"
  );

  let itemCount = 0;

  for (const section of sections.rows) {
    const content = section.content || "";
    if (!content.trim()) continue;

    const key = section.section_key;
    const items = parseSection(key, content);

    for (const item of items) {
      const id = randomUUID().slice(0, 8);
      await db.execute({
        sql: `INSERT INTO working_memory_items
              (id, category, title, content, status, priority, tags, next_action)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          item.category,
          item.title,
          item.content,
          item.status || "active",
          item.priority || 0,
          JSON.stringify(item.tags || []),
          item.next_action || null,
        ],
      });
      itemCount++;
      console.log(`  [${item.category}] ${item.title}`);
    }
  }

  console.log(`\nMigrated ${itemCount} items from ${sections.rows.length} sections.`);
}

/**
 * Parse a section's content into structured items based on section type.
 */
function parseSection(sectionKey, content) {
  switch (sectionKey) {
    case "active_work":
      return parseMarkdownHeadings(content, "active_work");
    case "standing_decisions":
      return parseTableRows(content, "standing_decision");
    case "skip_list":
      return parseTableRows(content, "skip");
    case "activity_log":
      return parseTableRows(content, "activity_log");
    case "session_notes":
      return parseSessionNotes(content);
    default:
      // Unknown section — store as single item
      return content.trim()
        ? [{ category: sectionKey, title: sectionKey, content: content.trim() }]
        : [];
  }
}

/**
 * Parse h3 subsections (### Title) into items.
 * Used for Active Work / Active Explorations.
 */
function parseMarkdownHeadings(content, category) {
  const items = [];
  const headingRegex = /^###\s+(.+)$/gm;
  let match;
  const headings = [];

  while ((match = headingRegex.exec(content)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index });
  }

  if (headings.length === 0) {
    // No subheadings — treat entire content as one item
    if (content.trim()) {
      items.push({
        category,
        title: "Untitled",
        content: content.trim(),
        priority: 0,
      });
    }
    return items;
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
    const block = content.slice(start, end).trim();

    // Remove the heading line itself
    const bodyLines = block.split("\n").slice(1);
    const body = bodyLines.join("\n").trim();

    // Extract next_action if present
    let nextAction = null;
    const nextMatch = body.match(/\*\*Next(?:\s+action)?:\*\*\s*(.+)/i);
    if (nextMatch) {
      nextAction = nextMatch[1].trim();
    }

    // Extract status markers
    let status = "active";
    const titleLower = headings[i].title.toLowerCase();
    if (titleLower.includes("(completed)") || titleLower.includes("(done)")) {
      status = "completed";
    } else if (titleLower.includes("(paused)") || titleLower.includes("(blocked)")) {
      status = "paused";
    }

    items.push({
      category,
      title: headings[i].title.replace(/\s*\((?:completed|done|paused|blocked)\)\s*/gi, "").trim(),
      content: body,
      status,
      priority: headings.length - i, // earlier = higher priority
      next_action: nextAction,
    });
  }

  return items;
}

/**
 * Parse markdown table rows into items.
 * Used for Standing Decisions, Skip List, Activity Log.
 */
function parseTableRows(content, category) {
  const items = [];
  const lines = content.split("\n");

  // Find header row to determine column names
  let headerLine = null;
  let dataStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("|") && line.endsWith("|") && !line.match(/^\|[-\s|]+\|$/)) {
      if (!headerLine) {
        headerLine = line;
        dataStart = i + 2; // skip header + separator
        break;
      }
    }
  }

  if (!headerLine) {
    // No table found — store as single item
    if (content.trim()) {
      items.push({ category, title: category, content: content.trim() });
    }
    return items;
  }

  const headers = headerLine
    .split("|")
    .map((h) => h.trim())
    .filter(Boolean);

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    if (line.match(/^\|[-\s|]+\|$/)) continue; // skip separator

    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // trim first/last empty

    if (cells.length === 0) continue;

    const title = cells[0] || "Untitled";
    const remaining = cells.slice(1).join(" | ");

    items.push({
      category,
      title,
      content: remaining || "",
    });
  }

  return items;
}

/**
 * Parse session notes — split by date headers or double newlines.
 */
function parseSessionNotes(content) {
  if (!content.trim()) return [];

  // Try to split by date-like headers (e.g., "Feb 14 — ..." or "*Feb 14*")
  const dateRegex = /^\*?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/m;

  if (dateRegex.test(content)) {
    // Has date markers — split on them
    const parts = content.split(/(?=^\*?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+)/m);
    return parts
      .filter((p) => p.trim())
      .map((part) => {
        const firstLine = part.split("\n")[0].trim().replace(/^\*|\*$/g, "");
        return {
          category: "session_note",
          title: firstLine.slice(0, 80),
          content: part.trim(),
        };
      });
  }

  // No date markers — store as single item
  return [{
    category: "session_note",
    title: "Session Notes",
    content: content.trim(),
  }];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = { url: DB_URL };
if (DB_TOKEN) opts.authToken = DB_TOKEN;
const db = createClient(opts);

console.log(`Migrating sections → items (${DB_URL})...\n`);
await migrate(db);
db.close();
