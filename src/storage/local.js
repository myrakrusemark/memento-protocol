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

        // Keyword match -- count how many query terms appear in content or tags
        const searchable = [memory.content, ...(memory.tags || [])]
          .join(" ")
          .toLowerCase();
        const hits = queryTerms.filter((term) => searchable.includes(term)).length;
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

  // -------------------------------------------------------------------------
  // Working memory items (local file-based storage)
  // -------------------------------------------------------------------------

  _itemsPath(wsPath) {
    return path.join(wsPath, "items");
  }

  async createItem(wsPath, data) {
    const dir = this._itemsPath(wsPath);
    ensureDir(dir);

    const id = randomUUID().slice(0, 8);
    const item = {
      id,
      category: data.category,
      title: data.title,
      content: data.content || "",
      status: data.status || "active",
      priority: data.priority || 0,
      tags: data.tags || [],
      next_action: data.next_action || null,
      last_touched: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify(item, null, 2),
      "utf-8"
    );

    return item;
  }

  async updateItem(wsPath, id, data) {
    const filePath = path.join(this._itemsPath(wsPath), `${id}.json`);
    const raw = readFileSafe(filePath);
    if (!raw) return { error: "Item not found." };

    const item = JSON.parse(raw);

    if (data.title !== undefined) item.title = data.title;
    if (data.content !== undefined) item.content = data.content;
    if (data.category !== undefined) item.category = data.category;
    if (data.status !== undefined) item.status = data.status;
    if (data.priority !== undefined) item.priority = data.priority;
    if (data.tags !== undefined) item.tags = data.tags;
    if (data.next_action !== undefined) item.next_action = data.next_action;

    item.updated_at = new Date().toISOString();
    item.last_touched = new Date().toISOString();

    fs.writeFileSync(filePath, JSON.stringify(item, null, 2), "utf-8");
    return item;
  }

  async deleteItem(wsPath, id) {
    const filePath = path.join(this._itemsPath(wsPath), `${id}.json`);
    if (!fs.existsSync(filePath)) return { error: "Item not found." };
    fs.unlinkSync(filePath);
    return { deleted: true, id };
  }

  async listItems(wsPath, filters = {}) {
    const dir = this._itemsPath(wsPath);
    if (!fs.existsSync(dir)) return { items: [], total: 0 };

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    let items = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        items.push(JSON.parse(raw));
      } catch {
        // skip malformed
      }
    }

    if (filters.category) {
      items = items.filter((i) => i.category === filters.category);
    }
    if (filters.status) {
      items = items.filter((i) => i.status === filters.status);
    }
    if (filters.query) {
      const q = filters.query.toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.content.toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    return { items, total: items.length };
  }

  async consolidateMemories(wsPath, { source_ids, content, type, tags }) {
    const memoriesDir = path.join(wsPath, "memories");
    if (!fs.existsSync(memoriesDir)) {
      return { error: "Memories directory not found. Run memento_init first." };
    }

    // Read source memory files
    const sources = [];
    for (const id of source_ids) {
      const filePath = path.join(memoriesDir, `${id}.json`);
      const raw = readFileSafe(filePath);
      if (!raw) continue;
      try {
        const mem = JSON.parse(raw);
        if (mem.consolidated) continue; // Skip already consolidated
        sources.push(mem);
      } catch {
        // Skip malformed
      }
    }

    if (sources.length < 2) {
      return { error: "Found fewer than 2 active memories from provided IDs." };
    }

    // Determine content
    let finalContent = content;
    if (!finalContent) {
      const bullets = sources.map((m) => `- ${m.content}`).join("\n");
      finalContent = `Consolidated ${sources.length} memories:\n${bullets}`;
    }

    // Determine type
    let finalType = type;
    if (!finalType) {
      const typeCounts = {};
      for (const m of sources) {
        typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
      }
      finalType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Compute tag union
    const allTags = new Set();
    for (const m of sources) {
      if (Array.isArray(m.tags)) {
        for (const t of m.tags) allTags.add(t);
      }
    }
    if (Array.isArray(tags)) {
      for (const t of tags) allTags.add(t);
    }

    // Create new consolidated memory
    const newId = randomUUID().slice(0, 8);
    const newMemory = {
      id: newId,
      content: finalContent,
      type: finalType,
      tags: Array.from(allTags).sort(),
      created: new Date().toISOString(),
      expires: null,
      consolidated_from: sources.map((m) => m.id),
    };

    fs.writeFileSync(
      path.join(memoriesDir, `${newId}.json`),
      JSON.stringify(newMemory, null, 2),
      "utf-8"
    );

    // Mark sources as consolidated
    for (const m of sources) {
      m.consolidated = true;
      m.consolidated_into = newId;
      fs.writeFileSync(
        path.join(memoriesDir, `${m.id}.json`),
        JSON.stringify(m, null, 2),
        "utf-8"
      );
    }

    const sourceIdList = sources.map((m) => m.id);
    return {
      _raw: true,
      text: `Consolidated ${sources.length} memories into ${newId}. Sources: [${sourceIdList.join(", ")}]`,
      isError: false,
    };
  }

  async getContext(wsPath, message) {
    // Local mode: assemble context from files
    const itemsResult = await this.listItems(wsPath, { status: "active" });
    const recallResult = message
      ? await this.recallMemories(wsPath, { query: message, limit: 10 })
      : { results: [] };
    const skipResult = message
      ? await this.checkSkip(wsPath, message)
      : { match: null };

    return {
      working_memory: {
        items: itemsResult.items || [],
        total_active: itemsResult.total || 0,
      },
      memories: {
        matches: (recallResult.results || []).map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
          type: r.memory.type,
          tags: r.memory.tags || [],
          score: r.score,
        })),
      },
      skip_matches: skipResult.match ? [skipResult.match] : [],
      identity: null,
    };
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
