/**
 * Unified memory extraction route.
 *
 * POST /v1/extract — Extract memories from a conversation transcript.
 *
 * Supports two modes:
 *   - "distill" (default): Full extraction — all memory types, up to 20 memories
 *   - "seeds": Relational/experiential seeds — max 3 memories
 */

import { Hono } from "hono";
import { extractMemories, EXTRACTION_PRESETS } from "../services/extraction.js";

const extract = new Hono();

const MIN_TRANSCRIPT_LENGTH = 100;
const MAX_TRANSCRIPT_LENGTH = 100_000;

// POST /v1/extract — Extract and store memories
extract.post("/", async (c) => {
  const body = await c.req.json();
  const mode = body.mode || "distill";

  if (!["distill", "seeds"].includes(mode)) {
    return c.json({ error: "Invalid mode. Must be \"distill\" or \"seeds\"." }, 400);
  }

  const preset = EXTRACTION_PRESETS[mode];

  if (!c.env?.AI) {
    return c.json({ error: "AI binding unavailable." }, 503);
  }

  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");
  const encKey = c.get("encryptionKey");

  const transcript = body.transcript;

  if (!transcript || typeof transcript !== "string") {
    return c.json({ error: "A transcript is required." }, 400);
  }

  if (transcript.length < MIN_TRANSCRIPT_LENGTH) {
    return c.json({ error: `Transcript too short (minimum ${MIN_TRANSCRIPT_LENGTH} characters).` }, 400);
  }

  const cappedTranscript = transcript.slice(0, MAX_TRANSCRIPT_LENGTH);

  const maxMemories = body.max_memories || preset.maxMemories;
  const sourceTag = body.source_tag || preset.sourceTag;

  const { stored, error } = await extractMemories({
    env: c.env,
    db,
    workspaceName,
    encKey,
    transcript: cappedTranscript,
    systemPrompt: preset.systemPrompt,
    maxMemories,
    dedupLimit: preset.dedupLimit,
    maxTokens: preset.maxTokens,
    sourceTag,
  });

  if (error) {
    return c.json({
      stored: stored || [],
      count: stored?.length || 0,
      mode,
      source: "transcript",
      error,
    });
  }

  return c.json(
    {
      stored,
      count: stored.length,
      mode,
      source: "transcript",
    },
    stored.length > 0 ? 201 : 200
  );
});

export default extract;
