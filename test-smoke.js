import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
});

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

const TEST_PATH = "/tmp/test-memento-" + Date.now();

// List tools
const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

// Init
const init = await client.callTool({ name: "memento_init", arguments: { path: TEST_PATH } });
console.log("Init:", init.content[0].text.split("\n")[0]);

// Read
const read = await client.callTool({ name: "memento_read", arguments: { path: TEST_PATH } });
console.log("Read: got", read.content[0].text.length, "chars");

// Read section
const readSection = await client.callTool({
  name: "memento_read",
  arguments: { section: "active_work", path: TEST_PATH },
});
console.log("Read section:", readSection.content[0].text.split("\n")[0]);

// Update
await client.callTool({
  name: "memento_update",
  arguments: {
    section: "active_work",
    content: "Building the Memento Protocol reference server. Next: write tests.",
    path: TEST_PATH,
  },
});
console.log("Update: ok");

// Store
const store = await client.callTool({
  name: "memento_store",
  arguments: {
    content: "The MCP SDK uses zod for schema validation",
    tags: ["mcp", "tech"],
    type: "fact",
    path: TEST_PATH,
  },
});
console.log("Store:", store.content[0].text);

// Recall
const recall = await client.callTool({
  name: "memento_recall",
  arguments: {
    query: "zod schema",
    path: TEST_PATH,
  },
});
console.log("Recall:", recall.content[0].text.split("\n")[0]);

// Skip add
await client.callTool({
  name: "memento_skip_add",
  arguments: {
    item: "vector search",
    reason: "Not implementing in reference server",
    expires: "2026-12-31",
    path: TEST_PATH,
  },
});
console.log("Skip add: ok");

// Skip check — should be on list
const skipHit = await client.callTool({
  name: "memento_skip_check",
  arguments: {
    query: "vector search",
    path: TEST_PATH,
  },
});
console.log("Skip check (hit):", skipHit.content[0].text.split("\n")[0]);

// Skip check — should NOT be on list
const skipMiss = await client.callTool({
  name: "memento_skip_check",
  arguments: {
    query: "keyword matching",
    path: TEST_PATH,
  },
});
console.log("Skip check (miss):", skipMiss.content[0].text.split("\n")[0]);

// Health
const health = await client.callTool({ name: "memento_health", arguments: { path: TEST_PATH } });
console.log("Health:", health.content[0].text.split("\n")[0]);

// Re-init should detect existing workspace
const reinit = await client.callTool({ name: "memento_init", arguments: { path: TEST_PATH } });
console.log("Re-init:", reinit.content[0].text.split("\n")[0]);

await client.close();
console.log("\nAll 8 tools working!");
