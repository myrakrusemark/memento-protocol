/**
 * Shared memory extraction service.
 *
 * Core LLM-call + parse + store logic used by both /v1/distill (full distillation)
 * and /v1/context (passive auto-extraction from conversation buffer).
 */

import { randomUUID } from "node:crypto";
import { embedAndStore } from "./embeddings.js";
import { encryptField, decryptField } from "./crypto.js";

const VALID_TYPES = new Set(["fact", "decision", "instruction", "observation", "preference"]);

/**
 * Extract memories from a transcript using LLM, dedup against existing, store results.
 *
 * @param {object} opts
 * @param {object} opts.env - Workers environment bindings (needs opts.env.AI)
 * @param {object} opts.db - Workspace database client
 * @param {string} opts.workspaceName - Workspace name (for vector indexing)
 * @param {string|null} opts.encKey - Encryption key (null if unencrypted)
 * @param {string} opts.transcript - The conversation transcript to extract from
 * @param {string} opts.systemPrompt - System prompt for the LLM
 * @param {number} [opts.maxMemories=20] - Max memories to store per extraction
 * @param {number} [opts.dedupLimit=200] - How many recent memories to fetch for dedup
 * @param {number} [opts.maxTokens=2000] - Max tokens for LLM output
 * @param {string} [opts.sourceTag="source:distill"] - Tag to append to all stored memories
 * @returns {Promise<{stored: Array, rawResponse: string|null, error: string|null}>}
 */
export async function extractMemories({
  env,
  db,
  workspaceName,
  encKey,
  transcript,
  systemPrompt,
  maxMemories = 20,
  dedupLimit = 200,
  maxTokens = 2000,
  sourceTag = "source:distill",
}) {
  if (!env?.AI) {
    return { stored: [], rawResponse: null, error: "AI binding unavailable" };
  }

  const now = new Date().toISOString();

  // 1. Fetch recent memories for dedup context
  const existing = await db.execute({
    sql: `SELECT id, content, type, tags FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [now, dedupLimit],
  });

  if (encKey) {
    for (const row of existing.rows) {
      row.content = await decryptField(row.content, encKey);
    }
  }

  const existingBlock = existing.rows.length > 0
    ? existing.rows.map((r, i) => `${i + 1}. ${r.content}`).join("\n")
    : "(no existing memories)";

  // 2. Call Llama 3.1 8B
  let rawResponse;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `EXISTING MEMORIES (do not duplicate these):\n${existingBlock}\n\n---\n\nTRANSCRIPT:\n${transcript}`,
        },
      ],
      max_tokens: maxTokens,
    });

    if (!result?.response) {
      return { stored: [], rawResponse: null, error: "AI call returned empty response" };
    }

    rawResponse = result.response;
  } catch (err) {
    return { stored: [], rawResponse: null, error: `AI call failed: ${err.message || "unknown error"}` };
  }

  // 3. Parse JSON — strip code fences if present, try regex fallback
  let parsed;
  try {
    const cleaned = rawResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = rawResponse.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (!Array.isArray(parsed)) {
    return { stored: [], rawResponse, error: "Could not parse LLM output" };
  }

  if (parsed.length === 0) {
    return { stored: [], rawResponse, error: null };
  }

  // 4. Validate, encrypt, store, embed
  const stored = [];
  const capped = parsed.slice(0, maxMemories);

  for (const entry of capped) {
    if (!entry.content || typeof entry.content !== "string") continue;
    entry.content = entry.content.trim();

    const id = randomUUID().slice(0, 8);
    const type = VALID_TYPES.has(entry.type) ? entry.type : "observation";
    const entryTags = Array.isArray(entry.tags)
      ? entry.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase()).slice(0, 7)
      : [];
    const tags = JSON.stringify([...entryTags, sourceTag]);

    const storedContent = encKey ? await encryptField(entry.content, encKey) : entry.content;
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags) VALUES (?, ?, ?, ?)`,
      args: [id, storedContent, type, tags],
    });

    // Fire-and-forget embedding
    embedAndStore(env, workspaceName, id, entry.content).catch(() => {});

    stored.push({ id, content: entry.content, type, tags: [...entryTags, sourceTag] });
  }

  return { stored, rawResponse, error: null };
}
