import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

/**
 * In-memory R2 bucket mock for testing image upload/download/delete.
 */
class MockR2Bucket {
  constructor() {
    this.store = new Map();
  }

  async put(key, value, options) {
    this.store.set(key, { body: value, httpMetadata: options?.httpMetadata });
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async delete(key) {
    this.store.delete(key);
  }
}

/** Create a tiny 1x1 PNG as base64 for testing. */
function tinyPngBase64() {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
    0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
    0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// Tests without R2 (graceful degradation)
// ---------------------------------------------------------------------------

describe("memories with images (no R2)", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("POST /v1/memories — stores memory with images metadata even without R2", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "Photo of a sunset",
      tags: ["photo"],
      images: [{ data: tinyPngBase64(), filename: "sunset.png", mimetype: "image/png" }],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("1 image"));
  });

  it("POST /v1/memories — stores memory without images (backward compat)", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "Just text, no images",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(!body.content[0].text.includes("image"));
  });
});

// ---------------------------------------------------------------------------
// Tests with mock R2
// ---------------------------------------------------------------------------

describe("memories with images (mock R2)", () => {
  let h;
  let mockR2;

  beforeEach(async () => {
    mockR2 = new MockR2Bucket();
    h = await createTestHarness({ IMAGES: mockR2 });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("POST /v1/memories — uploads image to R2 and stores metadata", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "Photo of a cat",
      images: [{ data: tinyPngBase64(), filename: "cat.png", mimetype: "image/png" }],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("1 image"));

    // Verify R2 received the upload
    assert.equal(mockR2.store.size, 1);
    const key = [...mockR2.store.keys()][0];
    assert.ok(key.includes("cat.png"));

    // Verify DB has images metadata
    const id = body.content[0].text.match(/Stored memory (\S+)/)[1];
    const dbResult = await h.db.execute({
      sql: "SELECT images FROM memories WHERE id = ?",
      args: [id],
    });
    const images = JSON.parse(dbResult.rows[0].images);
    assert.equal(images.length, 1);
    assert.equal(images[0].filename, "cat.png");
    assert.equal(images[0].mimetype, "image/png");
    assert.ok(images[0].size > 0);
  });

  it("POST /v1/memories — rejects more than 5 images", async () => {
    const images = Array.from({ length: 6 }, (_, i) => ({
      data: tinyPngBase64(),
      filename: `img${i}.png`,
      mimetype: "image/png",
    }));
    const res = await h.request("POST", "/v1/memories", {
      content: "Too many images",
      images,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Maximum 5"));
  });

  it("POST /v1/memories — rejects unsupported mimetype", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "Bad type",
      images: [{ data: tinyPngBase64(), filename: "doc.pdf", mimetype: "application/pdf" }],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Unsupported image type"));
  });

  it("POST /v1/memories — rejects image missing required fields", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "Missing fields",
      images: [{ data: tinyPngBase64() }],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("requires data"));
  });

  it("GET /v1/memories/:id — includes images in response", async () => {
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Memory with image",
      images: [{ data: tinyPngBase64(), filename: "photo.png", mimetype: "image/png" }],
    });
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    const res = await h.request("GET", `/v1/memories/${id}`);
    const body = await res.json();
    assert.equal(body.images.length, 1);
    assert.equal(body.images[0].filename, "photo.png");
  });

  it("GET /v1/memories/recall — includes image info in formatted output", async () => {
    await h.request("POST", "/v1/memories", {
      content: "Searchable photo memory",
      images: [{ data: tinyPngBase64(), filename: "search.png", mimetype: "image/png" }],
    });

    const res = await h.request("GET", "/v1/memories/recall?query=searchable+photo");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Images:"));
    assert.ok(body.content[0].text.includes("1 image"));
    assert.ok(body.content[0].text.includes("/v1/images/"));
  });

  it("GET /v1/memories/recall?format=json — returns structured data with images", async () => {
    await h.request("POST", "/v1/memories", {
      content: "JSON recall photo memory",
      tags: ["photo", "test"],
      images: [{ data: tinyPngBase64(), filename: "json-recall.png", mimetype: "image/png" }],
    });

    const res = await h.request("GET", "/v1/memories/recall?query=JSON+recall+photo&format=json");
    assert.equal(res.status, 200);
    const body = await res.json();

    // Should have text summary
    assert.ok(body.text);
    assert.ok(body.text.includes("Found"));

    // Should have structured memories array
    assert.ok(Array.isArray(body.memories));
    assert.ok(body.memories.length > 0);

    const mem = body.memories[0];
    assert.ok(mem.id);
    assert.equal(mem.content, "JSON recall photo memory");
    assert.ok(Array.isArray(mem.tags));
    assert.ok(mem.tags.includes("photo"));
    assert.ok(Array.isArray(mem.images));
    assert.equal(mem.images.length, 1);
    assert.equal(mem.images[0].filename, "json-recall.png");
    assert.equal(mem.images[0].mimetype, "image/png");
    assert.ok(mem.images[0].key);
    assert.ok(typeof mem.relevance_score === "number");

    // Should NOT have MCP content envelope
    assert.equal(body.content, undefined);
  });

  it("GET /v1/memories/recall?format=json — returns empty array for no matches", async () => {
    const res = await h.request("GET", "/v1/memories/recall?query=nonexistent+gibberish&format=json");
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.text.includes("No memories found"));
    assert.deepEqual(body.memories, []);
  });

  it("GET /v1/memories — includes images in list response", async () => {
    await h.request("POST", "/v1/memories", {
      content: "Listed memory with image",
      images: [{ data: tinyPngBase64(), filename: "list.png", mimetype: "image/png" }],
    });

    const res = await h.request("GET", "/v1/memories");
    const body = await res.json();
    assert.ok(body.memories.length > 0);
    const mem = body.memories.find((m) => m.content === "Listed memory with image");
    assert.ok(mem);
    assert.equal(mem.images.length, 1);
    assert.equal(mem.images[0].filename, "list.png");
  });

  it("DELETE /v1/memories/:id — deletes R2 images", async () => {
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Memory to delete with image",
      images: [{ data: tinyPngBase64(), filename: "delete-me.png", mimetype: "image/png" }],
    });
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    assert.equal(mockR2.store.size, 1);

    const res = await h.request("DELETE", `/v1/memories/${id}`);
    assert.equal(res.status, 200);

    // R2 image should be cleaned up
    assert.equal(mockR2.store.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Image serving route
// ---------------------------------------------------------------------------

describe("image serving (GET /v1/images)", () => {
  let h;
  let mockR2;

  beforeEach(async () => {
    mockR2 = new MockR2Bucket();
    h = await createTestHarness({ IMAGES: mockR2 });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("GET /v1/images/:workspace/:memoryId/:filename — serves image from R2", async () => {
    // Store a memory with an image first
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Serve this image",
      images: [{ data: tinyPngBase64(), filename: "serve.png", mimetype: "image/png" }],
    });
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    const res = await h.request("GET", `/v1/images/${h.seed.workspaceName}/${id}/serve.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000");
  });

  it("GET /v1/images — returns 404 for nonexistent image", async () => {
    const res = await h.request("GET", `/v1/images/${h.seed.workspaceName}/fakeid/nope.png`);
    assert.equal(res.status, 404);
  });

  it("GET /v1/images — returns 403 for wrong workspace", async () => {
    const res = await h.request("GET", "/v1/images/other-workspace/fakeid/nope.png");
    assert.equal(res.status, 403);
  });
});
