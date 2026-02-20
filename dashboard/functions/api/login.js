/**
 * POST /api/login
 * Authenticates admin user and returns JWT in HttpOnly cookie.
 */

import { verifyPassword, createJwt, buildCookieHeader } from "../../lib/auth.js";
import { recordLoginAttempt } from "./_middleware.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = context.data?.clientIp || "unknown";

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { username, password } = body;
  if (!username || !password) {
    return new Response(JSON.stringify({ error: "Invalid credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check username
  if (username !== env.ADMIN_USER) {
    recordLoginAttempt(ip);
    return new Response(JSON.stringify({ error: "Invalid credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify password
  const valid = await verifyPassword(password, env.ADMIN_PASS_HASH);
  if (!valid) {
    recordLoginAttempt(ip);
    return new Response(JSON.stringify({ error: "Invalid credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create JWT
  const token = await createJwt({ sub: username, role: "admin" }, env.JWT_SECRET);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildCookieHeader(token),
    },
  });
}
