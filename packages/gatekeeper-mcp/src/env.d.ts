// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_ALLOW_INSECURE?: string;
    MCP_CLIENT_NAME?: string;
    /** Comma-separated endpoints whose accounts become always-available capsules; see ambient.ts. */
    MCP_AMBIENT_ENDPOINTS?: string;
    /** Green Hat fork: how the vendor presents itself in the Workshop; defaults to "MCP Server". */
    MCP_DISPLAY_NAME?: string;
    MCP_TAGLINE?: string;
    MCP_DESCRIPTION?: string;
    /**
     * Green Hat fork: path, on an ambient endpoint's origin, of a JSON listing of the systems
     * connected behind it (GreenGateway's `GET /v1/admin/connections` shape), fetched with the
     * account's own bearer for the Integrations page. Defaults to /v1/admin/connections.
     */
    MCP_CONNECTIONS_PATH?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./mcp.js");
    durableNamespaces: "McpAccount" | "McpGatekeeperImpl";
  }
}

interface Env extends Cloudflare.Env {}
