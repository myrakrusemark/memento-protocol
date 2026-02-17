import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.MEMENTO_API_KEY || !process.env.MEMENTO_API_URL) {
  console.error(
    "Smoke tests require MEMENTO_API_KEY and MEMENTO_API_URL environment variables."
  );
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: {
    ...process.env,
  },
});

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

// List tools
const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

// Health
const health = await client.callTool({ name: "memento_health", arguments: {} });
console.log("Health:", health.content[0].text.split("\n")[0]);

// Init (should report already exists for an existing workspace)
const init = await client.callTool({ name: "memento_init", arguments: {} });
console.log("Init:", init.content[0].text.split("\n")[0]);

// Store
const store = await client.callTool({
  name: "memento_store",
  arguments: {
    content: "Smoke test memory — safe to delete",
    tags: ["smoke-test"],
    type: "observation",
  },
});
console.log("Store:", store.content[0].text);

// Recall
const recall = await client.callTool({
  name: "memento_recall",
  arguments: { query: "smoke test" },
});
console.log("Recall:", recall.content[0].text.split("\n")[0]);

// Skip add
await client.callTool({
  name: "memento_skip_add",
  arguments: {
    item: "smoke test skip",
    reason: "Testing skip list",
    expires: "2099-12-31",
  },
});
console.log("Skip add: ok");

// Skip check — should be on list
const skipHit = await client.callTool({
  name: "memento_skip_check",
  arguments: { query: "smoke test skip" },
});
console.log("Skip check (hit):", skipHit.content[0].text.split("\n")[0]);

// Skip check — should NOT be on list
const skipMiss = await client.callTool({
  name: "memento_skip_check",
  arguments: { query: "nonexistent item xyz" },
});
console.log("Skip check (miss):", skipMiss.content[0].text.split("\n")[0]);

// Read working memory
const read = await client.callTool({ name: "memento_read", arguments: {} });
console.log("Read: got", read.content[0].text.length, "chars");

await client.close();
console.log("\nAll smoke tests passed!");
