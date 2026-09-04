import { describe, expect, it } from "vitest";

import { ambientEndpoints, isAmbientEndpoint, suggestedEndpoint } from "../src/ambient.js";

describe("ambientEndpoints", () => {
  it("is empty when nothing is configured", () => {
    expect(ambientEndpoints({})).toEqual([]);
    expect(ambientEndpoints({ MCP_AMBIENT_ENDPOINTS: "" })).toEqual([]);
    expect(ambientEndpoints({ MCP_AMBIENT_ENDPOINTS: " , ," })).toEqual([]);
  });

  it("splits, trims, canonicalizes, and dedupes", () => {
    expect(ambientEndpoints({
      MCP_AMBIENT_ENDPOINTS: " https://gateway.example.com/mcp ,https://GATEWAY.example.com/mcp, https://other.example.com/mcp",
    })).toEqual(["https://gateway.example.com/mcp", "https://other.example.com/mcp"]);
  });

  it("drops entries that are not endpoints", () => {
    expect(ambientEndpoints({
      MCP_AMBIENT_ENDPOINTS: "not a url,ftp://x.example.com/mcp,https://a.example.com/mcp#tool=list,https://b.example.com/mcp",
    })).toEqual(["https://b.example.com/mcp"]);
  });
});

describe("isAmbientEndpoint", () => {
  const env = { MCP_AMBIENT_ENDPOINTS: "https://gateway.example.com/mcp" };

  it("matches the whole endpoint, ignoring a scope fragment on the candidate", () => {
    expect(isAmbientEndpoint(env, "https://gateway.example.com/mcp")).toBe(true);
    expect(isAmbientEndpoint(env, "https://gateway.example.com/mcp#tool=a")).toBe(true);
  });

  it("does not match another path on the same host, nor anything when unconfigured", () => {
    expect(isAmbientEndpoint(env, "https://gateway.example.com/mcp-v2")).toBe(false);
    expect(isAmbientEndpoint(env, "https://gateway.example.com/")).toBe(false);
    expect(isAmbientEndpoint({}, "https://gateway.example.com/mcp")).toBe(false);
    expect(isAmbientEndpoint(env, "::garbage::")).toBe(false);
  });
});

describe("suggestedEndpoint", () => {
  it("prefills only when exactly one endpoint is listed", () => {
    expect(suggestedEndpoint({})).toBeUndefined();
    expect(suggestedEndpoint({ MCP_AMBIENT_ENDPOINTS: "https://a.example.com/mcp" }))
      .toBe("https://a.example.com/mcp");
    expect(suggestedEndpoint({
      MCP_AMBIENT_ENDPOINTS: "https://a.example.com/mcp,https://b.example.com/mcp",
    })).toBeUndefined();
  });
});
