// Deployment-wide admin configuration: a single object owned by the AdminSettings durable object and
// mirrored to one reserved BLUEPRINTS KV key, so the per-(re)connect getServerConfig() path and the
// agent can resolve it with a single cheap KV get.
//
// This covers mutable deployment customizations only (branding, agent instructions, and which
// gatekeeper connectors/resources are available). Resource switches are re-checked at the runtime
// authority boundaries, but do not revoke an upstream provider's OAuth grant. Authentication config
// (sign-in providers, password login) is deliberately NOT here — it stays env-var driven so it can't
// be changed by a compromised admin session. Everything here is enabled by default; the admin UI
// opts things *out*.

import { AmbientGatekeeperMode, BannerConfig, BlueprintBinding, BlueprintMetadata, BlueprintOutput, DEFAULT_BANNER_COLOR, GatekeeperCreationSpec, OutputFormatOffer, isAmbientGatekeeperMode, isBannerColor, isOutputIcon } from "@gadgets/workshop-shared/api";
import { SupportedResource, matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_CONFIG_KEY, BlueprintKvEnv, readBlueprintKvRecord, sanitizeBlueprintOutput } from "./blueprint-archive.js";

export type AdminConfig = {
  /**
   * Whether new account signups are allowed (default true). Note: this is an access toggle, not
   * authentication config — which auth providers exist and whether password login is on stay
   * env-driven (see auth/config.ts).
   */
  signupsEnabled: boolean;
  /**
   * Site name shown next to the top-bar logo, or "" to use DEFAULT_SITE_NAME. Resolve it for
   * display with `resolveSiteName()`.
   */
  siteName: string;
  /** Whether this deployment has a custom site logo. Image bytes are stored separately. */
  siteLogoConfigured: boolean;
  /** Extra instructions appended to the agent system prompt. */
  instanceInstructions: string;
  /** Centered top-bar notice. Markdown. */
  announcement: string;
  /** Full-width banner (text + accent color). */
  banner: BannerConfig;
  /** Accent (brand) color hex, or "" for the default theme. */
  accentColor: string;
  /** Disabled gatekeeper resources: vendorId -> disabled resource urlPatterns. */
  disabledResources: Record<string, string[]>;
  /** Fully-disabled gatekeeper vendor ids. */
  disabledGatekeepers: string[];
  /**
   * Per-vendor provisioning mode for auto-provisioning ("ambient") gatekeepers (e.g. the Context
   * Library). Absent ⇒ the default ("optional", see provisioning-policy.ts). Only meaningful for
   * vendors that declare autoProvisionsAccount.
   */
  ambientGatekeeperModes: Record<string, AmbientGatekeeperMode>;

  /**
   * The blueprints offered as this deployment's standard output formats. What a user gets from
   * "New Slides", and what the agent is told to prefer. Order is menu order.
   *
   * Separate from the blueprint's own declaration of what it produces (BlueprintMetadata.output):
   * any user can publish a blueprint calling itself a Document, but only this list decides what
   * the deployment offers.
   */
  formats: FormatCuration[];
};

/**
 * One promoted blueprint. The blueprint itself supplies the noun, plural and icon, so improving
 * the blueprint improves every deployment that hasn't overridden it.
 */
export type FormatCuration = {
  blueprintId: string;

  /**
   * Offered to users and the agent. Disabling keeps the entry (and its overrides) around, so
   * re-enabling doesn't lose the admin's edits.
   */
  enabled: boolean;

  /** One line telling the agent when to choose this format, e.g. "prefer for contracts and memos". */
  agentHint?: string;

  /**
   * Presentation the deployment substitutes for the blueprint's own, e.g. an org that calls its
   * decks "Briefings". Absent fields fall back to the blueprint's declaration.
   */
  overrides?: Partial<BlueprintOutput>;
};

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  signupsEnabled: true,
  siteName: "",
  siteLogoConfigured: false,
  instanceInstructions: "",
  announcement: "",
  banner: { text: "", color: DEFAULT_BANNER_COLOR },
  accentColor: "",
  disabledResources: {},
  disabledGatekeepers: [],
  ambientGatekeeperModes: {},
  formats: [],
};

/**
 * Longest `agentHint` a promoted format may carry. Every enabled format's hint goes into the
 * system prompt on every turn, so this is a budget rather than a validation limit; a sentence or
 * two is what the panel asks for.
 */
export const MAX_AGENT_HINT = 400;

// Accept a stored format entry only if it is well-formed.
function parseFormats(value: unknown): FormatCuration[] {
  if (!Array.isArray(value)) return [];
  let formats: FormatCuration[] = [];
  let seen = new Set<string>();
  for (let raw of value) {
    if (!raw || typeof raw !== "object") continue;
    let {blueprintId, enabled, agentHint, overrides} = raw as Partial<FormatCuration>;
    if (typeof blueprintId !== "string" || !blueprintId) continue;
    if (seen.has(blueprintId)) continue;
    seen.add(blueprintId);
    let entry: FormatCuration = {blueprintId, enabled: enabled !== false};
    if (typeof agentHint === "string" && agentHint.trim()) {
      entry.agentHint = agentHint.trim().slice(0, MAX_AGENT_HINT);
    }
    let clean = sanitizeOutputOverrides(overrides);
    if (clean) entry.overrides = clean;
    formats.push(entry);
  }
  return formats;
}

/**
 * `formats` rearranged into the order `blueprintIds` gives. Throws unless that is a permutation of
 * what is promoted, so a stale client can't silently drop a format.
 *
 * Uniqueness is checked separately from length because the lookup Map dedupes: [A, A] against
 * promoted [A, B] passes both a length and a membership test, drops B, and leaves a duplicate that
 * makes every later reorder throw.
 */
export function reorderFormats(formats: FormatCuration[], blueprintIds: string[])
    : FormatCuration[] {
  let byId = new Map(formats.map(f => [f.blueprintId, f]));
  if (blueprintIds.length !== byId.size || new Set(blueprintIds).size !== blueprintIds.length
      || blueprintIds.some(id => !byId.has(id))) {
    throw new Error("Format order must list each promoted format exactly once.");
  }
  return blueprintIds.map(id => byId.get(id)!);
}

/**
 * FNV-1a, as eight hex characters. Short because callers concatenate it into a length-budgeted
 * string, and synchronous because they are -- `crypto.subtle.digest()` would make them async.
 * Compared only for equality, so nothing depends on collision resistance.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable grouping id for a promoted blueprint that doesn't declare what it produces. An
 * implementation detail of the Outputs filter. Keeps short blueprint ids readable and preserves
 * uniqueness.
 */
export function defaultOutputFormatId(blueprintId: string): string {
  if (blueprintId.length <= 40) return blueprintId;
  return `${blueprintId.slice(0, 31)}-${fingerprint(blueprintId)}`;
}

/**
 * Keep only the well-formed fields of an admin's presentation override, or undefined if none
 * survive.
 */
export function sanitizeOutputOverrides(overrides: unknown): Partial<BlueprintOutput> | undefined {
  if (!overrides || typeof overrides !== "object") return undefined;
  let {id, noun, plural, icon} = overrides as Partial<BlueprintOutput>;
  let clean: Partial<BlueprintOutput> = {};
  for (let [key, value] of Object.entries({id, noun, plural})) {
    if (typeof value === "string" && value.trim() && value.trim().length <= 40) {
      clean[key as "id" | "noun" | "plural"] = value.trim();
    }
  }
  if (isOutputIcon(icon)) clean.icon = icon;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * The presentation a gadget instantiated from `blueprintId` should inherit: the blueprint's own
 * declaration with this deployment's override applied. Called on every instantiation path, so an
 * admin who renames "Slides" to "Briefing" gets Briefings from then on.
 *
 * Overrides apply even when the format is disabled: disabling stops it being *offered*, but a
 * gadget built from that blueprint still carries the deployment's naming.
 */
export function deploymentOutputForBlueprint(
    config: AdminConfig, blueprintId: string, declared: BlueprintOutput | undefined)
    : BlueprintOutput | undefined {
  return resolveFormatOutput(declared, config.formats.find(f => f.blueprintId === blueprintId)?.overrides);
}

/**
 * Resolve what a promoted blueprint should be shown as: the blueprint's own declaration with the
 * deployment's overrides applied. Returns undefined when the blueprint declares nothing and the
 * admin overrode nothing meaningful.
 */
export function resolveFormatOutput(
    declared: BlueprintOutput | undefined, overrides?: Partial<BlueprintOutput>)
    : BlueprintOutput | undefined {
  let merged = {...declared, ...overrides};
  if (!merged.id || !merged.noun || !merged.plural || !merged.icon) return undefined;
  return merged as BlueprintOutput;
}

// --- Reading the promoted set ---
//
// Three surfaces offer the deployment's formats -- the user's New menu, the agent's catalog, and
// the admin panel that curates them.

/** One promoted blueprint joined with the blueprint it points at. */
export type PromotedFormat = {
  entry: FormatCuration;

  /**
   * The blueprint's own metadata. Absent when it has been deleted since being promoted; such an
   * entry is skipped everywhere except the admin panel, which offers to remove it.
   */
  metadata?: BlueprintMetadata;

  /** What the blueprint declares it produces, after validation. Absent if it declares nothing usable. */
  declared?: BlueprintOutput;

  /** `declared` with the deployment's overrides applied. */
  output?: BlueprintOutput;
};

/** Join promoted entries with the blueprints they point at, preserving order. */
export async function listPromotedFormats(env: BlueprintKvEnv, formats: FormatCuration[])
    : Promise<PromotedFormat[]> {
  let records = await Promise.all(
      formats.map(entry => readBlueprintKvRecord(env, entry.blueprintId)));

  return formats.map((entry, i) => {
    let metadata = records[i]?.metadata;
    let declared = sanitizeBlueprintOutput(metadata?.output);
    return {entry, metadata, declared, output: resolveFormatOutput(declared, entry.overrides)};
  });
}

/**
 * A format the deployment is offering, plus the two things only the agent's catalog wants: the
 * admin's note about when to prefer it, and the bindings its blueprint expects to be wired up.
 * listOutputFormats() drops both.
 */
export type FormatOffer = OutputFormatOffer & {
  agentHint?: string;
  bindings: Record<string, BlueprintBinding>;
};

/**
 * The formats this deployment offers, in menu order: promoted, enabled, and resolvable to a
 * complete presentation. A promoted blueprint that has since been deleted, or that names nothing
 * to call itself, is silently skipped.
 */
export async function listFormatOffers(env: BlueprintKvEnv, config: AdminConfig)
    : Promise<FormatOffer[]> {
  let enabled = config.formats.filter(entry => entry.enabled);
  if (enabled.length === 0) return [];

  let offers: FormatOffer[] = [];
  for (let {entry, metadata, output} of await listPromotedFormats(env, enabled)) {
    if (!metadata || !output) continue;
    offers.push({
      blueprintId: entry.blueprintId,
      output,
      description: metadata.description,
      requiresSetup: Object.keys(metadata.bindings).length > 0,
      bindings: metadata.bindings,
      ...(entry.agentHint ? {agentHint: entry.agentHint} : {}),
    });
  }
  return offers;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function normalizeAdminConfig(p: Partial<AdminConfig>): AdminConfig {
    let disabledResources: Record<string, string[]> = {};
    if (p.disabledResources && typeof p.disabledResources === "object") {
      for (let [vendorId, patterns] of Object.entries(p.disabledResources)) {
        let key = vendorId.toLowerCase();
        let list = [...new Set([
          ...(disabledResources[key] ?? []),
          ...strings(patterns),
        ])];
        if (list.length > 0) disabledResources[key] = list;
      }
    }
    let ambientGatekeeperModes: Record<string, AmbientGatekeeperMode> = {};
    if (p.ambientGatekeeperModes && typeof p.ambientGatekeeperModes === "object") {
      for (let [vendorId, mode] of Object.entries(p.ambientGatekeeperModes)) {
        if (isAmbientGatekeeperMode(mode)) ambientGatekeeperModes[vendorId.toLowerCase()] = mode;
      }
    }
  return {
    signupsEnabled: typeof p.signupsEnabled === "boolean" ? p.signupsEnabled : true,
    siteName: typeof p.siteName === "string" ? p.siteName : "",
    siteLogoConfigured: typeof p.siteLogoConfigured === "boolean" ? p.siteLogoConfigured : false,
    instanceInstructions: typeof p.instanceInstructions === "string" ? p.instanceInstructions : "",
    announcement: typeof p.announcement === "string" ? p.announcement : "",
    banner: {
      text: typeof p.banner?.text === "string" ? p.banner.text : "",
      color: isBannerColor(p.banner?.color) ? p.banner!.color : DEFAULT_BANNER_COLOR,
    },
    accentColor: typeof p.accentColor === "string" ? p.accentColor : "",
    disabledResources,
    disabledGatekeepers: [...new Set(strings(p.disabledGatekeepers).map(v => v.toLowerCase()))],
    ambientGatekeeperModes,
    formats: parseFormats(p.formats),
  };
}

export function parseAdminConfig(raw: string | null): AdminConfig {
  if (!raw) return { ...DEFAULT_ADMIN_CONFIG };
  try {
    return normalizeAdminConfig(JSON.parse(raw) as Partial<AdminConfig>);
  } catch {
    return { ...DEFAULT_ADMIN_CONFIG };
  }
}

/**
 * Parse the KV copy used at authority-bearing call sites. Missing KV is the valid first-deploy
 * default, but a present malformed policy must not silently turn every disabled integration back
 * on. The admin UI reads the authoritative typed Durable Object record, so throwing here does not
 * remove the recovery path: a subsequent admin write repairs the mirror.
 */
export function parseAdminConfigForAuthority(raw: string | null): AdminConfig {
  if (raw === null) return { ...DEFAULT_ADMIN_CONFIG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("The deployment admin policy is malformed.", {cause: error});
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The deployment admin policy is malformed.");
  }

  let policy = parsed as Record<string, unknown>;
  if ("signupsEnabled" in policy && typeof policy.signupsEnabled !== "boolean") {
    throw new Error("The deployment signup policy is malformed.");
  }
  if ("disabledGatekeepers" in policy &&
      (!Array.isArray(policy.disabledGatekeepers) ||
       policy.disabledGatekeepers.some(value => typeof value !== "string"))) {
    throw new Error("The deployment gatekeeper policy is malformed.");
  }
  if ("disabledResources" in policy) {
    let resources = policy.disabledResources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
        Object.values(resources).some(patterns =>
          !Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== "string"))) {
      throw new Error("The deployment resource policy is malformed.");
    }
  }
  if ("ambientGatekeeperModes" in policy) {
    let modes = policy.ambientGatekeeperModes;
    if (!modes || typeof modes !== "object" || Array.isArray(modes) ||
        Object.values(modes).some(mode => !isAmbientGatekeeperMode(mode))) {
      throw new Error("The deployment ambient gatekeeper policy is malformed.");
    }
  }

  return normalizeAdminConfig(parsed as Partial<AdminConfig>);
}

export function serializeAdminConfig(config: AdminConfig): string {
  return JSON.stringify(config);
}

/** Read presentation/discovery config from the KV mirror, tolerating a corrupt copy for recovery. */
export async function readAdminConfig(env: Cloudflare.Env): Promise<AdminConfig> {
  return parseAdminConfig(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY));
}

/**
 * Read the same mirror for an authority-bearing operation. Unlike presentation reads, a present
 * malformed record fails closed so corruption cannot silently re-enable every integration.
 */
export async function readAdminConfigForAuthority(env: Cloudflare.Env): Promise<AdminConfig> {
  return parseAdminConfigForAuthority(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY));
}

// --- Resource-disable helpers ---

/** Whether an ordinary gatekeeper vendor is disabled by deployment policy. */
export function isGatekeeperDisabled(config: AdminConfig, vendorId: string): boolean {
  return config.disabledGatekeepers.includes(vendorId.toLowerCase());
}

export function isResourceDisabled(
    config: AdminConfig, vendorId: string, urlPattern: string): boolean {
  return config.disabledResources[vendorId.toLowerCase()]?.includes(urlPattern) ?? false;
}

export function filterEnabledResources(
    config: AdminConfig, vendorId: string, resources: SupportedResource[]): SupportedResource[] {
  let disabled = config.disabledResources[vendorId.toLowerCase()];
  if (!disabled || disabled.length === 0) return resources;
  return resources.filter(r => !disabled.includes(r.urlPattern));
}

/** Why an already-minted gatekeeper capability is unavailable under the current admin policy. */
export type GatekeeperAvailabilityBlock = {
  kind: "gatekeeper";
  vendorId: string;
} | {
  kind: "resource";
  vendorId?: string;
  urlPattern: string;
};

/**
 * Resolve the current policy block for a persisted gatekeeper record. This is intentionally usable
 * after a capability has been minted: runtime call sites pass the stored creation spec before
 * opening a session, authorizing a read, applying a write, or delivering a hook.
 *
 * Very old records may predate creation specs. When their vendor is known, their concrete resource
 * URL is matched only against that vendor. Without provenance, a concrete URL is matched against
 * every resource rule. Ambiguous broad rules and whole-vendor disables deliberately quarantine
 * such a record: allowing it would let an unidentifiable legacy capability bypass admin policy.
 * Cleanup remains available, and all newly-created records carry provenance.
 */
export function gatekeeperAvailabilityBlock(
    config: AdminConfig,
    creationSpec: GatekeeperCreationSpec | undefined,
    resourceUrl?: string,
    legacyVendorId?: string): GatekeeperAvailabilityBlock | undefined {
  if (creationSpec && "vendorId" in creationSpec) {
    let vendorId = creationSpec.vendorId.toLowerCase();
    let disabledPatterns = config.disabledResources[vendorId] ?? [];
    if (isGatekeeperDisabled(config, vendorId) ||
        creationSpec.type === "ambient" &&
        config.ambientGatekeeperModes[vendorId] === "disabled") {
      return {kind: "gatekeeper", vendorId};
    }
    if (creationSpec.type === "gatekeeper") {
      if (creationSpec.typeUrlPattern &&
          isResourceDisabled(config, vendorId, creationSpec.typeUrlPattern)) {
        return {kind: "resource", vendorId, urlPattern: creationSpec.typeUrlPattern};
      }
      // Historical ordinary records may have a creationSpec from before typeUrlPattern was added.
      // Their vendor provenance is still trustworthy, so fall back to matching the concrete URL
      // against that vendor's policy. Do not do this for modern records: a broad sibling pattern
      // such as https://* must not shadow their explicit enabled type.
      if (!creationSpec.typeUrlPattern) {
        let concreteUrl = creationSpec.resourceUrl || resourceUrl;
        if (concreteUrl) {
          for (let urlPattern of disabledPatterns) {
            if (matchesResourceUrlPattern(urlPattern, concreteUrl)) {
              return {kind: "resource", vendorId, urlPattern};
            }
          }
        } else if (disabledPatterns.length > 0) {
          return {kind: "resource", vendorId, urlPattern: disabledPatterns[0]};
        }
      }
    }

    // Ambient records do not carry a typeUrlPattern. Match their concrete described URL against
    // this vendor's disabled patterns so the same policy still governs a retained singleton
    // capability. An ordinary record's stored typeUrlPattern is authoritative: matching its URL
    // against broader sibling types (especially `https://*`) would disable an enabled resource.
    if (creationSpec.type === "ambient" && resourceUrl) {
      for (let urlPattern of disabledPatterns) {
        if (matchesResourceUrlPattern(urlPattern, resourceUrl)) {
          return {kind: "resource", vendorId, urlPattern};
        }
      }
    } else if (creationSpec.type === "ambient" && disabledPatterns.length > 0) {
      return {kind: "resource", vendorId, urlPattern: disabledPatterns[0]};
    }
    return undefined;
  }

  if (legacyVendorId) {
    let vendorId = legacyVendorId.toLowerCase();
    if (isGatekeeperDisabled(config, vendorId) ||
        config.ambientGatekeeperModes[vendorId] === "disabled") {
      return {kind: "gatekeeper", vendorId};
    }
    let patterns = config.disabledResources[vendorId] ?? [];
    if (!resourceUrl && patterns.length > 0) {
      return {kind: "resource", vendorId, urlPattern: patterns[0]};
    }
  } else if (!creationSpec && config.disabledGatekeepers.length > 0) {
    // There is no sound way to prove that this historical record is unrelated to the disabled
    // vendor. Fail closed until it is removed/reconnected with a creation spec.
    return {kind: "gatekeeper", vendorId: config.disabledGatekeepers[0]};
  } else if (!creationSpec && !resourceUrl) {
    for (let [vendorId, patterns] of Object.entries(config.disabledResources)) {
      if (patterns.length > 0) {
        return {kind: "resource", vendorId, urlPattern: patterns[0]};
      }
    }
  }

  if (resourceUrl) {
    let resources: Array<[string, string[]]> = legacyVendorId
        ? [[legacyVendorId.toLowerCase(),
            config.disabledResources[legacyVendorId.toLowerCase()] ?? []]]
        : Object.entries(config.disabledResources);
    for (let [vendorId, patterns] of resources) {
      for (let urlPattern of patterns) {
        if (matchesResourceUrlPattern(urlPattern, resourceUrl)) {
          return {kind: "resource", vendorId, urlPattern};
        }
      }
    }
  }
  return undefined;
}

/**
 * Validate and narrow an OAuth/resource-grant selection to enabled, independently grantable
 * resource types. An omitted selection keeps its legacy "all" meaning only when this vendor has no
 * resource policy at all; otherwise it becomes the explicit enabled subset. This stays safe when a
 * user-specific or stale provider catalog omits the disabled type: forwarding `undefined` there
 * would turn the request back into "grant everything" at the provider.
 */
export function normalizeResourceGrantSelection(
    config: AdminConfig,
    vendorId: string,
    supportedResources: SupportedResource[],
    requested: string[] | undefined): string[] | undefined {
  let grantable = supportedResources.filter(resource => resource.grantable === true);
  let byPattern = new Map(grantable.map(resource => [resource.urlPattern, resource]));

  if (requested !== undefined) {
    let normalized = [...new Set(requested)];
    for (let urlPattern of normalized) {
      let resource = byPattern.get(urlPattern);
      if (!resource) {
        throw new Error(`Unknown or non-grantable resource type: ${urlPattern}`);
      }
      if (isResourceDisabled(config, vendorId, urlPattern)) {
        throw new Error(
            `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
      }
    }
    return normalized;
  }

  if ((config.disabledResources[vendorId.toLowerCase()]?.length ?? 0) === 0) {
    return undefined;
  }
  return grantable
      .filter(resource => !isResourceDisabled(config, vendorId, resource.urlPattern))
      .map(resource => resource.urlPattern);
}

/**
 * Whether a connected account's current grant may contain an administratively disabled resource.
 * Explicit grant metadata is compared directly with policy rather than intersected with today's
 * provider catalog: a disabled scope must not become allowed merely because it stopped being
 * advertised. Missing grant metadata means "all" for legacy accounts and therefore fails closed
 * whenever the vendor has any disabled resource policy.
 */
export function accountGrantIncludesDisabledResource(
    config: AdminConfig,
    vendorId: string,
    grantedResourceUrlPatterns: string[] | undefined): boolean {
  let disabled = config.disabledResources[vendorId.toLowerCase()] ?? [];
  if (disabled.length === 0) return false;
  if (grantedResourceUrlPatterns === undefined) return true;
  let granted = new Set(grantedResourceUrlPatterns);
  return disabled.some(urlPattern => granted.has(urlPattern));
}

// --- Agent system-prompt instructions ---

/**
 * Wrap the admin instructions in a clearly-delimited block for the system prompt, or "" when unset.
 * Callers are responsible for separating this from the preceding prompt with a blank line.
 */
export function formatInstanceInstructions(instructions: string): string {
  let trimmed = instructions.trim();
  if (!trimmed) return "";
  return `# Deployment-specific instructions\n\n` +
      `The administrator of this deployment has provided the following additional instructions. ` +
      `Follow them unless they conflict with the user's safety or the instructions above.\n\n` +
      `<deployment_instructions>\n${trimmed}\n</deployment_instructions>`;
}
