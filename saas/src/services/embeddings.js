/**
 * Embedding service for semantic recall.
 *
 * Uses Cloudflare Workers AI (@cf/baai/bge-small-en-v1.5) for embeddings
 * and Vectorize for vector storage/search. All functions degrade gracefully
 * when AI or Vectorize bindings are unavailable (local dev, free tier).
 */

/**
 * Embed a text string into a 384-dimension vector.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array|null>} Embedding vector, or null if bindings unavailable
 */
export async function embedText(env, text) {
  if (!env?.AI) return null;

  const result = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: [text],
  });

  if (!result?.data?.[0]) return null;
  return new Float32Array(result.data[0]);
}

/**
 * Embed text and upsert the vector into the Vectorize index.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier (used as namespace prefix)
 * @param {string} memoryId - Memory row ID
 * @param {string} content - Memory content to embed
 * @returns {Promise<boolean>} True if stored successfully, false otherwise
 */
export async function embedAndStore(env, workspaceId, memoryId, content) {
  if (!env?.AI || !env?.VECTORIZE) return false;

  const embedding = await embedText(env, content);
  if (!embedding) return false;

  const vectorId = `${workspaceId}:${memoryId}`;
  await env.VECTORIZE.upsert([
    {
      id: vectorId,
      values: Array.from(embedding),
      metadata: { workspace_id: workspaceId, memory_id: memoryId },
    },
  ]);

  return true;
}

/**
 * Search the Vectorize index for memories semantically similar to a query.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier to filter by
 * @param {string} query - Natural language query
 * @param {number} [topK=10] - Maximum results to return
 * @returns {Promise<Array<{id: string, score: number}>>} Matching memory IDs with scores
 */
export async function semanticSearch(env, workspaceId, query, topK = 10) {
  if (!env?.AI || !env?.VECTORIZE) return [];

  const embedding = await embedText(env, query);
  if (!embedding) return [];

  const results = await env.VECTORIZE.query(Array.from(embedding), {
    topK,
    filter: { workspace_id: workspaceId },
    returnMetadata: true,
  });

  if (!results?.matches) return [];

  return results.matches.map((match) => ({
    id: match.metadata?.memory_id || match.id.split(":").pop(),
    score: match.score,
  }));
}

/**
 * Remove a vector from the Vectorize index.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier
 * @param {string} memoryId - Memory row ID to remove
 * @returns {Promise<boolean>} True if deleted, false if bindings unavailable
 */
export async function removeVector(env, workspaceId, memoryId) {
  if (!env?.VECTORIZE) return false;

  const vectorId = `${workspaceId}:${memoryId}`;
  await env.VECTORIZE.deleteByIds([vectorId]);
  return true;
}

/**
 * Backfill embeddings for all memories that haven't been embedded yet.
 * Processes in batches of 50 to stay within Workers AI rate limits.
 *
 * @param {object} env - Workers environment bindings
 * @param {object} db - Workspace database client
 * @param {string} workspaceId - Workspace identifier
 * @returns {Promise<{embedded: number, skipped: number, errors: number}>}
 */
export async function backfillWorkspace(env, db, workspaceId) {
  if (!env?.AI || !env?.VECTORIZE) {
    return { embedded: 0, skipped: 0, errors: 0 };
  }

  const result = await db.execute({
    sql: `SELECT id, content FROM memories
          WHERE embedded_at IS NULL AND consolidated = 0
          ORDER BY created_at DESC`,
    args: [],
  });

  let embedded = 0;
  let skipped = 0;
  let errors = 0;

  const rows = result.rows;
  const BATCH_SIZE = 50;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    for (const row of batch) {
      if (!row.content || row.content.trim().length === 0) {
        skipped++;
        continue;
      }

      try {
        const success = await embedAndStore(env, workspaceId, row.id, row.content);
        if (success) {
          await db.execute({
            sql: "UPDATE memories SET embedded_at = datetime('now') WHERE id = ?",
            args: [row.id],
          });
          embedded++;
        } else {
          skipped++;
        }
      } catch {
        errors++;
      }
    }
  }

  return { embedded, skipped, errors };
}
