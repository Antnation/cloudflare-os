// Which endpoints this deployment treats as "ambient".
//
// An ambient endpoint is one the organization wants every user to have on hand in every chat
// without picking it as a resource: typically the organization's own tool gateway. An account
// connected to such an endpoint declares an agent singleton (AccountDescription.singleton), and the
// Workshop then installs the whole-server grant into each of the owner's workspaces as an
// always-available capsule -- the same mechanism the Context Library uses -- while the OAuth grant
// stays the user's own, so the server still sees each person as themselves.
//
// Only listed endpoints qualify. A user-pasted server never becomes ambient by itself: that would
// hand every workspace of that user a capability they chose for one chat.
import { sameEndpoint } from "@gadgets/mcp-shared/scope";

export type AmbientEnv = { MCP_AMBIENT_ENDPOINTS?: string };

/** The configured ambient endpoints in order, with empty, unparseable, or scoped entries dropped. */
export function ambientEndpoints(env: AmbientEnv): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of (env.MCP_AMBIENT_ENDPOINTS ?? "").split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    // A fragment is a scope, i.e. a grant against an endpoint, not an endpoint.
    if (parsed.hash) continue;
    const canonical = parsed.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/** Whether `endpoint` is one of the deployment's ambient endpoints. */
export function isAmbientEndpoint(env: AmbientEnv, endpoint: string): boolean {
  return ambientEndpoints(env).some(candidate => sameEndpoint(candidate, endpoint));
}

/** The endpoint to prefill on the connect form: only when the deployment lists exactly one. */
export function suggestedEndpoint(env: AmbientEnv): string | undefined {
  const endpoints = ambientEndpoints(env);
  return endpoints.length === 1 ? endpoints[0] : undefined;
}
