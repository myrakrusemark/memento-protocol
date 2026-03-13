/**
 * Image serving route.
 *
 * GET /v1/images/:workspace/:memoryId/:filename — Serve an image from R2
 *
 * Requires auth (via v1 middleware). Verifies the requesting workspace
 * matches the :workspace param to prevent cross-workspace access.
 */

import { Hono } from "hono";

const images = new Hono();

// GET /v1/images/:workspace/:memoryId/:filename
images.get("/:workspace/:memoryId/:filename", async (c) => {
  const workspace = c.req.param("workspace");
  const memoryId = c.req.param("memoryId");
  const filename = c.req.param("filename");

  // Verify workspace matches the authenticated user's workspace
  const userWorkspace = c.get("workspaceName");
  if (workspace !== userWorkspace) {
    return c.json({ error: "Forbidden: workspace mismatch." }, 403);
  }

  if (!c.env?.IMAGES) {
    return c.json({ error: "Image storage not available." }, 503);
  }

  const key = `${workspace}/${memoryId}/${filename}`;
  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.json({ error: "Image not found." }, 404);
  }

  // Some images were stored as JSON-wrapped base64 ({"data":"...","mimetype":"..."})
  // by an older version. Detect and unwrap them; pass raw binary through directly.
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType || "application/octet-stream";

  if (bytes[0] === 0x7b) {
    // Starts with '{' — likely JSON-wrapped base64
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      if (json.data) {
        const raw = Uint8Array.from(atob(json.data), (ch) => ch.charCodeAt(0));
        return new Response(raw, {
          headers: {
            "Content-Type": json.mimetype || contentType,
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
    } catch {
      // Not valid JSON — fall through to raw response
    }
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export default images;
