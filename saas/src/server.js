/**
 * Memento SaaS API Server
 *
 * Hono-based REST API that mirrors the MCP tool interface.
 * Designed to be the proprietary hosted backend — separate from
 * the open-source MCP reference server.
 *
 * All responses use MCP tool output format:
 *   { "content": [{ "type": "text", "text": "..." }] }
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getControlDb, initSchema } from "./db/connection.js";
import { authMiddleware } from "./middleware/auth.js";
import { workspaceMiddleware } from "./middleware/workspace.js";
import workspaces from "./routes/workspaces.js";
import memories from "./routes/memories.js";
import workingMemory from "./routes/working-memory.js";
import workingMemoryItems from "./routes/working-memory-items.js";
import skipList from "./routes/skip-list.js";
import consolidation from "./routes/consolidation.js";
import identity from "./routes/identity.js";
import context from "./routes/context.js";
import health from "./routes/health.js";
import admin from "./routes/admin.js";
import distill from "./routes/distill.js";
import images from "./routes/images.js";
import { registerAuthRoutes } from "./routes/auth.js";

export function createApp() {
  const app = new Hono();

  // Global error handler — surface actual error messages
  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json(
      { content: [{ type: "text", text: `Server error: ${err.message}` }] },
      500
    );
  });

  // CORS — allow dashboard at hifathom.com
  app.use(
    "*",
    cors({
      origin: ["https://hifathom.com", "https://fathoms-log.pages.dev", "http://localhost:4321", "http://localhost:4242"],
      allowHeaders: ["Content-Type", "Authorization", "X-Memento-Workspace"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    })
  );

  // Health check (unauthenticated)
  app.get("/", (c) => {
    return c.json({
      content: [{ type: "text", text: "Memento SaaS API v0.1.0" }],
    });
  });

  // Auth routes (unauthenticated — signup, key management)
  registerAuthRoutes(app);

  // All /v1/* routes require auth + workspace resolution
  const v1 = new Hono();
  v1.use("*", authMiddleware());
  v1.use("*", workspaceMiddleware());

  // Mount route groups
  v1.route("/workspaces", workspaces);
  v1.route("/memories", memories);
  v1.route("/working-memory/items", workingMemoryItems);
  v1.route("/working-memory", workingMemory);
  v1.route("/skip-list", skipList);
  v1.route("/consolidate", consolidation);
  v1.route("/context", context);
  v1.route("/identity", identity);
  v1.route("/health", health);
  v1.route("/admin", admin);
  v1.route("/distill", distill);
  v1.route("/images", images);

  app.route("/v1", v1);

  return app;
}

// ---------------------------------------------------------------------------
// Start server when run directly
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/server.js") || process.argv[1].endsWith("\\server.js"));

if (isMainModule) {
  const port = parseInt(process.env.PORT || "3001", 10);

  // Initialize control plane schema
  const db = getControlDb();
  await initSchema(db, "all");

  const app = createApp();

  // Dynamic import so Workers bundler doesn't pull in Node-only deps
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Memento SaaS API running on http://localhost:${port}`);
  });
}
