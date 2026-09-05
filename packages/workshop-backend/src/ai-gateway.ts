import { AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

/**
 * A deployment-managed model that bypasses the gateway: the Workshop calls `baseUrl` itself,
 * speaking the named provider's native API, with the key held in the Worker secret `secret`.
 * Listed ahead of the gateway catalog, so the first one is what a new chat starts on. This is how
 * a deployment offers a model AI Gateway has no route for (a Z.AI coding plan, say) without any
 * user ever holding the key. Parsed from the DIRECT_MODELS JSON array.
 */
export type DirectModel = {
  /** Model id as the provider's API spells it; also the id the picker uses. */
  id: string;
  /** Display name. */
  name: string;
  /** Which native API `baseUrl` speaks. */
  provider: "anthropic" | "openai";
  /** API base URL, no trailing slash, e.g. https://api.z.ai/api/anthropic. */
  baseUrl: string;
  /** Name of the Worker secret holding the API key. */
  secret: string;
  contextWindow?: number;
  outputLimit?: number;
};

const DIRECT_MODEL_PROVIDERS = new Set(["anthropic", "openai"]);

/** Parse and validate DIRECT_MODELS. Throws on any malformed entry: a bad list must not deploy. */
export function parseDirectModels(raw: string | undefined): DirectModel[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("DIRECT_MODELS is not valid JSON.", { cause: err });
  }
  if (!Array.isArray(parsed)) throw new Error("DIRECT_MODELS must be a JSON array.");
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const where = `DIRECT_MODELS[${index}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${where} must be an object.`);
    const e = entry as Record<string, unknown>;
    for (const key of ["id", "name", "provider", "baseUrl", "secret"]) {
      if (typeof e[key] !== "string" || !(e[key] as string).trim()) {
        throw new Error(`${where}.${key} must be a non-empty string.`);
      }
    }
    if (!DIRECT_MODEL_PROVIDERS.has(e.provider as string)) {
      throw new Error(
          `${where}.provider must be one of: ${[...DIRECT_MODEL_PROVIDERS].join(", ")}.`);
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(e.baseUrl as string);
    } catch {
      throw new Error(`${where}.baseUrl is not a URL.`);
    }
    if (baseUrl.protocol !== "https:") throw new Error(`${where}.baseUrl must be HTTPS.`);
    for (const key of ["contextWindow", "outputLimit"]) {
      if (e[key] !== undefined && !(Number.isInteger(e[key]) && (e[key] as number) > 0)) {
        throw new Error(`${where}.${key} must be a positive integer when present.`);
      }
    }
    const id = (e.id as string).trim();
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is listed twice.`);
    seen.add(id);
    let normalizedBase = e.baseUrl as string;
    while (normalizedBase.endsWith("/")) normalizedBase = normalizedBase.slice(0, -1);
    return {
      id,
      name: (e.name as string).trim(),
      provider: e.provider as DirectModel["provider"],
      baseUrl: normalizedBase,
      secret: (e.secret as string).trim(),
      ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow as number } : {}),
      ...(e.outputLimit !== undefined ? { outputLimit: e.outputLimit as number } : {}),
    };
  });
}

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers whose pi API adapter refuses a custom fetch, so their inference cannot ride the
 * Workers AI binding and needs CF_AI_GATEWAY_API_TOKEN over HTTPS. pi's Google adapter throws
 * "Custom fetch is not supported by the Google Generative AI adapter" whenever the fetch it is
 * given is not globalThis.fetch, and the client it builds on offers no hook to route around that:
 * @google/genai's `GoogleGenAI` takes only `httpOptions`, whose knobs are
 * baseUrl/apiVersion/headers/timeout/extraBody/retryOptions.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-generative-ai.ts#L80
 *
 * pi's Vertex adapter throws the same way, so a google-vertex provider would belong here too; it
 * is absent only because this deployment has no such provider.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-vertex.ts#L98
 */
const HTTPS_ONLY_PROVIDERS = new Set(["google"]);

export class AiGatewayConfig {
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  readonly providers: Set<string>;
  /** Deployment-managed models the Workshop calls directly; see {@link DirectModel}. */
  readonly directModels: DirectModel[];
  readonly #env: Cloudflare.Env;

  constructor(env: Cloudflare.Env) {
    this.#env = env;
    this.directModels = parseDirectModels(env.DIRECT_MODELS);
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever one of them is an enabled provider).
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
  }

  /**
   * Get the list of models available through AI Gateway, as AiChatAuthorInfo entries.
   */
  getModelList(): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];
    // Direct models lead: the first entry is the model a new chat starts on.
    for (let model of this.directModels) {
      result.push({ type: "agent", id: model.id, name: model.name });
    }
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name });
        }
      }
    }
    return result;
  }

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the model is a
   * SUGGESTED_MODEL for an enabled gateway provider, or undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    let direct = this.directModels.find(model => model.id === modelId);
    if (direct) {
      let apiToken = (this.#env as unknown as Record<string, unknown>)[direct.secret];
      if (typeof apiToken !== "string" || !apiToken) {
        throw new Error(
            `Direct model "${direct.id}" needs the Worker secret ${direct.secret}, which is unset.`);
      }
      return {
        profile: { type: "agent", id: direct.id, name: direct.name },
        // `apiUrl` is what routes this past the gateway; see getModel() in ai-models.ts.
        config: {
          provider: direct.provider,
          model: direct.id,
          apiToken,
          apiUrl: direct.baseUrl,
          ...(direct.contextWindow !== undefined ? { contextWindow: direct.contextWindow } : {}),
          ...(direct.outputLimit !== undefined ? { outputLimit: direct.outputLimit } : {}),
        },
      };
    }
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
