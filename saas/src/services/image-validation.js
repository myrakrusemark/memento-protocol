/**
 * Shared validation for search images (base64-encoded).
 * Used by POST /v1/memories/recall and POST /v1/context.
 */

const MAX_SEARCH_IMAGES = 3;
const MAX_SEARCH_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Validate and decode an array of search images.
 *
 * @param {Array<{data: string, mimetype: string}>} images - Base64-encoded images
 * @returns {{ decoded: Uint8Array[] } | { error: string }}
 */
export function validateSearchImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return { error: "images must be a non-empty array." };
  }

  if (images.length > MAX_SEARCH_IMAGES) {
    return { error: `Maximum ${MAX_SEARCH_IMAGES} search images allowed.` };
  }

  const decoded = [];
  for (const img of images) {
    if (!img.data || !img.mimetype) {
      return { error: "Each image requires data (base64) and mimetype." };
    }
    if (!ALLOWED_TYPES.has(img.mimetype)) {
      return { error: `Unsupported image type: ${img.mimetype}. Allowed: ${[...ALLOWED_TYPES].join(", ")}` };
    }

    let bytes;
    try {
      bytes = Uint8Array.from(atob(img.data), (ch) => ch.charCodeAt(0));
    } catch {
      return { error: "Invalid base64 image data." };
    }

    if (bytes.byteLength > MAX_SEARCH_IMAGE_BYTES) {
      return { error: `Image exceeds ${MAX_SEARCH_IMAGE_BYTES / 1024 / 1024}MB limit.` };
    }

    decoded.push(bytes);
  }

  return { decoded };
}
