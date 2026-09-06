import { describe, expect, it } from "vitest";
import { AiGatewayConfig, getAiGatewayConfig, parseDirectModels } from "../src/ai-gateway.js";

const ZAI = {
  id: "glm-5.3",
  name: "GLM 5.3 (Z.AI)",
  provider: "anthropic",
  baseUrl: "https://api.z.ai/api/anthropic/",
  secret: "ZAI_API_KEY",
  contextWindow: 200000,
  outputLimit: 128000,
};

// A minimal gateway environment: the binding transport satisfies the constructor's transport check
// without any token, and the Workers AI provider keeps the suggested catalog non-empty.
function gatewayEnv(extra: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "default",
    CF_AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    WORKERS_AI: {} as unknown as Ai,
    ...extra,
  } as unknown as Cloudflare.Env;
}

describe("parseDirectModels", () => {
  it("is empty when unset or blank", () => {
    expect(parseDirectModels(undefined)).toEqual([]);
    expect(parseDirectModels("  ")).toEqual([]);
  });

  it("normalizes a valid entry", () => {
    expect(parseDirectModels(JSON.stringify([ZAI]))).toEqual([{
      id: "glm-5.3",
      name: "GLM 5.3 (Z.AI)",
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      secret: "ZAI_API_KEY",
      contextWindow: 200000,
      outputLimit: 128000,
    }]);
  });

  it("rejects malformed lists so a bad deployment fails at startup, not at first use", () => {
    expect(() => parseDirectModels("{")).toThrow(/valid JSON/);
    expect(() => parseDirectModels("{}")).toThrow(/array/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, id: "" }]))).toThrow(/\.id/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, provider: "google" }])))
      .toThrow(/provider/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, baseUrl: "http://x.example" }])))
      .toThrow(/HTTPS/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, baseUrl: "nope" }])))
      .toThrow(/not a URL/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, outputLimit: -1 }])))
      .toThrow(/outputLimit/);
    expect(() => parseDirectModels(JSON.stringify([{ ...ZAI, auth: "basic" }]))).toThrow(/auth/);
    expect(() => parseDirectModels(JSON.stringify([ZAI, ZAI]))).toThrow(/twice/);
  });
});

describe("AiGatewayConfig direct models", () => {
  it("lists direct models first and resolves them to a direct config carrying the secret", () => {
    const config = new AiGatewayConfig(gatewayEnv({
      DIRECT_MODELS: JSON.stringify([ZAI]),
      ZAI_API_KEY: "zai-secret",
    }));
    const list = config.getModelList();
    expect(list[0]).toEqual({ type: "agent", id: "glm-5.3", name: "GLM 5.3 (Z.AI)" });
    expect(list.length).toBeGreaterThan(1);

    const resolved = config.resolveModel("glm-5.3");
    expect(resolved).toEqual({
      profile: { type: "agent", id: "glm-5.3", name: "GLM 5.3 (Z.AI)" },
      config: {
        provider: "anthropic",
        model: "glm-5.3",
        apiToken: "zai-secret",
        apiUrl: "https://api.z.ai/api/anthropic",
        contextWindow: 200000,
        outputLimit: 128000,
      },
    });
    // Gateway models still resolve as before, with no apiUrl.
    expect(config.resolveModel("@cf/moonshotai/kimi-k2.7-code")?.config.apiUrl).toBeUndefined();
    expect(config.resolveModel("does-not-exist")).toBeUndefined();
  });

  it("carries the bearer auth scheme through to the resolved config", () => {
    const config = new AiGatewayConfig(gatewayEnv({
      DIRECT_MODELS: JSON.stringify([{ ...ZAI, auth: "bearer", secret: "GATEWAY_LLM_TOKEN" }]),
      GATEWAY_LLM_TOKEN: "ggw_token",
    }));
    const resolved = config.resolveModel("glm-5.3");
    expect(resolved?.config.authScheme).toBe("bearer");
    expect(resolved?.config.apiToken).toBe("ggw_token");
    // The default scheme is the provider's own and is left implicit.
    const plain = new AiGatewayConfig(gatewayEnv({
      DIRECT_MODELS: JSON.stringify([ZAI]), ZAI_API_KEY: "k",
    }));
    expect(plain.resolveModel("glm-5.3")?.config.authScheme).toBeUndefined();
  });

  it("refuses to resolve a direct model whose secret is missing", () => {
    const config = new AiGatewayConfig(gatewayEnv({ DIRECT_MODELS: JSON.stringify([ZAI]) }));
    expect(() => config.resolveModel("glm-5.3")).toThrow(/ZAI_API_KEY/);
  });
});

describe("AiGatewayConfig catalog", () => {
  it("offers only the direct models when CF_AI_GATEWAY_CATALOG=none", () => {
    const config = new AiGatewayConfig(gatewayEnv({
      DIRECT_MODELS: JSON.stringify([ZAI]), ZAI_API_KEY: "k", CF_AI_GATEWAY_CATALOG: "none",
    }));
    expect(config.getModelList())
      .toEqual([{ type: "agent", id: "glm-5.3", name: "GLM 5.3 (Z.AI)" }]);
    // Hidden, not removed: a chat pinned to a catalog model before the switch keeps resolving.
    expect(config.resolveModel("@cf/moonshotai/kimi-k2.7-code")?.config.provider)
      .toBe("cloudflare");
    // The quick model never came from the catalog, so it is untouched.
    expect(config.getQuickModelConfig()?.provider).toBe("cloudflare");
  });

  it("defaults to the whole catalog, normalizes the value, and rejects anything else", () => {
    expect(new AiGatewayConfig(gatewayEnv()).catalog).toBe("all");
    expect(new AiGatewayConfig(gatewayEnv()).getModelList().length).toBeGreaterThan(0);
    expect(new AiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CATALOG: " None " })).getModelList())
      .toEqual([]);
    expect(() => new AiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CATALOG: "some" })))
      .toThrow(/CF_AI_GATEWAY_CATALOG/);
  });
});

describe("AiGatewayConfig direct-only mode (DIRECT_MODELS without CF_AI_GATEWAY)", () => {
  const bearer = { ...ZAI, auth: "bearer", secret: "GATEWAY_LLM_TOKEN" };
  function directOnlyEnv(extra: Record<string, unknown> = {}): Cloudflare.Env {
    return {
      DIRECT_MODELS: JSON.stringify([bearer]),
      GATEWAY_LLM_TOKEN: "ggw_token",
      ...extra,
    } as unknown as Cloudflare.Env;
  }

  it("is a deployment-managed configuration with no gateway behind it", () => {
    const config = getAiGatewayConfig(directOnlyEnv());
    expect(config).not.toBeNull();
    expect(config!.gateway).toBeUndefined();
    expect(config!.accountId).toBeUndefined();
    expect(config!.sameAccountGateway).toBeUndefined();
    expect(config!.binding).toBeUndefined();
    // No provider is enabled, so nothing but the direct models is offered and addModel() refuses
    // every provider, the same as a gateway deployment with an empty provider list would.
    expect(config!.providers.size).toBe(0);
    expect(config!.getModelList())
      .toEqual([{ type: "agent", id: "glm-5.3", name: "GLM 5.3 (Z.AI)" }]);
    expect(config!.resolveModel("@cf/moonshotai/kimi-k2.7-code")).toBeUndefined();
  });

  it("uses the first direct model as the quick model, credentials included", () => {
    const config = new AiGatewayConfig(directOnlyEnv());
    expect(config.getQuickModelConfig()).toEqual({
      provider: "anthropic",
      model: "glm-5.3",
      apiToken: "ggw_token",
      apiUrl: "https://api.z.ai/api/anthropic",
      authScheme: "bearer",
      contextWindow: 200000,
      outputLimit: 128000,
    });
    expect(() => new AiGatewayConfig(directOnlyEnv({ GATEWAY_LLM_TOKEN: undefined }))
      .getQuickModelConfig()).toThrow(/GATEWAY_LLM_TOKEN/);
  });

  it("is absent when the deployment manages no models, and refuses an empty list", () => {
    expect(getAiGatewayConfig({} as Cloudflare.Env)).toBeNull();
    expect(getAiGatewayConfig({ DIRECT_MODELS: "  " } as Cloudflare.Env)).toBeNull();
    expect(() => new AiGatewayConfig({ DIRECT_MODELS: "[]" } as Cloudflare.Env))
      .toThrow(/DIRECT_MODELS/);
  });

  it("keeps the Workers AI quick model whenever a gateway is configured", () => {
    const config = new AiGatewayConfig(gatewayEnv({
      DIRECT_MODELS: JSON.stringify([bearer]), GATEWAY_LLM_TOKEN: "ggw_token",
    }));
    expect(config.gateway).toBe("default");
    expect(config.getQuickModelConfig()?.provider).toBe("cloudflare");
  });
});
