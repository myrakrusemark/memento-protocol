/**
 * Cloudflare Workers entry point for Memento SaaS API.
 *
 * Hono runs natively on Workers -- just export the app's fetch handler.
 * Environment variables are passed via the `env` parameter in Workers,
 * but @libsql/client reads from process.env. We bridge them here.
 */

import { createApp } from "./server.js";
import { getControlDb, initSchema } from "./db/connection.js";

let initialized = false;

const app = createApp();

export default {
  async fetch(request, env, ctx) {
    // Bridge Workers env bindings to process.env for libsql and our code
    if (env.MEMENTO_DB_URL) process.env.MEMENTO_DB_URL = env.MEMENTO_DB_URL;
    if (env.MEMENTO_DB_TOKEN) process.env.MEMENTO_DB_TOKEN = env.MEMENTO_DB_TOKEN;
    if (env.TURSO_API_TOKEN) process.env.TURSO_API_TOKEN = env.TURSO_API_TOKEN;
    if (env.TURSO_ORG) process.env.TURSO_ORG = env.TURSO_ORG;
    if (env.TURSO_GROUP) process.env.TURSO_GROUP = env.TURSO_GROUP;

    // Initialize control plane schema on first request
    if (!initialized) {
      const db = getControlDb();
      await initSchema(db, "control");
      initialized = true;
    }

    return app.fetch(request, env, ctx);
  },
};
