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
import { extractMemories } from "../services/extraction.js";

const distill = new Hono();

const MIN_TRANSCRIPT_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 100_000;

const SYSTEM_PROMPT = `You are a memory extraction system. Read a conversation transcript and extract discrete memories worth remembering long-term.

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

  const { stored, rawResponse, error } = await extractMemories({
    env: c.env,
    db,
    workspaceName,
    encKey,
    transcript: cappedTranscript,
    systemPrompt: SYSTEM_PROMPT,
    maxMemories: 20,
    dedupLimit: 200,
    maxTokens: 2000,
    sourceTag: "source:distill:llama-3.1-8b",
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
