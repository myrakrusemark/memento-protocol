/**
 * GET /api/messages
 * Returns recent contact form submissions and email subscriber signups
 * from the fathom-messages KV namespace.
 *
 * Protected by JWT middleware (_middleware.js).
 *
 * Response shape:
 * {
 *   contacts: [{ name, email, message, timestamp }],
 *   subscribers: [{ email, timestamp }]
 * }
 */

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.FATHOM_MESSAGES) {
    return new Response(JSON.stringify({ contacts: [], subscribers: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // List all keys — namespace is small, no prefix filter needed
  let keys = [];
  let cursor = undefined;
  do {
    const result = cursor
      ? await env.FATHOM_MESSAGES.list({ cursor })
      : await env.FATHOM_MESSAGES.list();
    keys = keys.concat(result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Fetch values in parallel, grouped by prefix
  const contactKeys = keys.filter((k) => k.name.startsWith("msg:"));
  const subscriberKeys = keys.filter((k) => k.name.startsWith("sub:"));

  const [contactValues, subscriberValues] = await Promise.all([
    Promise.all(contactKeys.map((k) => env.FATHOM_MESSAGES.get(k.name, "json"))),
    Promise.all(subscriberKeys.map((k) => env.FATHOM_MESSAGES.get(k.name, "json"))),
  ]);

  // Build and sort arrays, most recent first, cap at 10 each
  const contacts = contactValues
    .filter(Boolean)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 10);

  const subscribers = subscriberValues
    .filter(Boolean)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 10);

  return new Response(JSON.stringify({ contacts, subscribers }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
