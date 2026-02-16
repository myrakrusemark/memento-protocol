/**
 * Consolidation routes.
 *
 * POST /v1/consolidate — Trigger memory consolidation for the workspace
 */

import { Hono } from "hono";
import { consolidateMemories } from "../services/consolidation.js";

const consolidation = new Hono();

// POST /v1/consolidate — Run consolidation
consolidation.post("/", async (c) => {
  const db = c.get("workspaceDb");
  const { consolidated, created } = await consolidateMemories(db);

  if (consolidated === 0) {
    return c.json({
      content: [
        {
          type: "text",
          text: "No consolidation candidates found (need 3+ memories sharing tags).",
        },
      ],
    });
  }

  return c.json({
    content: [
      {
        type: "text",
        text: `Consolidated ${consolidated} group${consolidated === 1 ? "" : "s"} (${created} memories total).`,
      },
    ],
  });
});

export default consolidation;
