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

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000",
    },
  });
});

export default images;
