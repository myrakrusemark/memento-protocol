/**
 * LocalStorageAdapter -- Flat-file implementation of StorageInterface.
 *
 * All persistence logic that was previously inline in index.js tool handlers
 * lives here. Uses the same helper functions (imported from index.js) to
 * maintain identical behavior.
 */

import { StorageInterface } from "./interface.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  readFileSafe,
  ensureDir,
  readSkipIndex,
  writeSkipIndex,
  purgeExpiredSkips,
  extractSection,
  replaceSection,
  matchesAllWords,
  resolveSectionName,
} from "../index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class LocalStorageAdapter extends StorageInterface {
  async initWorkspace(wsPath) {
    if (fs.existsSync(path.join(wsPath, "working-memory.md"))) {
      return { alreadyExists: true, wsPath };
    }

    ensureDir(wsPath);
    ensureDir(path.join(wsPath, "memories"));

    // Copy template
    const templatePath = path.join(__dirname, "..", "..", "templates", "working-memory.md");
    const template = readFileSafe(templatePath);
    if (!template) {
      return { error: `template not found at ${templatePath}` };
    }

    fs.writeFileSync(path.join(wsPath, "working-memory.md"), template, "utf-8");
    writeSkipIndex(wsPath, []);

    return { created: true, wsPath };
  }

  async readWorkingMemory(wsPath, section) {
    const wmPath = path.join(wsPath, "working-memory.md");
    const content = readFileSafe(wmPath);

    if (!content) {
      return { error: `No working memory found at ${wmPath}. Run memento_init first.` };
    }

    if (section) {
      const heading = resolveSectionName(section);
      const extracted = extractSection(content, heading);
      if (extracted === null) {
        return { error: `Section "${heading}" not found in working memory.` };
      }
      return { content: `## ${heading}\n\n${extracted}` };
    }

    return { content };
  }

  async updateWorkingMemory(wsPath, section, content) {
    const wmPath = path.join(wsPath, "working-memory.md");
    const existing = readFileSafe(wmPath);

    if (!existing) {
      return { error: `No working memory found at ${wmPath}. Run memento_init first.` };
    }

    const heading = resolveSectionName(section);
    const updated = replaceSection(existing, heading, content);
    fs.writeFileSync(wmPath, updated, "utf-8");

    return { heading };
  }

  async storeMemory(wsPath, { content, tags, type, expires }) {
    const memoriesDir = path.join(wsPath, "memories");

    if (!fs.existsSync(memoriesDir)) {
      return { error: "Memories directory not found. Run memento_init first." };
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

    return { id, type: memory.type, tags: memory.tags };
  }

  async recallMemories(wsPath, { query, tags, type, limit }) {
    const memoriesDir = path.join(wsPath, "memories");

    if (!fs.existsSync(memoriesDir)) {
      return { error: "No memories directory found. Run memento_init first." };
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

        // Keyword match -- count how many query terms appear in content
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
      return { results: [], query };
    }

    const formatted = topResults
      .map((r) => {
        const m = r.memory;
        const tagStr = m.tags && m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const expStr = m.expires ? ` (expires: ${m.expires})` : "";
        return `**${m.id}** (${m.type})${tagStr}${expStr}\n${m.content}`;
      })
      .join("\n\n---\n\n");

    return { results: topResults, formatted, count: topResults.length };
  }

  async addSkip(wsPath, { item, reason, expires }) {
    if (!fs.existsSync(wsPath)) {
      return { error: `Workspace not found at ${wsPath}. Run memento_init first.` };
    }

    const entries = readSkipIndex(wsPath);
    entries.push({
      id: randomUUID().slice(0, 8),
      item,
      reason,
      expires,
      added: new Date().toISOString(),
    });
    writeSkipIndex(wsPath, entries);

    // Also update the skip list section in working memory
    const wmPath = path.join(wsPath, "working-memory.md");
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

    return { item, expires };
  }

  async checkSkip(wsPath, query) {
    if (!fs.existsSync(wsPath)) {
      return { error: `Workspace not found at ${wsPath}. Run memento_init first.` };
    }

    let entries = readSkipIndex(wsPath);
    const before = entries.length;
    entries = purgeExpiredSkips(entries);

    // Write back if we purged anything
    if (entries.length !== before) {
      writeSkipIndex(wsPath, entries);
    }

    const match = entries.find(
      (e) => matchesAllWords(query, e.item) || matchesAllWords(e.item, query)
    );

    if (match) {
      return { match };
    }

    return { match: null, query };
  }

  async getHealth(wsPath) {
    if (!fs.existsSync(wsPath)) {
      return { error: `No workspace found at ${wsPath}. Run memento_init to create one.` };
    }

    const stats = { workspace: wsPath };

    // Working memory
    const wmPath = path.join(wsPath, "working-memory.md");
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
    const memoriesDir = path.join(wsPath, "memories");
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
    const skipEntries = readSkipIndex(wsPath);
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

    return { stats, formatted: lines.join("\n") };
  }
}
