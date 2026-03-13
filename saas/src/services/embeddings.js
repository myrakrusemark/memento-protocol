/**
 * Embedding service for semantic recall.
 *
 * Uses Nomic Embed (text-v1.5 + vision-v1.5) for unified text+image embeddings
 * in a shared 768-dim vector space. Text and images are naturally cross-searchable.
 * Vectors stored in Cloudflare Vectorize.
 */

import { decryptField, isEncrypted } from "./crypto.js";

const NOMIC_TEXT_URL = "https://api-atlas.nomic.ai/v1/embedding/text";
const NOMIC_IMAGE_URL = "https://api-atlas.nomic.ai/v1/embedding/image";
const NOMIC_TEXT_MODEL = "nomic-embed-text-v1.5";
const NOMIC_IMAGE_MODEL = "nomic-embed-vision-v1.5";

/**
 * Embed a text string into a 768-dimension vector via Nomic.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array|null>} Embedding vector, or null if unavailable
 */
export async function embedText(env, text) {
  if (!env?.NOMIC_API_KEY) return null;

  const response = await fetch(NOMIC_TEXT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOMIC_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NOMIC_TEXT_MODEL,
      texts: [text],
      task_type: "search_document",
    }),
  });

  if (!response.ok) return null;

  const result = await response.json();
  if (!result?.embeddings?.[0]) return null;
  return new Float32Array(result.embeddings[0]);
}

/**
 * Embed a text query into a 768-dimension vector via Nomic.
 * Uses task_type "search_query" for asymmetric search.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} text - Query text to embed
 * @returns {Promise<Float32Array|null>} Embedding vector, or null if unavailable
 */
export async function embedQuery(env, text) {
  if (!env?.NOMIC_API_KEY) return null;

  const response = await fetch(NOMIC_TEXT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOMIC_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NOMIC_TEXT_MODEL,
      texts: [text],
      task_type: "search_query",
    }),
  });

  if (!response.ok) return null;

  const result = await response.json();
  if (!result?.embeddings?.[0]) return null;
  return new Float32Array(result.embeddings[0]);
}

/**
 * Embed an image into a 768-dimension vector via Nomic Vision.
 * Returns a vector in the same space as text embeddings — cross-modal search works naturally.
 *
 * @param {object} env - Workers environment bindings
 * @param {Uint8Array} imageBytes - Raw image bytes
 * @returns {Promise<Float32Array|null>} Embedding vector, or null if unavailable
 */
export async function embedImage(env, imageBytes) {
  if (!env?.NOMIC_API_KEY) return null;

  // Nomic vision API requires multipart/form-data with file uploads
  const formData = new FormData();
  formData.append("model", NOMIC_IMAGE_MODEL);
  formData.append("images", new Blob([imageBytes], { type: "image/jpeg" }), "image.jpg");

  const response = await fetch(NOMIC_IMAGE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOMIC_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) return null;

  const result = await response.json();
  if (!result?.embeddings?.[0]) return null;
  return new Float32Array(result.embeddings[0]);
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
  if (!env?.NOMIC_API_KEY || !env?.VECTORIZE) return false;

  const embedding = await embedText(env, content);
  if (!embedding) return false;

  const vectorId = `${workspaceId}:${memoryId}`;
  await env.VECTORIZE.upsert([
    {
      id: vectorId,
      values: Array.from(embedding),
      metadata: { workspace_id: workspaceId, memory_id: memoryId, type: "text" },
    },
  ]);

  return true;
}

/**
 * Embed an image and upsert the vector into the Vectorize index.
 * Vector ID format: {workspaceId}:{memoryId}:img:{imageIndex}
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier
 * @param {string} memoryId - Memory row ID
 * @param {Uint8Array} imageBytes - Raw image bytes
 * @param {number} imageIndex - Index of the image within the memory
 * @returns {Promise<boolean>} True if stored successfully, false otherwise
 */
export async function embedImageAndStore(env, workspaceId, memoryId, imageBytes, imageIndex) {
  if (!env?.NOMIC_API_KEY || !env?.VECTORIZE) return false;

  const embedding = await embedImage(env, imageBytes);
  if (!embedding) return false;

  const vectorId = `${workspaceId}:${memoryId}:img:${imageIndex}`;
  await env.VECTORIZE.upsert([
    {
      id: vectorId,
      values: Array.from(embedding),
      metadata: { workspace_id: workspaceId, memory_id: memoryId, type: "image", image_index: imageIndex },
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
/**
 * Deduplicate Vectorize matches by memory_id, keeping highest score per memory.
 * @param {Array} matches - Raw Vectorize match results
 * @returns {Array<{id: string, score: number, matched_image: boolean}>}
 */
function deduplicateVectorResults(matches) {
  const bestByMemory = new Map();
  for (const match of matches) {
    const memoryId = match.metadata?.memory_id || match.id.split(":")[1];
    const isImage = match.metadata?.type === "image";
    const existing = bestByMemory.get(memoryId);
    if (!existing || match.score > existing.score) {
      bestByMemory.set(memoryId, {
        id: memoryId,
        score: match.score,
        matched_image: isImage,
      });
    }
  }
  return Array.from(bestByMemory.values());
}

export async function semanticSearch(env, workspaceId, query, topK = 10) {
  if (!env?.NOMIC_API_KEY || !env?.VECTORIZE) return [];

  const embedding = await embedQuery(env, query);
  if (!embedding) return [];

  let results;
  try {
    results = await env.VECTORIZE.query(Array.from(embedding), {
      topK,
      filter: { workspace_id: workspaceId },
      returnMetadata: true,
    });
  } catch {
    return [];
  }

  if (!results?.matches) return [];
  return deduplicateVectorResults(results.matches);
}

/**
 * Search the Vectorize index using an image embedding.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier to filter by
 * @param {Uint8Array} imageBytes - Raw image bytes
 * @param {number} [topK=10] - Maximum results to return
 * @returns {Promise<Array<{id: string, score: number, matched_image: boolean}>>}
 */
export async function semanticImageSearch(env, workspaceId, imageBytes, topK = 10) {
  if (!env?.NOMIC_API_KEY || !env?.VECTORIZE) return [];

  const embedding = await embedImage(env, imageBytes);
  if (!embedding) return [];

  let results;
  try {
    results = await env.VECTORIZE.query(Array.from(embedding), {
      topK,
      filter: { workspace_id: workspaceId },
      returnMetadata: true,
    });
  } catch {
    return [];
  }

  if (!results?.matches) return [];
  return deduplicateVectorResults(results.matches);
}

/**
 * Multi-modal semantic search: text and/or images in parallel.
 * Merges results by memory_id, keeping the highest score from any modality.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier to filter by
 * @param {object} queries - { text?: string, images?: Uint8Array[] }
 * @param {number} [topK=10] - Maximum results per query
 * @returns {Promise<Array<{id: string, score: number, matched_image: boolean}>>}
 */
export async function semanticMultiSearch(env, workspaceId, { text, images }, topK = 10) {
  const searches = [];

  if (text) {
    searches.push(semanticSearch(env, workspaceId, text, topK));
  }

  if (images?.length > 0) {
    for (const imgBytes of images) {
      searches.push(semanticImageSearch(env, workspaceId, imgBytes, topK));
    }
  }

  if (searches.length === 0) return [];

  const allResults = await Promise.all(searches);

  // Merge by memory_id, keeping highest score
  const bestByMemory = new Map();
  for (const results of allResults) {
    for (const r of results) {
      const existing = bestByMemory.get(r.id);
      if (!existing || r.score > existing.score) {
        bestByMemory.set(r.id, r);
      }
    }
  }

  return Array.from(bestByMemory.values());
}

/**
 * Remove a text vector from the Vectorize index.
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
 * Remove image vectors from the Vectorize index for a given memory.
 *
 * @param {object} env - Workers environment bindings
 * @param {string} workspaceId - Workspace identifier
 * @param {string} memoryId - Memory row ID
 * @param {number} imageCount - Number of images to remove
 * @returns {Promise<boolean>} True if deleted, false if bindings unavailable
 */
export async function removeImageVectors(env, workspaceId, memoryId, imageCount) {
  if (!env?.VECTORIZE || imageCount === 0) return false;

  const ids = [];
  for (let i = 0; i < imageCount; i++) {
    ids.push(`${workspaceId}:${memoryId}:img:${i}`);
  }
  await env.VECTORIZE.deleteByIds(ids);
  return true;
}

/**
 * Backfill embeddings for all memories that haven't been embedded yet.
 * Re-embeds text with Nomic and embeds images from R2.
 * Processes in batches of 50 to stay within rate limits.
 *
 * @param {object} env - Workers environment bindings
 * @param {object} db - Workspace database client
 * @param {string} workspaceId - Workspace identifier
 * @param {CryptoKey|null} [encKey=null] - Workspace encryption key for decrypting content
 * @param {number} [batchLimit=100] - Max memories to process per call (to stay within subrequest limits)
 * @returns {Promise<{embedded: number, skipped: number, errors: number, images_embedded: number, images_errors: number, remaining: number}>}
 */
export async function backfillWorkspace(env, db, workspaceId, encKey = null, batchLimit = 100, { imagesOnly = false } = {}) {
  if (!env?.NOMIC_API_KEY || !env?.VECTORIZE) {
    return { embedded: 0, skipped: 0, errors: 0, images_embedded: 0, images_errors: 0, remaining: 0 };
  }

  let embedded = 0;
  let skipped = 0;
  let errors = 0;
  let images_embedded = 0;
  let images_errors = 0;
  let totalRemaining;

  if (imagesOnly) {
    // Images-only mode: find memories with images but no image_embedded_at
    const result = await db.execute({
      sql: `SELECT id, images FROM memories
            WHERE consolidated = 0 AND images IS NOT NULL AND images != '[]'
              AND image_embedded_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [batchLimit],
    });

    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM memories
            WHERE consolidated = 0 AND images IS NOT NULL AND images != '[]'
              AND image_embedded_at IS NULL`,
      args: [],
    });
    totalRemaining = countResult.rows[0].count;

    for (const row of result.rows) {
      let imagesMeta;
      try {
        imagesMeta = JSON.parse(row.images || "[]");
      } catch {
        imagesMeta = [];
      }

      let rowEmbedded = 0;
      if (imagesMeta.length > 0 && env?.IMAGES) {
        for (let idx = 0; idx < imagesMeta.length; idx++) {
          try {
            const obj = await env.IMAGES.get(imagesMeta[idx].key);
            if (!obj) continue;
            const imageBytes = new Uint8Array(await obj.arrayBuffer());
            const success = await embedImageAndStore(env, workspaceId, row.id, imageBytes, idx);
            if (success) {
              images_embedded++;
              rowEmbedded++;
            }
          } catch {
            images_errors++;
          }
        }

        if (rowEmbedded > 0) {
          await db.execute({
            sql: "UPDATE memories SET image_embedded_at = datetime('now') WHERE id = ?",
            args: [row.id],
          }).catch(() => {});
        }
      }
    }

    const remaining = Math.max(0, totalRemaining - result.rows.length);
    return { embedded: 0, skipped: 0, errors: 0, images_embedded, images_errors, remaining };
  }

  // Standard mode: process memories that haven't been text-embedded yet
  const result = await db.execute({
    sql: `SELECT id, content, images FROM memories
          WHERE consolidated = 0 AND embedded_at IS NULL
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [batchLimit],
  });

  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM memories WHERE consolidated = 0 AND embedded_at IS NULL`,
    args: [],
  });
  totalRemaining = countResult.rows[0].count;

  const rows = result.rows;
  const BATCH_SIZE = 50;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    for (const row of batch) {
      // Decrypt content if needed
      let plaintext = row.content;
      if (encKey && plaintext && isEncrypted(plaintext)) {
        try {
          plaintext = await decryptField(plaintext, encKey);
        } catch {
          errors++;
          continue;
        }
      }

      // Re-embed text
      if (!plaintext || plaintext.trim().length === 0) {
        skipped++;
      } else {
        try {
          const success = await embedAndStore(env, workspaceId, row.id, plaintext);
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

      // Embed images from R2
      let imagesMeta;
      try {
        imagesMeta = JSON.parse(row.images || "[]");
      } catch {
        imagesMeta = [];
      }

      if (imagesMeta.length > 0 && env?.IMAGES) {
        for (let idx = 0; idx < imagesMeta.length; idx++) {
          try {
            const obj = await env.IMAGES.get(imagesMeta[idx].key);
            if (!obj) continue;
            const imageBytes = new Uint8Array(await obj.arrayBuffer());
            const success = await embedImageAndStore(env, workspaceId, row.id, imageBytes, idx);
            if (success) {
              images_embedded++;
            }
          } catch {
            images_errors++;
          }
        }

        if (images_embedded > 0) {
          await db.execute({
            sql: "UPDATE memories SET image_embedded_at = datetime('now') WHERE id = ?",
            args: [row.id],
          }).catch(() => {});
        }
      }
    }
  }

  const remaining = totalRemaining - embedded - skipped - errors;
  return { embedded, skipped, errors, images_embedded, images_errors, remaining: Math.max(0, remaining) };
}
