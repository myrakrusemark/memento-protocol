/**
 * POST /api/logout
 * Clears the auth cookie.
 */

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    },
  });
}
