/**
 * Graph traversal service for memory linkages.
 *
 * Provides BFS-based graph traversal and direct-connection lookup
 * for the memory linkage system. Memories link to each other via
 * a JSON `linkages` column containing typed references.
 */

/**
 * Parse a JSON string safely, returning fallback on failure.
 */
function safeParseJson(str, fallback = []) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

/**
 * Find memories that link TO a given memory (reverse lookup).
 *
 * Uses a LIKE query to find rows whose linkages JSON contains the target ID.
 * Then parses and filters to confirm the linkage actually references the ID
 * (avoids false positives from substring matches).
 *
 * @param {import("@libsql/client").Client} db
 * @param {string} memoryId
 * @returns {Promise<Array<{ id: string, linkages: Array }>>}
 */
async function findReverseLinks(db, memoryId) {
  const result = await db.execute({
    sql: `SELECT id, linkages FROM memories WHERE linkages LIKE ?`,
    args: [`%"id":"${memoryId}"%`],
  });

  // Filter to confirm actual linkage (not just substring match)
  const confirmed = [];
  for (const row of result.rows) {
    const linkages = safeParseJson(row.linkages, []);
    const hasLink = linkages.some(
      (l) => (l.type === "memory" || l.type === "item") && l.id === memoryId
    );
    if (hasLink && row.id !== memoryId) {
      confirmed.push({ id: row.id, linkages });
    }
  }

  return confirmed;
}

/**
 * Traverse the memory graph using BFS starting from a given memory.
 *
 * Follows outgoing linkages of type "memory" and also performs reverse
 * lookups to find memories that link TO each visited node.
 *
 * @param {import("@libsql/client").Client} db - Workspace database client
 * @param {string} startId - The memory ID to start traversal from
 * @param {number} [maxDepth=2] - Maximum BFS depth (capped at 5)
 * @returns {Promise<{ nodes: Array<{ id, content, type, tags, depth }>, edges: Array<{ from, to, label }> }>}
 */
export async function traverseGraph(db, startId, maxDepth = 2) {
  const nodes = [];
  const edges = [];
  const visited = new Set();

  let queue = [startId];
  let depth = 0;

  while (queue.length > 0 && depth <= maxDepth) {
    const nextQueue = [];

    for (const currentId of queue) {
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // Fetch the memory
      const result = await db.execute({
        sql: "SELECT id, content, type, tags, linkages FROM memories WHERE id = ?",
        args: [currentId],
      });

      if (result.rows.length === 0) continue;

      const row = result.rows[0];
      const tags = safeParseJson(row.tags, []);
      const linkages = safeParseJson(row.linkages, []);

      nodes.push({
        id: row.id,
        content: row.content,
        type: row.type,
        tags,
        depth,
      });

      // Process outgoing linkages
      for (const linkage of linkages) {
        if (linkage.type === "memory" && linkage.id) {
          edges.push({
            from: currentId,
            to: linkage.id,
            label: linkage.label || "related",
          });

          if (!visited.has(linkage.id) && depth < maxDepth) {
            nextQueue.push(linkage.id);
          }
        } else if (linkage.type === "file" && linkage.path) {
          // File linkages are recorded as edges but not traversed
          edges.push({
            from: currentId,
            to: `file:${linkage.path}`,
            label: linkage.label || "source",
          });
        }
      }

      // Reverse lookups: find memories that link TO this one
      if (depth < maxDepth) {
        const reverseLinks = await findReverseLinks(db, currentId);
        for (const rev of reverseLinks) {
          // Find the specific linkage entry pointing to currentId
          const matchingLinkage = rev.linkages.find(
            (l) => (l.type === "memory" || l.type === "item") && l.id === currentId
          );

          edges.push({
            from: rev.id,
            to: currentId,
            label: matchingLinkage?.label || "related",
          });

          if (!visited.has(rev.id)) {
            nextQueue.push(rev.id);
          }
        }
      }
    }

    queue = nextQueue;
    depth++;
  }

  // Deduplicate edges (same from/to pair may be found via forward and reverse)
  const edgeSet = new Set();
  const uniqueEdges = [];
  for (const edge of edges) {
    const key = `${edge.from}::${edge.to}::${edge.label}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push(edge);
    }
  }

  return { nodes, edges: uniqueEdges };
}

/**
 * Get direct connections for a memory (depth 1 only).
 *
 * Returns both outgoing linkages (from this memory's linkages column)
 * and incoming links (other memories that reference this one).
 *
 * @param {import("@libsql/client").Client} db - Workspace database client
 * @param {string} memoryId - The memory ID to look up
 * @returns {Promise<{ outgoing: Array<{ id, type, label }>, incoming: Array<{ id, type, label }> }>}
 */
export async function getRelated(db, memoryId) {
  // Fetch the memory's own linkages
  const result = await db.execute({
    sql: "SELECT linkages FROM memories WHERE id = ?",
    args: [memoryId],
  });

  const outgoing = [];
  if (result.rows.length > 0) {
    const linkages = safeParseJson(result.rows[0].linkages, []);
    for (const linkage of linkages) {
      if (linkage.type === "memory" || linkage.type === "item") {
        outgoing.push({
          id: linkage.id,
          type: linkage.type,
          label: linkage.label || "related",
        });
      } else if (linkage.type === "file") {
        outgoing.push({
          id: linkage.path,
          type: linkage.type,
          label: linkage.label || "source",
        });
      }
    }
  }

  // Reverse lookup: find memories that link TO this one
  const reverseLinks = await findReverseLinks(db, memoryId);
  const incoming = [];
  for (const rev of reverseLinks) {
    const matchingLinkage = rev.linkages.find(
      (l) => (l.type === "memory" || l.type === "item") && l.id === memoryId
    );
    incoming.push({
      id: rev.id,
      type: matchingLinkage?.type || "memory",
      label: matchingLinkage?.label || "related",
    });
  }

  return { outgoing, incoming };
}
