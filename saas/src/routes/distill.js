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
import { extractMemories, EXTRACTION_PRESETS } from "../services/extraction.js";

const distill = new Hono();

const MIN_TRANSCRIPT_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 100_000;

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

  if (!c.env?.AI) {
    return c.json(
      { content: [{ type: "text", text: "AI binding unavailable — cannot distill." }] },
      503
    );
  }

  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");
  const encKey = c.get("encryptionKey");

  const cappedTranscript = transcript.slice(0, MAX_TRANSCRIPT_LENGTH);

  const preset = EXTRACTION_PRESETS.distill;
  const { stored, rawResponse, error } = await extractMemories({
    env: c.env,
    db,
    workspaceName,
    encKey,
    transcript: cappedTranscript,
    systemPrompt: preset.systemPrompt,
    maxMemories: preset.maxMemories,
    dedupLimit: preset.dedupLimit,
    maxTokens: preset.maxTokens,
    sourceTag: preset.sourceTag,
  });

  if (error === "AI binding unavailable") {
    return c.json(
      { content: [{ type: "text", text: "AI binding unavailable — cannot distill." }] },
      503
    );
  }

  if (error === "AI call returned empty response") {
    return c.json(
      { content: [{ type: "text", text: "AI call returned empty response." }] },
      502
    );
  }

  if (error && error.startsWith("AI call failed:")) {
    return c.json(
      { content: [{ type: "text", text: error }] },
      502
    );
  }

  if (error === "Could not parse LLM output") {
    return c.json({
      content: [{
        type: "text",
        text: `No memories extracted (could not parse LLM output). Raw snippet: ${(rawResponse || "").slice(0, 200)}`,
      }],
    });
  }

  if (stored.length === 0) {
    return c.json({
      content: [{ type: "text", text: "No novel memories found in transcript." }],
    });
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
