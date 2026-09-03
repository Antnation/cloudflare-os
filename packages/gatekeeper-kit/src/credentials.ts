/** Account-side credential storage and consumer-side RPC access. */

import { createLogger } from "@gadgets/backend-utils/logger";
import { ACCESS_TOKEN_SAFETY_MS, generateNonce } from "./connect-nonce";
import type { KvMutable } from "./kv";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.credentials" });

/**
 * Durable Object KV used for credentials. Pass the stable `ctx.storage.kv` object so refreshes
 * coalesce across coordinator instances.
 */
export type CredentialsKv = KvMutable;

/** Provider-confirmed grant expiry. Transport and service failures must use their original errors. */
export class CredentialsExpiredError extends Error {
  /**
   * Creates a confirmed-expiry error.
   * @param message Display-safe expiry message.
   * @param options Optional error cause.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialsExpiredError";
  }
}

/** Matches confirmed expiry by name, which survives the RPC boundary where the class does not. */
function isExpiredError(error: unknown): boolean {
  return error instanceof Error && error.name === "CredentialsExpiredError";
}

// Shared storage layout for kit-managed credentials.
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = `${CREDENTIALS_KEY}:identity`;
const MIGRATED_KEY = `${CREDENTIALS_KEY}:migrated`;
const CONNECTION_KEY = `${CREDENTIALS_KEY}:connection`;

const OWNED_KEYS: readonly string[] =
  [CREDENTIALS_KEY, IDENTITY_KEY, MIGRATED_KEY, CONNECTION_KEY];

// Coalesce refreshes across coordinators sharing the same storage object.
const refreshes = perStorage(() => new SingleFlight());

/** Provider-specific expiry and migration policy. */
export type CredentialCoordinatorOptions<Creds> = {
  /**
   * Reads a credential expiry.
   * @param credentials Provider credentials.
   * @returns The finite expiry epoch, or `undefined` when non-expiring.
   */
  expiresAt?(credentials: Creds): number | undefined;
  /** How far ahead of `expiresAt` to refresh. Non-negative and finite; 0 refreshes at expiry. */
  refreshSkewMs?: number;
  /** Keys owned by the pre-kit credential layout. */
  legacyKeys?: readonly string[];
  /**
   * Reads credentials from a legacy layout once. The callback must not delete legacy keys; the
   * coordinator removes them only after committing the canonical record.
   * @param kv Read-only access to credential storage.
   * @returns Legacy credentials, or `undefined` when absent.
   */
  upgrade?(kv: Pick<CredentialsKv, "get">): Creds | undefined;
};

/**
 * Owns credential storage, migration, and skew-aware refresh. Concurrent refreshes share one
 * provider request. A crash after provider-side token rotation may still require reconnection.
 */
export class CredentialCoordinator<Creds> {
  readonly #kv: CredentialsKv;
  readonly #options: CredentialCoordinatorOptions<Creds>;

  /**
   * Creates a credential coordinator.
   * @param kv Stable Durable Object credential storage.
   * @param options Provider expiry and migration policy.
   */
  constructor(kv: CredentialsKv, options: CredentialCoordinatorOptions<Creds> = {}) {
    this.#kv = kv;
    this.#options = options;
    for (const key of options.legacyKeys ?? []) {
      if (OWNED_KEYS.includes(key)) {
        throw new Error(`Legacy key "${key}" is one the coordinator owns.`);
      }
    }
    const { refreshSkewMs } = options;
    // A negative skew reads a dead token as live; a non-finite one disables the comparison. Both
    // fail open, so they are refused here rather than at the first expiry check.
    if (refreshSkewMs !== undefined && (!Number.isFinite(refreshSkewMs) || refreshSkewMs < 0)) {
      throw new Error(`refreshSkewMs must be a non-negative finite number, got ${refreshSkewMs}.`);
    }
  }

  /** @returns Stored credentials, migrating legacy storage on first read. */
  stored(): Creds | undefined {
    const current = this.#kv.get<Creds>(CREDENTIALS_KEY);
    if (current !== undefined) {
      this.#identify();
      return current;
    }

    const { upgrade } = this.#options;
    // The marker is durable, not per-instance: a `clear()` followed by a restart would otherwise
    // re-run the migration and resurrect a grant that has since been superseded.
    if (upgrade === undefined || this.#kv.get<boolean>(MIGRATED_KEY)) return undefined;

    const upgraded = upgrade(this.#kv);
    // Found nothing: mark it here, since there is no record to write and nothing found today will
    // not be found later either. A found grant is marked by the `clear()` that drops it again.
    if (upgraded === undefined) {
      this.#kv.put(MIGRATED_KEY, true);
      return undefined;
    }

    // Canonical record first, legacy keys second. Both land in one implicit transaction, so a
    // machine failure takes neither; the order is what makes a throw between them survivable, since
    // the grant is already readable under its new key before the old one goes away.
    this.#commit(upgraded);
    this.#reap();
    return upgraded;
  }

  /** @returns The opaque identity of the current credential value. */
  identity(): string {
    return this.#kv.get<string>(IDENTITY_KEY) ?? "";
  }

  /**
   * Installs credentials from a connect flow.
   * @param credentials New credentials.
   */
  connect(credentials: Creds): void {
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#commit(credentials);
  }

  /** @returns The stable identity of the current connection. */
  connectionGeneration(): string {
    const current = this.#kv.get<string>(CONNECTION_KEY);
    if (current !== undefined) return current;
    const minted = generateNonce();
    this.#kv.put(CONNECTION_KEY, minted);
    return minted;
  }

  /**
   * Publishes credentials behind a new identity fence.
   * @param credentials Credentials to store.
   */
  #commit(credentials: Creds): void {
    this.#supersede();
    this.#kv.put(CREDENTIALS_KEY, credentials);
  }

  /** Clears credentials and prevents legacy migration from restoring them. */
  clear(): void {
    this.#kv.put(MIGRATED_KEY, true);
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#supersede();
    // Before the record goes, so a failed reap leaves the canonical grant rather than only the
    // legacy one a rolled-back reader would still accept. Retries the migration's reap.
    this.#reap();
    this.#kv.delete(CREDENTIALS_KEY);
  }

  /** Removes all configured legacy credential keys. */
  #reap(): void {
    for (const key of this.#options.legacyKeys ?? []) this.#kv.delete(key);
  }

  /** Replaces the current credential identity fence. */
  #supersede(): void {
    this.#kv.put(IDENTITY_KEY, generateNonce());
  }

  /** Ensures stored credentials have a non-empty identity. */
  #identify(): void {
    if (this.#kv.get<string>(IDENTITY_KEY) === undefined) {
      this.#kv.put(IDENTITY_KEY, generateNonce());
    }
  }

  /**
   * Returns usable credentials, refreshing after the expiry boundary.
   * @param refresh Provider refresh operation.
   * @returns Current or refreshed credentials.
   */
  async fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    const current = this.#connected();
    const expiresAt = this.#options.expiresAt?.(current);
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
      throw new Error(`expiresAt must be finite or undefined, got ${expiresAt}.`);
    }
    const skew = this.#options.refreshSkewMs ?? ACCESS_TOKEN_SAFETY_MS;
    if (expiresAt === undefined || Date.now() < expiresAt - skew) return current;
    return this.#coalesced(current, refresh);
  }

  /**
   * Refreshes credentials immediately.
   * @param refresh Provider refresh operation.
   * @returns Current or refreshed credentials.
   */
  async rotate(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    return this.#coalesced(this.#connected(), refresh);
  }

  /** @returns Stored credentials, or throws when disconnected. */
  #connected(): Creds {
    const current = this.stored();
    if (current === undefined) throw new CredentialsExpiredError("This account is not connected.");
    return current;
  }

  /**
   * Coalesces refreshes behind the current identity fence.
   * @param current Credentials being refreshed.
   * @param refresh Provider refresh operation.
   * @returns Current, refreshed, or concurrently replaced credentials.
   */
  #coalesced(current: Creds, refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    // Keyed by the identity fence, so a caller arriving after a reconnect starts its own refresh
    // rather than riding one whose result is already fenced out.
    const fence = this.identity();
    return refreshes(this.#kv).run(fence, () => this.#refresh(current, fence, refresh));
  }

  /**
   * Runs one fenced provider refresh.
   * @param current Credentials being refreshed.
   * @param fence Identity captured before refresh.
   * @param refresh Provider refresh operation.
   * @returns Refreshed credentials unless a newer connection won.
   */
  async #refresh(
    current: Creds,
    fence: string,
    refresh: (current: Creds) => Promise<Creds>,
  ): Promise<Creds> {
    let refreshed: Creds;
    try {
      refreshed = await refresh(current);
    } catch (error) {
      if (!(error instanceof CredentialsExpiredError) || this.identity() === fence) throw error;
      return this.#overtaken(error);
    }

    if (this.identity() !== fence) return this.#overtaken();
    this.#commit(refreshed);
    return refreshed;
  }

  /**
   * Resolves a refresh overtaken by reconnect or revoke.
   * @param cause Optional expiry error from the stale refresh.
   * @returns Replacement credentials, or throws when disconnected.
   */
  #overtaken(cause?: unknown): Creds {
    const latest = this.stored();
    if (latest !== undefined) return latest;
    throw new CredentialsExpiredError("This account was disconnected while refreshing.", { cause });
  }
}

/** One fetch of credentials, tagged with their identity and connection generation. */
export type CredentialsWithIdentity<Creds> =
  { creds: Creds; identity: string; generation: string };

/** Account-side RPC shape. See `CredentialSourceOptions.account` for stub ownership. */
export type AccountCredentialStub<Creds> = {
  /**
   * Reads current credentials, refreshing as needed.
   * @returns Current credentials, their identity fence, and their connection generation.
   * @throws On confirmed expiry, an error named `CredentialsExpiredError` — the transport may strip
   * the class, so the name is the contract the source drops its cache authority on.
   */
  getCredentials(): Promise<CredentialsWithIdentity<Creds>>;
  /**
   * Reports expiry and answers whether the report was accepted.
   * @param identity Credential identity used by the failed call.
   * @returns Whether `identity` is still the account's current one — an adjudication of identity,
   * never of notification delivery, which the account owns end to end. `false` means a newer
   * credential superseded it and the failure was stale; the source resolves that as retryable and
   * drops its now-stale authority until the next read. Anything else — including a transport that
   * drops return values — reads as accepted, so a dead grant is never masked as retryable by a
   * lost answer.
   */
  noteCredentialsExpired(identity: string): Promise<boolean>;
};

/** `CredentialSource` keeps one flight -- the account's current credentials -- so it needs one key. */
const CREDENTIALS_FLIGHT = "credentials";

/** Configures credentials fetched across the account RPC boundary. */
export type CredentialSourceOptions<Creds> = {
  /** @returns A fresh or caller-owned account credential stub. */
  account(): AccountCredentialStub<Creds>;
  /**
   * Replaces credentials the provider rejected — required by `run`'s `replayable` retry, which
   * throws without it. Wire it where a rejection short of grant death is survivable — a derived
   * bearer minted from a longer-lived grant, or a rotating grant; grant-death providers leave it
   * unset and do not mark operations replayable. The mint is account-side by construction
   * (refresh material never reaches a facet); the RPC behind this callback is per-vendor.
   *
   * The contract is the mint: return credentials the provider has not already rejected — never a
   * cache that may still hold `rejected.creds` — unless the stored grant has moved past
   * `rejected.identity`, where current credentials answer as they are. A lazy implementation that
   * re-serves the rejected credentials retires a healthy grant on its first stale rejection; the
   * source cannot verify freshness for it.
   * @param rejected The read whose credentials the provider just rejected.
   * @returns Credentials refreshed past the rejected ones.
   * @throws As `getCredentials`: confirmed grant expiry is an error named `CredentialsExpiredError`.
   */
  refreshCredentials?(
    rejected: CredentialsWithIdentity<Creds>,
  ): Promise<CredentialsWithIdentity<Creds>>;
  /**
   * Classifies credential rejection — the provider refusing the presented credentials. Per-resource
   * access denials must remain separate so an unauthorized request cannot disconnect a healthy
   * account. The classifier need not tell a stale derived bearer from a dead grant — the
   * provider's signal is the same; with a `refreshCredentials` channel the refresh outcome
   * disambiguates.
   * @param error Caught provider error.
   * @returns Whether credentials caused the failure.
   */
  isAuthError(error: unknown): boolean;
  /** What the gadget is told when they no longer work. */
  expiredMessage: string;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * Fetches current credentials for provider operations and reports confirmed expiry. Reads coalesce
 * while in flight but are not cached across operations.
 *
 * @example
 * ```ts
 * #creds = new CredentialSource<VendorCreds>({
 *   account: () => this.env.ACCOUNT.get(this.accountId),
 *   isAuthError: error => error instanceof VendorApiError && error.status === 401,
 *   expiredMessage: "Reconnect the vendor account.",
 * });
 *
 * listProjects() {
 *   return this.#creds.run(creds => this.#api.listProjects(creds));
 * }
 * ```
 */
export class CredentialSource<Creds> {
  readonly #options: CredentialSourceOptions<Creds>;
  readonly #logger: typeof logger;
  readonly #fetches = new SingleFlight();
  readonly #replays = new SingleFlight<CredentialsWithIdentity<Creds>>();
  #generation: string | undefined;
  #identity: string | undefined;
  // Bounded by account commits per activation; eviction is unsafe against out-of-order stale reports.
  readonly #dead = new Set<string>();
  #clearFence = 0;

  /**
   * Creates a consumer-side credential source.
   * @param options Account accessor and provider error policy.
   */
  constructor(options: CredentialSourceOptions<Creds>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
  }

  /** @returns Current credentials without provider-error handling. */
  async get(): Promise<Creds> {
    return (await this.#current()).creds;
  }

  /**
   * The cache authority for data fetched through this source (`KvTtlCache.partitionedBy`): mirrors
   * the connection generation of the last successful fetch rather than reading the account live, so
   * a reconnect repartitions at the next fetch and a token refresh never does. A shared last-seen
   * value a concurrent fetch can move — action-fence capture must ride the `generation` of its own
   * `getCredentials()` read, never this accessor. Direct callers compose custom authorities for the
   * raw cache constructor.
   * @returns The last-seen connection generation; `undefined` (principal unknown) until a fetch
   * succeeds, and from a reported — or account-refused — expiry until a fetch started after the
   * report adopts an identity not reported dead.
   */
  authority(): string | undefined {
    return this.#generation;
  }

  /**
   * Runs a provider operation and reports confirmed expiry.
   * @param operation Provider call using current credentials.
   * @param options `replayable` marks the operation safe to execute twice: a credential rejection
   * is retried once with credentials refreshed through the `refreshCredentials` channel, and only
   * a rejection of those — the freshest the account can mint — reports expiry. The flag requires
   * the channel and throws without one, so a derived-bearer port that forgot the wiring fails at
   * first use instead of reporting a routine stale-bearer rejection as grant death.
   * @returns The provider operation result.
   */
  async run<T>(
    operation: (credentials: Creds) => Promise<T>,
    options: { replayable?: boolean } = {},
  ): Promise<T> {
    const { refreshCredentials } = this.#options;
    if (options.replayable && refreshCredentials === undefined) {
      throw new Error("A replayable operation requires a refreshCredentials channel.");
    }
    const first = await this.#current();
    try {
      return await operation(first.creds);
    } catch (error) {
      if (!this.#options.isAuthError(error)) throw error;
      if (!options.replayable || refreshCredentials === undefined
        || this.#dead.has(first.identity)) {
        return this.#report(first.identity, error);
      }
      // A reconnect adopted since this read already decides the outcome — don't spend the
      // channel, or hand its failures, on a superseded read.
      if (this.#moved(first.generation)) throw this.#changed(error);
      const second = await this.#refreshed(first, refreshCredentials);
      // A parallel replay already had this mint's grant adjudicated dead — don't replay it.
      if (this.#dead.has(second.identity)) {
        return this.#adjudicate(second.identity, error);
      }
      // An authority adopted during the refresh is newer than this read and stays; the caller
      // re-enters like any other mid-operation replacement.
      if (this.#moved(first.generation)) throw this.#changed(error);
      // A generation moved in the refresh result means a reconnect: replaying would act under a
      // principal the caller never fetched. The crossing stales any authority not adopted past
      // it — unknown included, or a pending read could restore the pre-reconnect partition.
      if (second.generation !== first.generation) {
        this.#supersede();
        throw this.#changed(error);
      }
      try {
        return await operation(second.creds);
      } catch (replayError) {
        if (!this.#options.isAuthError(replayError)) throw replayError;
        return this.#adjudicate(second.identity, replayError);
      }
    }
  }

  /**
   * Resolves a confirmed credential rejection: rethrown as retryable when a newer fetch already
   * adopted a live grant, adjudicated with the account otherwise.
   * @param identity Credential identity used by the failed call.
   * @param cause Provider rejection being resolved.
   */
  async #report(identity: string, cause: unknown): Promise<never> {
    // A newer fetch adopted a live grant: this failure is stale, so that grant is neither
    // reported dead nor its cache authority dropped. The shortcut needs evidence the source
    // stands behind — an adopted identity that is itself dead, or one whose authority was
    // dropped, is no successor; then the account adjudicates.
    if (this.#generation !== undefined && identity !== this.#identity
      && this.#identity !== undefined && !this.#dead.has(this.#identity)) {
      throw this.#changed(cause);
    }
    return this.#adjudicate(identity, cause);
  }

  /**
   * Reports a rejection to the account and resolves it by the verdict: a refused report is
   * retryable, anything else is expiry. Replay paths call this directly — their identity is
   * just-minted, so the snapshot cannot be newer than it and only the account adjudicates.
   * @param identity Credential identity used by the failed call.
   * @param cause Provider rejection being resolved.
   */
  async #adjudicate(identity: string, cause: unknown): Promise<never> {
    const accepted = await this.#note(identity);
    // Ask first, then clear and fence in one synchronous transition — a read resolving during the
    // answer would slip an adoption between a clear and a later fence. Either way the answer goes,
    // the authority drops: dead, its partition could serve the next principal stale data on a hit;
    // superseded, this snapshot no longer vouches for the current principal.
    if (accepted === false) {
      this.#supersede();
      throw this.#changed(cause);
    }
    this.#supersede(identity);
    throw new Error(this.#options.expiredMessage, { cause });
  }

  /** @returns The retryable error for credentials replaced mid-operation. */
  #changed(cause: unknown): Error {
    return new Error("This account's credentials changed during the operation; retry it.",
      { cause });
  }

  /**
   * @param generation Connection generation of a caller's read.
   * @returns Whether the adopted authority moved past that read — a reconnect adopted since it.
   * An unknown authority has not: it cannot outrank the read's own fetch.
   */
  #moved(generation: string): boolean {
    return this.#generation !== undefined && this.#generation !== generation;
  }

  /**
   * Drops the cache authority and fences out account reads started before now — the in-flight one
   * included — so neither can overwrite what this source just learned.
   * @param dead Identity to stop adopting after its confirmed expiry.
   */
  #supersede(dead?: string): void {
    if (dead !== undefined) this.#dead.add(dead);
    this.#generation = undefined;
    this.#clearFence++;
    this.#fetches.forget(CREDENTIALS_FLIGHT);
  }

  /**
   * Mints past a provider-rejected read through the refresh channel. The refresh flows through
   * this source so the replay's identity — what a second rejection reports — is the one actually
   * retried, but the result is only observed, never adopted: plain reads stay the snapshot's only
   * writer, so a mint cannot race the authority. Coalesced per rejected read, never per identity —
   * a run holding differently-rejected credentials must convey its own, or it would replay ones
   * another caller already saw rejected.
   * @param rejected The read whose credentials the provider rejected.
   * @param refreshCredentials The configured refresh channel.
   * @returns Credentials minted past the rejected read.
   */
  async #refreshed(
    rejected: CredentialsWithIdentity<Creds>,
    refreshCredentials: NonNullable<CredentialSourceOptions<Creds>["refreshCredentials"]>,
  ): Promise<CredentialsWithIdentity<Creds>> {
    try {
      return await this.#replays.run(rejected, () => refreshCredentials(rejected));
    } catch (error) {
      if (isExpiredError(error)) {
        // The channel confirming expiry is the account's own verdict — unless a reconnect was
        // adopted meanwhile, where the verdict concerns a replaced grant and the caller re-enters.
        if (this.#moved(rejected.generation)) throw this.#changed(error);
        // Take the death fences, so a read still in flight cannot restore the dead authority.
        this.#supersede(rejected.identity);
      }
      throw error;
    }
  }

  /**
   * Runs one coalesced account credential read, adopting its identity and cache authority unless
   * fenced out.
   * @returns The fetched credentials.
   */
  async #current(): Promise<CredentialsWithIdentity<Creds>> {
    const fence = this.#clearFence;
    let current: CredentialsWithIdentity<Creds>;
    try {
      current = await this.#fetches.run(
        CREDENTIALS_FLIGHT, () => this.#options.account().getCredentials());
    } catch (error) {
      // A fetch rejecting with confirmed expiry (a failed refresh) reports the grant as dead as a
      // 401 does. Fenced like adoption: a straggler's stale rejection must not clear a revival.
      if (fence === this.#clearFence && isExpiredError(error)) this.#generation = undefined;
      throw error;
    }
    // Dual guard, neither subsumes the other: the fence blocks fetches started before an expiry
    // report (a straggler can carry any old identity, not just a marked one), the dead set blocks
    // the grants the account keeps serving after their reports. The fence holds even against a
    // read resolving a reconnect: generations are opaque and equality-only, so a fenced response
    // cannot prove itself newest — authority stays the last unfenced fetch.
    if (fence === this.#clearFence && !this.#dead.has(current.identity)) {
      this.#generation = current.generation;
      this.#identity = current.identity;
    }
    return current;
  }

  /**
   * Reports expiry without replacing the provider error.
   * @param identity Credential identity used by the failed call.
   * @returns The account's verdict, or `undefined` when it was unreachable — read as accepted, so
   * an outage cannot mask a dead grant as retryable.
   */
  async #note(identity: string): Promise<boolean | undefined> {
    try {
      return await this.#options.account().noteCredentialsExpired(identity);
    } catch (error) {
      this.#logger.error("failed to report credential expiry", {
        event: "credentials.expiry.report.failed",
        error,
      });
      return undefined;
    }
  }
}
