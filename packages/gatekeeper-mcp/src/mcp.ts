// The MCP gatekeeper: connects any Model Context Protocol server as a Gadgets capability.
//
// Every call is either an observation or an approval-gated action, `readOnlyHint` decides which,
// writes are queued rather than performed inline, and per-tool TypeScript is generated from the
// server's schemas so Gadget code gets typed methods.
//
// The endpoint is whatever a user typed, so annotations never earn auto-approval here and a Gadget
// bound to it is owner-only. See `sharing-policy.ts` and the README.
import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  stripTrailingSlashes,
  type AccountDescription,
  type AgentCatalog,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationAuthorizer,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ToolCatalog } from "@gadgets/mcp-shared/client";
import {
  classifyTool,
  MAX_TOOLS_PER_SERVER,
  type ServerTrust,
} from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { fetchTools, withClient, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import { looksLikePortal } from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  requireCompleteCatalogForToolSelection,
  sameEndpoint,
  scopeAllows,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import { validateCustomEndpoint } from "@gadgets/mcp-shared/endpoint";
import { fetchOptions, sdkFetch } from "@gadgets/mcp-shared/fetch";
import type { AccountDetails } from "@gadgets/workshop-shared/gatekeeper";
import {
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import { connectFormHtml } from "./connect-form.js";
import { isAmbientEndpoint, suggestedEndpoint } from "./ambient.js";
import { serverIdFromEndpoint } from "./server-id.js";
import { mcpResourceFor, mcpResources } from "./resources.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import MCP_LOGO_SVG from "./mcp-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";

const VENDOR_ID = "mcp";

// A user-supplied endpoint vouches only for itself, so its annotations never drive auto-approval.
// The tier says nothing about sharing; a Gadget bound to either tier is owner-only.
const TRUST: ServerTrust = "byo";

const logger = createLogger<McpLogFields>({ component: "gatekeeper.mcp", vendorId: VENDOR_ID });

const MCP_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(MCP_LOGO_SVG)}`;
const MCP_AVATAR: AvatarImage = { url: MCP_LOGO_URL };

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp");
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the connect form and the OAuth callback.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce, path) => {
        if (request.method !== "GET" && request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        // A reconnect already knows its endpoint. Ignore a stale or malicious replacement URL.
        if (await account.hasEndpoint()) {
          return continueConnect(account, initiationNonce, null, env, path);
        }
        if (request.method === "GET") {
          if (!(await account.isAwaitingSelection(initiationNonce))) {
            return htmlResponse(INVALID_LINK_HTML, 400);
          }
          return htmlResponse(connectFormHtml(path, undefined, suggestedEndpoint(env)));
        }
        const form = await request.formData();
        return continueConnect(
          account, initiationNonce, String(form.get("url") ?? ""), env, path);
      },
    });
  },
};

// Validates the endpoint the user typed, then hands off to the account DO, which owns every
// credential. `endpointUrl` is null on a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  endpointUrl: string | null,
  env: Env,
  formPath: string,
): Promise<Response> {
  let target: ConnectedServer | null = null;

  if (endpointUrl !== null) {
    const validated = validateCustomEndpoint(env, endpointUrl);
    if (!validated.ok) {
      return htmlResponse(
        connectFormHtml(formPath, validated.reason, suggestedEndpoint(env)), 400);
    }
    // `serverName` is a placeholder until the handshake reports the server's own name, and `auth` is
    // a guess that `beginConnect` corrects to `"none"` if the endpoint turns out to be public.
    target = {
      endpoint: validated.url,
      serverId: serverIdFromEndpoint(validated.url),
      serverName: hostOf(validated.url),
      provenance: "user",
      auth: "oauth",
    };
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, target);
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(connectFormHtml(
      formPath, err instanceof Error ? err.message : String(err), suggestedEndpoint(env)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    // Green Hat fork: a deployment may present this vendor under its own name (GreenGateway).
    return {
      displayName: this.env.MCP_DISPLAY_NAME?.trim() || "MCP Server",
      url: "https://modelcontextprotocol.io",
      logo: MCP_AVATAR,
      color: "#1a1d21",
      tagline: this.env.MCP_TAGLINE?.trim() || "Connect any Model Context Protocol server",
      description: this.env.MCP_DESCRIPTION?.trim() ||
        "Connect a Model Context Protocol server and use its tools from a Gadget. Reads happen " +
        "straight away. Anything that writes waits for your approval.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.McpAccount.get(accountId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return mcpResources(fetchOptions(this.env).allowInsecure === true);
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only; the per-tool `callTool` overloads are
    // generated per resource in `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account DO — owns the endpoint choice and every credential for it.

/**
 * One connected MCP server, for one user: `McpAccountBase` plus where this Worker lives and how it
 * mints an account. Nothing outside this object ever sees a credential.
 */
export class McpAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  /**
   * The connect handler needs both over RPC: one to decide whether to show the endpoint form, the
   * other to reject a stale link before doing any work.
   */
  async hasEndpoint(): Promise<boolean> {
    return this.hasConnectedServer();
  }

  async isAwaitingSelection(initiationNonce: string): Promise<boolean> {
    return this.awaitingSelection(initiationNonce);
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env>
  implements GatekeeperUser {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: MCP_AVATAR, baseUrl: getBaseUrl(this.env) };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return mcpResources(fetchOptions(this.env).allowInsecure === true);
  }

  /**
   * Adds the agent-singleton declaration when this account's endpoint is one the deployment lists
   * in `MCP_AMBIENT_ENDPOINTS` (see `ambient.ts`): the Workshop then installs the whole-server grant
   * into every workspace the owner opens, as an always-available capsule. It reads the declaration
   * from the description it stored at connect or reconnect time, so an account connected before the
   * endpoint was listed gains the capsule on its next reconnect.
   */
  async describe(): Promise<AccountDescription> {
    const description = await super.describe();
    const server = await this.#account().getServer();
    if (!isAmbientEndpoint(this.env, server.endpoint)) return description;
    return {
      ...description,
      // Must equal the whole-server facet's `ResourceDescription.tsType`: that facet is what
      // getSingletonGatekeeperClass installs, and the Workshop names the capsule's session by it.
      singleton: { tsType: sessionTypeName(server.serverId, server.endpoint) },
    };
  }

  /** The whole-server grant, for the Workshop to install as an always-available capsule. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    const server = await this.#account().getServer();
    if (!isAmbientEndpoint(this.env, server.endpoint)) {
      throw new Error(`${server.endpoint} is not an ambient endpoint of this deployment.`);
    }
    return (await this.getGatekeeperClassFor(server.endpoint)).class;
  }

  /**
   * Green Hat fork. What sits behind an ambient endpoint, for the Integrations page: one line per
   * enabled system that contributes tools, read live from the gateway's connections listing with
   * this account's own bearer. Best effort: null for non-ambient accounts and on any failure.
   */
  async getAccountDetails(): Promise<AccountDetails | null> {
    const server = await this.#account().getServer();
    if (!isAmbientEndpoint(this.env, server.endpoint)) return null;
    try {
      const lines = await this.#connectionsBehind(server.endpoint);
      return lines ? { lines } : null;
    } catch (err) {
      logger.warn("could not list the systems behind the gateway", {
        event: "account.details.failed", error: err,
      });
      return null;
    }
  }

  async #connectionsBehind(endpoint: string): Promise<string[] | null> {
    const { authorization } = await this.#account().getConnection(endpoint);
    if (!authorization) return null;
    const path = this.env.MCP_CONNECTIONS_PATH?.trim() || "/v1/admin/connections";
    const url = new URL(path, new URL(endpoint).origin);
    url.searchParams.set("limit", "100");
    const response = await sdkFetch(fetchOptions(this.env))(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${authorization}` },
    });
    if (!response.ok) return null;
    const page = await response.json() as {
      connections?: {
        display_name?: unknown; enabled?: unknown; capability_count?: unknown;
        status?: { state?: unknown };
      }[];
    };
    if (!Array.isArray(page.connections)) return null;
    const lines: string[] = [];
    for (const row of page.connections) {
      if (row.enabled === false) continue;
      const count = typeof row.capability_count === "number" ? row.capability_count : 0;
      // Connections that publish no tools (e.g. a model lane the gateway proxies) are not
      // something the agent can use, so they stay off the card.
      if (count === 0) continue;
      const name = typeof row.display_name === "string"
        ? row.display_name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      if (!name) continue;
      const state = typeof row.status?.state === "string" ? row.status.state : "unknown";
      lines.push(`${name} · ${count} tool${count === 1 ? "" : "s"} · ${state}`);
      if (lines.length >= 20) break;
    }
    return lines;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const server = await this.#account().getServer();

    // The account is bound to one endpoint, so a resource URL naming anything else is not this
    // account's to grant, and the protocol-specific resource pattern matches any URL so this is the whole
    // test. Compared in full rather than by origin: one host can front `/mcp` and `/mcp-v2` as
    // unrelated servers, and the facet calls the endpoint recorded on the account regardless.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), server.endpoint)) {
      throw new Error(
        `This connection is for ${server.endpoint}, not ${endpointOfResourceUrl(requested)}.`);
    }

    // The fragment records how much of the endpoint this binding may call; see `scope.ts`. A
    // per-upstream-server scope belongs to the MCP Server Portals connector, and this gatekeeper
    // treats an endpoint as a single server, so it is refused rather than silently ignored.
    const scope = parseToolScope(requested);
    if (scope.serverId !== undefined) {
      throw new Error(
        `"${url}" scopes the grant to one server behind a gateway, which this connector does not ` +
        `do. Connect this endpoint through the MCP Server Portals connector instead.`);
    }
    if (scope.tools !== undefined) {
      const selected = new Set(scope.tools);
      validateToolScopeAgainstCatalog(
        scope,
        selected.size === 0
          ? { tools: [], truncated: false }
          : await withClient(
            this.env,
            this.#account(),
            server.endpoint,
            client => client.listMatchingToolIndex(
              selected.size,
              tool => selected.has(tool.name),
            ),
          ),
      );
    }

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: server.serverName,
      scope,
    };
    return {
      class: this.ctx.exports.McpGatekeeperImpl({ props }),
      resource: mcpResourceFor(server.endpoint),
    };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, this.#account())),
    };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier

// Required by the `GatekeeperUser` contract but never interrogated, since `addObserver` refuses
// everyone. Carries no props for the same reason.
@validateRpc()
export class McpVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #toolsPromise: Promise<ToolCatalog> | undefined;

  constructor(env: Env, account: DurableObjectStub<McpAccount>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async getEndpoint(): Promise<string> {
    return (await this.#account.getServer()).endpoint;
  }

  // One `tools/list` per configurator frame, shared by every question the form asks.
  #tools(): Promise<ToolCatalog> {
    this.#toolsPromise ??= (async () => {
      const server = await this.#account.getServer();
      return await fetchTools(this.#env, this.#account, server.endpoint);
    })();
    return this.#toolsPromise;
  }

  // Every tool the grant may cover, annotated with whether calls need approval.
  async listToolOptions(): Promise<ConfiguratorUIOption[]> {
    const { tools, truncated } = await this.#tools();
    requireCompleteCatalogForToolSelection(truncated);
    // `fetchTools` lists with the ordinary catalog cap, so that is the cap reaching it would be
    // evidence of. Unlike the portal connector, this form refuses a truncated catalog outright
    // rather than surveying past it, so `truncated` is already known to be false here.
    const isPortal = looksLikePortal(tools, { truncated, cap: MAX_TOOLS_PER_SERVER });

    return tools
      .filter(tool => scopeAllows({}, tool.name, isPortal))
      .map(tool => ({
        value: tool.name,
        title: tool.title ?? tool.name,
        subtitle: tool.description?.split(/\r?\n/)[0],
        // Surfaced here so the person granting can see, per tool, whether calls will interrupt them.
        meta: classifyTool(tool, TRUST).mode === "read" ? "read-only" : "needs approval",
      }));
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  // Display slug, for the binding name and session type; see `ConnectedServer.serverId`.
  serverId: string;
  serverName: string;
  // How much of the endpoint this binding may call. Empty means the whole endpoint, including tools
  // it publishes later.
  scope: ToolScope;
};


export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({ serverHost: hostOf(this.ctx.props.endpoint) });
  }

  /**
   * Namespaces this binding's action-kind tags, so a pre-approval for one server's `create_issue`
   * cannot apply to another's.
   *
   * The whole endpoint is the identity, matching `sameEndpoint` and every other place a grant is
   * compared. `serverId` is a display slug and collides across hosts, but the origin is not enough
   * either: one host can front `/mcp` and `/mcp-v2` as unrelated servers, and keying on the origin
   * let an always-approve decision for a tool on one of them silently auto-apply to the same tool
   * name on the other. `endpointTag` is that identity, shared with `sameEndpoint` so the two
   * cannot drift.
   */
  protected get actionScopeTag(): string {
    return `mcp:${endpointTag(this.ctx.props.endpoint)}`;
  }

  protected account(): ConnectionAccount {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected get trust(): ServerTrust {
    return TRUST;
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return `the MCP server ${hostOf(this.ctx.props.endpoint)}`;
  }

  get serverName(): string {
    return this.ctx.props.serverName;
  }

  /**
   * Discovery index for the always-available capsule (see `ambient.ts`): one entry per tool this
   * grant may call, so the agent sees what the server offers from its system prompt instead of
   * paging the session's generated types. Listing definitions is an observation of the server, so
   * it is authorized like any read. Null when the grant currently reaches no tools.
   */
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    const tools = await this.tools();
    if (tools.length === 0) return null;
    await authorizer.authorizeObservation({
      title: `${this.serverName} tool catalog`,
      description: `Listed the ${tools.length} tool definition(s) this connection may call on ` +
        `${hostOf(this.ctx.props.endpoint)}.`,
    });
    return boundAgentCatalog(tools.map(({ tool, mode }) => ({
      id: tool.name,
      title: tool.title ?? tool.name,
      description: `${mode === "read" ? "Read-only" : "Needs approval"}. ` +
        (tool.description?.split(/\r?\n/)[0] ?? ""),
    })));
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope, serverName } = this.ctx.props;

    const counts = `${reads} read-only, ${tools.length - reads} requiring approval`;
    const plural = tools.length === 1 ? "" : "s";
    const snippet = scope.tools
      ? `${scope.tools.length} named MCP tool${scope.tools.length === 1 ? "" : "s"} on ` +
        `${serverName} \u2014 ${counts}. Other tools are refused.`
      : `All tools on ${serverName}; ${tools.length} tool definition${plural} shown here ` +
        `(${counts}).`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${serverName}: ${scope.tools[0]}` : serverName,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.ctx.props.serverId)}`,
      tsType: sessionTypeName(this.ctx.props.serverId, this.resourceUrl),
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.ctx.props.serverId,
      serverName: this.ctx.props.serverName,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: TRUST,
      tools: await this.tools(),
    });
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
