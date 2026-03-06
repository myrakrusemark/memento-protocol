/**
 * Shared memory extraction service.
 *
 * Core LLM-call + parse + store logic used by /v1/distill and /v1/extract.
 */

import { randomUUID } from "node:crypto";
import { embedAndStore } from "./embeddings.js";
import { encryptField, decryptField } from "./crypto.js";

const VALID_TYPES = new Set(["fact", "decision", "instruction", "observation", "preference"]);

export const EXTRACTION_PRESETS = {
  distill: {
    systemPrompt: `You are a memory extraction system. Read a conversation transcript and extract discrete memories worth remembering long-term.

Rules:
- Extract ONLY genuinely new information — facts, decisions, preferences, instructions, observations, or insights.
- Do NOT extract things already covered in the existing memories listed below.
- Each memory should be a single, self-contained statement.
- Each memory needs a type: "fact", "decision", "instruction", "observation", or "preference".
- Each memory needs tags for categorization (see "Structured tags" below for format and limits).
- If the conversation is trivial, return an empty array.
- Return ONLY valid JSON — no markdown, no commentary, no code fences.

Memory writing style:
- Lead with the most searchable term: entity names, project names, specific identifiers.
- Preserve exact values verbatim: grant IDs (e.g., "#2401-8827"), amounts (e.g., "$240,000"), measurements (e.g., "532nm"), percentages, and dates (e.g., "March 3, 2025").
- Include role and relationship vocabulary explicitly, with the most searchable synonym first: write "Lead researcher and principal investigator Dr. Elena Vasquez" not "Dr. Elena Vasquez is the PI". Include both the formal title and the common role word in the content.
- Name the project or context when relevant so memories are findable by project name.
- Use direct active phrasing: "Elena Vasquez leads Project Lumen" not "Project Lumen is led by Elena Vasquez".
- Use query-friendly vocabulary: write "has a deadline of April 15, 2025" not "submitting by April 15"; write "funded by NSF grant" not "has a grant from NSF".

Structured tags:
- For people: include a tag like "person:elena-vasquez" (lowercase, hyphen-separated)
- For grants/IDs: "grant:2401-8827" goes ONLY on the "funded by grant" fact — NOT on budget status or remaining balance facts (use "amount:240000" for those)
- For dates: include a tag like "date:2025-03-03"
- For specialties/roles: use the formal role tag — "role:principal-investigator", "role:research-assistant", "role:data-analyst". Do NOT invent synonym tags; role synonyms belong in the memory content, not in tags.
- For measurements: match tags to THIS memory's specific measurement — "wavelength:532nm" for laser wavelength facts, "percentage:15" and "rate:folding-15-percent" for reduction percentage facts, "temperature:25c" for temperature threshold facts
- Max 7 tags total (the "source:distill" tag is added automatically; do not include it yourself)

Output format:
[{"content": "...", "type": "fact", "tags": ["tag1", "tag2"]}]

If nothing novel to extract, return: []`,
    maxMemories: 20,
    dedupLimit: 20,
    maxTokens: 2000,
    sourceTag: "source:distill:llama-3.1-8b",
  },
  seeds: {
    systemPrompt: `You extract relational and experiential memories from conversations — the human texture that makes relationships real.

Extract ONLY:
- Personal plans, hopes, intentions with specific details
- Emotional shifts — tone changes, excitement, hesitation, humor
- Preferences, tastes, dislikes
- Surprises or things that landed unexpectedly
- Names + relationship context (who someone is to who)
- Birthdays, anniversaries, recurring events
- Sensory details — what something looked/sounded/felt like

Do NOT extract:
- Technical facts, code decisions, system configurations
- Operational instructions or task progress
- Anything in the existing memories below
- Generic statements ("we talked about coffee")
- Status updates or work logs

Each memory: vivid, specific, one sentence, with proper nouns and context.
Type: "fact", "preference", or "observation" only.
Max 3 memories. Return [] if nothing seed-worthy.
Return ONLY valid JSON array — no markdown, no code fences.

Output format:
[{"content": "...", "type": "preference", "tags": ["tag1", "tag2"]}]`,
    maxMemories: 3,
    dedupLimit: 10,
    maxTokens: 400,
    sourceTag: "source:extract:seeds",
  },
};

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
