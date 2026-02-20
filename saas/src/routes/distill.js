/**
 * Memory distillation route.
 *
 * POST /v1/distill — Extract memories from a conversation transcript using LLM.
 *
 * Accepts { "transcript": "..." }, runs it through Llama 3.1 8B to extract
 * discrete memories, deduplicates against existing memories, and stores
 * the novel ones with a "source:distill" tag for auditability.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { embedAndStore } from "../services/embeddings.js";
import { encryptField, decryptField } from "../services/crypto.js";

const distill = new Hono();

const VALID_TYPES = new Set(["fact", "decision", "instruction", "observation", "preference"]);
const MAX_MEMORIES_PER_DISTILL = 20;
const MIN_TRANSCRIPT_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 100_000;

const SYSTEM_PROMPT = `You are a memory extraction system. Read a conversation transcript and extract discrete memories worth remembering long-term.

Rules:
- Extract ONLY genuinely new information — facts, decisions, preferences, instructions, observations, or insights.
- Do NOT extract things already covered in the existing memories listed below.
- Each memory should be a single, self-contained statement.
- Each memory needs a type: "fact", "decision", "instruction", "observation", or "preference".
- Each memory needs 1-3 lowercase tags for categorization.
- If the conversation is trivial, return an empty array.
- Return ONLY valid JSON — no markdown, no commentary, no code fences.

Output format:
[{"content": "...", "type": "fact", "tags": ["tag1", "tag2"]}]

If nothing novel to extract, return: []`;

// POST /v1/distill — Extract and store memories from transcript
distill.post("/", async (c) => {
  const body = await c.req.json();
  const transcript = body.transcript;

  if (!transcript || typeof transcript !== "string") {
    return c.json(
      { content: [{ type: "text", text: "Missing required field: \"transcript\"." }] },
      400
    );
  }

  if (transcript.length < MIN_TRANSCRIPT_LENGTH) {
    return c.json({
      content: [{ type: "text", text: "Transcript too short — skipping distillation." }],
    });
  }

  // Check AI binding
  if (!c.env?.AI) {
    return c.json(
      { content: [{ type: "text", text: "AI binding unavailable — cannot distill." }] },
      503
    );
  }

  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");
  const now = new Date().toISOString();

  // Fetch recent non-consolidated, non-expired memories for dedup context
  const existing = await db.execute({
    sql: `SELECT id, content, type, tags FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC
          LIMIT 200`,
    args: [now],
  });

  // Decrypt existing memories for dedup context
  const encKey = c.get("encryptionKey");
  if (encKey) {
    for (const row of existing.rows) {
      row.content = await decryptField(row.content, encKey);
    }
  }

  const existingBlock = existing.rows.length > 0
    ? existing.rows.map((r, i) => `${i + 1}. ${r.content}`).join("\n")
    : "(no existing memories)";

  const cappedTranscript = transcript.slice(0, MAX_TRANSCRIPT_LENGTH);

  // Call Llama 3.1 8B
  let rawResponse;
  try {
    const result = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `EXISTING MEMORIES (do not duplicate these):\n${existingBlock}\n\n---\n\nTRANSCRIPT:\n${cappedTranscript}`,
        },
      ],
      max_tokens: 2000,
    });

    if (!result?.response) {
      return c.json(
        { content: [{ type: "text", text: "AI call returned empty response." }] },
        502
      );
    }

    rawResponse = result.response;
  } catch (err) {
    return c.json(
      { content: [{ type: "text", text: `AI call failed: ${err.message || "unknown error"}` }] },
      502
    );
  }

  // Parse JSON — strip code fences if present, try regex fallback
  let parsed;
  try {
    const cleaned = rawResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Regex fallback: find first [...] in the response
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
    return c.json({
      content: [{
        type: "text",
        text: `No memories extracted (could not parse LLM output). Raw snippet: ${rawResponse.slice(0, 200)}`,
      }],
    });
  }

  if (parsed.length === 0) {
    return c.json({
      content: [{ type: "text", text: "No novel memories found in transcript." }],
    });
  }

  // Validate, normalize, and store
  const stored = [];
  const capped = parsed.slice(0, MAX_MEMORIES_PER_DISTILL);

  for (const entry of capped) {
    if (!entry.content || typeof entry.content !== "string") continue;

    const id = randomUUID().slice(0, 8);
    const type = VALID_TYPES.has(entry.type) ? entry.type : "observation";
    const entryTags = Array.isArray(entry.tags)
      ? entry.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase()).slice(0, 3)
      : [];
    const tags = JSON.stringify([...entryTags, "source:distill"]);

    const storedContent = encKey ? await encryptField(entry.content, encKey) : entry.content;
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags) VALUES (?, ?, ?, ?)`,
      args: [id, storedContent, type, tags],
    });

    // Fire-and-forget embedding (uses plaintext for vector indexing)
    embedAndStore(c.env, workspaceName, id, entry.content).catch(() => {});

    stored.push({ id, content: entry.content, type });
  }

  const summary = stored.map((m) => `- **${m.id}** (${m.type}): ${m.content}`).join("\n");

  return c.json(
    {
      content: [{
        type: "text",
        text: `Distilled ${stored.length} memor${stored.length === 1 ? "y" : "ies"} from transcript:\n\n${summary}`,
      }],
      memories: stored,
    },
    201
  );
});

export default distill;
