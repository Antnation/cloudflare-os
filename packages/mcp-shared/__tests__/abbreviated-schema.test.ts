// Green Hat fork: an oversized input schema is abbreviated to its top-level fields rather than
// dropped, and a server that declines a call before running it is reported as such.
import { describe, expect, it, vi } from "vitest";
import {
  abbreviateSchema,
  callMayHaveTakenEffect,
  clampToolDefinition,
  McpClient,
  McpDeclinedCallError,
  type JsonSchema,
} from "../src/client.js";
import { generateSessionTypes } from "../src/schema-to-ts.js";
import type { ClassifiedTool } from "../src/tools.js";

function generate(tools: ClassifiedTool[]): string {
  return generateSessionTypes({
    baseTypes: "// base\n",
    serverId: "acme-crm",
    serverName: "Acme CRM",
    endpoint: "https://acme.example/mcp",
    discriminator: "https://acme.example/mcp",
    trust: "byo",
    tools,
  });
}

// A Twenty-CRM-shaped company: many wide fields, one nested Links object, one big enum.
function wideSchema(fields = 53): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    name: { type: "string", description: "The company name" },
    domainName: {
      type: "object",
      description: "The company website URL. We use this url to fetch the company icon",
      properties: {
        primaryLinkLabel: { type: "string" },
        primaryLinkUrl: { type: "string" },
        secondaryLinks: {
          type: "array",
          items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } } },
        },
      },
    },
    pdlIndustry: { type: "string", enum: Array.from({ length: 150 }, (_, i) => `industry_${i}`) },
  };
  for (let i = Object.keys(properties).length; i < fields; i++) {
    properties[`field${i}`] = {
      type: "object",
      description: "d".repeat(300),
      properties: Object.fromEntries(
        Array.from({ length: 6 }, (_, j) => [`sub${j}`, { type: "string", description: "x".repeat(60) }])),
    };
  }
  return { type: "object", properties, required: ["name"], additionalProperties: false };
}

describe("abbreviateSchema", () => {
  it("keeps every top-level field, its type and requiredness, and names nested fields", () => {
    const full = wideSchema();
    const chars = JSON.stringify(full).length;
    expect(chars).toBeGreaterThan(20_000);

    const abbreviated = abbreviateSchema(full, chars)!;
    expect(JSON.stringify(abbreviated).length).toBeLessThanOrEqual(4_000);
    expect(abbreviated.required).toEqual(["name"]);
    expect(abbreviated.additionalProperties).toBe(false);
    expect(abbreviated.description).toContain(`${chars} characters`);
    expect(abbreviated.properties!.name).toMatchObject({ type: "string" });
    expect(abbreviated.properties!.domainName.type).toBe("object");
    expect(abbreviated.properties!.domainName.description)
      .toContain("Object with fields: primaryLinkLabel, primaryLinkUrl, secondaryLinks");
    // A big enum is not carried; the type is.
    expect(abbreviated.properties!.pdlIndustry).toEqual({ type: "string" });
    // Nested schemas never survive: that is what made the original too large.
    for (const property of Object.values(abbreviated.properties!)) {
      expect(property.properties).toBeUndefined();
    }
  });

  it("trims descriptions, then optional fields, to stay within the bound", () => {
    const full = wideSchema(400);
    const abbreviated = abbreviateSchema(full, JSON.stringify(full).length)!;
    expect(JSON.stringify(abbreviated).length).toBeLessThanOrEqual(4_000);
    // The required field is always kept, ahead of the optional tail.
    expect(Object.keys(abbreviated.properties!)).toContain("name");
    expect(Object.keys(abbreviated.properties!).length).toBeLessThan(400);
  });

  it("has nothing to abbreviate without top-level properties", () => {
    expect(abbreviateSchema({ type: "object", description: "y".repeat(30_000) }, 30_000))
      .toBeUndefined();
  });
});

describe("clampToolDefinition with an oversized schema", () => {
  it("stores the abbreviation, and the generated method stays typed on the real fields", () => {
    const tool = clampToolDefinition({
      name: "createOneCompany", description: "Create One company", inputSchema: wideSchema(),
    });
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema!.description).toContain("Abbreviated");

    const output = generate([
      { tool, mode: "action", autoApprovable: false, classifiedBy: "server-annotation" },
    ]);
    expect(output).toMatch(/createOneCompany\(args: \w+_CreateOneCompanyArgs\)/);
    expect(output).toContain("domainName?: Record<string, unknown>");
    expect(output).toContain("Object with fields: primaryLinkLabel, primaryLinkUrl, secondaryLinks");
    expect(output).not.toContain('callTool(name: "createOneCompany", args?: Record<string, never>)');
  });

  it("still drops a schema that is oversized without being an object", () => {
    const tool = clampToolDefinition({
      name: "blob", inputSchema: { type: "object", description: "y".repeat(30_000) },
    });
    expect(tool.inputSchema).toBeUndefined();
  });
});

describe("tools/call rejected by JSON-RPC before dispatch", () => {
  function stubRpcError(code: number, message: string, data?: unknown) {
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).id;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("treats invalid params as declined: the server refused the arguments, nothing ran", async () => {
    stubRpcError(-32602,
      "tool 'createOneCompany' arguments failed input schema validation: : unexpected argument 'domain'",
      { tool_name: "createOneCompany", reason: "invalid_params" });
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const err = await client.callTool("createOneCompany", { domain: "x" }).catch(caught => caught);
    expect(err.message).toContain("unexpected argument 'domain'");
    expect(callMayHaveTakenEffect(err)).toBe(false);
  });

  it("treats an unknown method or malformed request as declined", async () => {
    for (const code of [-32601, -32600]) {
      stubRpcError(code, "no such tool");
      const client = new McpClient("https://mcp.example.com/mcp", async () => null);
      const err = await client.callTool("nope", {}).catch(caught => caught);
      expect(callMayHaveTakenEffect(err)).toBe(false);
    }
  });

  it("keeps a partially executed composite, and any other code, unknown", async () => {
    stubRpcError(-32602, "composite failed", { failed_step: "create", reason: "invalid_params" });
    let client = new McpClient("https://mcp.example.com/mcp", async () => null);
    let err = await client.callTool("composite", {}).catch(caught => caught);
    expect(callMayHaveTakenEffect(err)).toBe(true);

    stubRpcError(-32603, "tool invocation failed");
    client = new McpClient("https://mcp.example.com/mcp", async () => null);
    err = await client.callTool("send", {}).catch(caught => caught);
    expect(callMayHaveTakenEffect(err)).toBe(true);
  });

  it("marks the action store's wrapper as declined too", () => {
    const err = new McpDeclinedCallError("The server declined this call before running it", new Error("x"));
    expect(callMayHaveTakenEffect(err)).toBe(false);
  });
});
