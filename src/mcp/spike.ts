#!/usr/bin/env bun
// Minimal stdio lifecycle spike (task 3.1): initialize -> list tools -> call
// a tool, over the official SDK's StdioServerTransport under Bun 1.3+.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "radar-spike", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Minimal spike tool",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }
  throw new Error(`unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Lifecycle continues until stdin closes; log to stderr only (stdout is JSON-RPC).
console.error("[spike] stdio server running");
