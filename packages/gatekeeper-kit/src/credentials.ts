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

/**
 * Credentials replaced while an operation was in flight: the rejection the operation saw was
 * stale, nothing was adjudicated against the account, and the caller retries by re-entering.
 */
export class CredentialsChangedError extends Error {
  /**
   * Creates a retryable mid-operation replacement error.
   * @param options Optional error cause — typically the stale provider rejection.
   */
  constructor(options?: { cause?: unknown }) {
    super("This account's credentials changed during the operation; retry it.", options);
    this.name = "CredentialsChangedError";
  }
}

/**
 * Matches confirmed expiry by name, which survives the RPC boundary where the class does not.
 * @param error Caught error.
 * @returns Whether the error is a confirmed credential expiry.
 */
export function isCredentialsExpired(error: unknown): boolean {
  return error instanceof Error && error.name === "CredentialsExpiredError";
}

/**
 * Matches a retryable mid-operation credential replacement by name, which survives the RPC
 * boundary where the class does not.
 * @param error Caught error.
 * @returns Whether the error marks the operation retryable.
 */
export function isCredentialsChanged(error: unknown): boolean {
  return error instanceof Error && error.name === "CredentialsChangedError";
}

/**
 * The account's adjudication of a reported credential rejection.
 * - `"expired"` — the grant is dead; the account has notified the Workshop.
 * - `"superseded"` — the rejected identity is no longer current: already replaced, or just healed
 *   past. The failure was stale, so the caller retries or re-enters.
 * - `"unavailable"` — the heal failed for non-credential reasons; nothing was adjudicated, and the
 *   consumer surfaces the caller's original provider error.
 */
export type RejectionVerdict = "expired" | "superseded" | "unavailable";

/** Awaits a Workshop notification, logging a failure rather than masking the verdict with it. */
async function notified(notify: () => Promise<void>): Promise<void> {
  try {
    await notify();
  } catch (error) {
    logger.warn("failed to notify credential expiry", {
      event: "credentials.expiry.notify.failed",
      error,
    });
  }
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

  /**
   * Reads the credential triple the account RPC surface serves: current credentials, their
   * identity fence, and their connection generation. The three reads are synchronous after the
   * refresh settles — no await between them — so a `connect()` landing at the await boundary
   * cannot tear the triple apart. That atomicity is why the helper lives on the coordinator; a
   * hand-written `getCredentials` owns it itself.
   * @param refresh Provider refresh operation.
   * @param options `notify` announces confirmed grant death to the Workshop before the rethrow.
   * @returns Current credentials with their identity and connection generation.
   * @throws `CredentialsExpiredError` on confirmed expiry, after awaiting `notify` when the dead
   * grant is still stored — a disconnect is a user action, not grant death, and never notifies.
   */
  async snapshot(
    refresh: (current: Creds) => Promise<Creds>,
    options: { notify?: () => Promise<void> } = {},
  ): Promise<CredentialsWithIdentity<Creds>> {
    try {
      await this.fresh(refresh);
    } catch (error) {
      if (isCredentialsExpired(error) && this.stored() !== undefined && options.notify !== undefined) {
        await notified(options.notify);
      }
      throw error;
    }
    const creds = this.stored();
    if (creds === undefined) throw new CredentialsExpiredError("This account is not connected.");
    return { creds, identity: this.identity(), generation: this.connectionGeneration() };
  }

  /**
   * Adjudicates a consumer-reported credential rejection, healing past a rejected-but-current
   * credential inside the ask. The verdict adjudicates the identity, never notification delivery,
   * which the account owns end to end. Invariants a hand-written implementation owns instead:
   * the moved-past gate (`""` never matches), the heal fenced on the rejected identity, and
   * honest verdicts — `"expired"` only for provider-confirmed grant death.
   *
   * No durable mint latch guards a dead grant: a repeat report costs one provider call that
   * answers `invalid_grant` again — the same verdict — and Workshop notification is already
   * deduped by `notifyCredentialsExpiredOnce`'s latch. A port that measures mint spam adds a
   * cooldown inside its `refresh` callback.
   * @param identity Credential identity the consumer saw rejected.
   * @param options `refresh` mints past a stale credential (grant-death providers leave it unset);
   * `notify` announces confirmed grant death to the Workshop.
   * @returns The verdict on the rejected identity.
   */
  async adjudicateRejection(
    identity: string,
    options: { refresh?: (current: Creds) => Promise<Creds>; notify: () => Promise<void> },
  ): Promise<RejectionVerdict> {
    // Moved-past gate: a rejected identity no longer current was already replaced, and "" — a
    // never-connected read — must not match a never-connected account's own "".
    if (identity === "" || identity !== this.identity()) return "superseded";
    // A grant-death provider has no mint to heal with: the rejection is the grant's death.
    if (options.refresh === undefined) {
      await notified(options.notify);
      return "expired";
    }
    try {
      // Fence-keyed, so concurrent heals of one identity collapse onto one provider mint.
      await this.rotate(options.refresh);
      // The commit rotated the fence — or a reconnect overtook the mint. Either way the rejected
      // identity is no longer current.
      return "superseded";
    } catch (error) {
      if (isCredentialsExpired(error)) {
        // A reconnect landing while the mint failed replaced the rejected grant; it wins.
        if (this.identity() !== identity) return "superseded";
        await notified(options.notify);
        return "expired";
      }
      // Non-credential mint failure: nothing adjudicated, credentials intact. The consumer
      // surfaces the caller's original provider error; the token endpoint's lives in this log.
      logger.error("credential rejection heal failed", {
        event: "credentials.rejection.heal.failed",
        error,
      });
      return "unavailable";
    }
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
   * Reports expiry and answers with the account's verdict on the reported identity.
   * @param identity Credential identity used by the failed call.
   * @returns An adjudication of identity, never of notification delivery, which the account owns
   * end to end. `"superseded"` means a newer credential replaced it and the failure was stale; the
   * source resolves that as retryable and drops its now-stale authority until the next read.
   * Anything else — including a transport that drops return values — reads as `"accepted"`, so a
   * dead grant is never masked as retryable by a lost answer.
   */
  noteCredentialsExpired(identity: string): Promise<ExpiryVerdict>;
};

/** The account's verdict on a reported expiry: latched for its current identity, or refused. */
export type ExpiryVerdict = "accepted" | "superseded";

/** Mints credentials past a provider-rejected read. See `CredentialSourceOptions.refreshCredentials`. */
export type RefreshCredentials<Creds> =
  (rejected: CredentialsWithIdentity<Creds>) => Promise<CredentialsWithIdentity<Creds>>;

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
  refreshCredentials?: RefreshCredentials<Creds>;
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
  readonly #asks = new SingleFlight();
  #generation: string | undefined;
  #identity: string | undefined;
  // Generation of the last unfenced adoption. Never cleared: crossings must stay recordable
  // across the authority clears that precede exactly the adoptions that observe them.
  #seen: string | undefined;
  // Bounded by account commits per activation; eviction is unsafe against out-of-order stale reports.
  readonly #dead = new Set<string>();
  // Generations proven superseded by an observed crossing; bounded by reconnects per activation.
  readonly #crossed = new Set<string>();
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
    const channel = options.replayable ? this.#channel() : undefined;
    const first = await this.#current();
    try {
      return await operation(first.creds);
    } catch (error) {
      if (!this.#options.isAuthError(error)) throw error;
      // A read proven superseded — its generation crossed, or a newer one adopted — is stale even
      // after the successor itself dies and the authority clears: no channel or ask is spent on
      // its behalf.
      if (this.#moved(first.generation)) throw this.#changed(error);
      if (channel === undefined || this.#dead.has(first.identity)) {
        return this.#report(first, error);
      }
      return this.#replay(operation, first, channel, error);
    }
  }

  /** @returns The refresh channel a replayable operation requires; throws when none is wired. */
  #channel(): RefreshCredentials<Creds> {
    const { refreshCredentials } = this.#options;
    if (refreshCredentials === undefined) {
      throw new Error("A replayable operation requires a refreshCredentials channel.");
    }
    return refreshCredentials;
  }

  /**
   * Retries a rejected operation once with credentials minted past the rejected read; only a
   * rejection of the mint reaches the account.
   * @param operation Provider call being replayed.
   * @param first The read whose credentials the provider rejected, not proven superseded.
   * @param channel The configured refresh channel.
   * @param cause Provider rejection being resolved.
   * @returns The replayed operation result.
   */
  async #replay<T>(
    operation: (credentials: Creds) => Promise<T>,
    first: CredentialsWithIdentity<Creds>,
    channel: RefreshCredentials<Creds>,
    cause: unknown,
  ): Promise<T> {
    const second = await this.#refreshed(first, channel);
    // An authority adopted during the refresh is newer than this read and stays; the caller
    // re-enters like any other mid-operation replacement. Before the dead shortcut, or a
    // delayed dead-mint response would have a superseded read adjudicated against it. The
    // proof is recorded: an adoption landing mid-refresh preempts the crossing the result
    // would record below, and another read's delayed mint must still find the evidence.
    if (this.#moved(first.generation)) {
      this.#crossed.add(first.generation);
      throw this.#changed(cause);
    }
    // A generation moved in the refresh result means a reconnect: replaying would act under a
    // principal the caller never fetched. Recorded and checked before the dead shortcut — a
    // dead mint carries the same evidence — and the crossing stales any authority not adopted
    // past it, unknown included, or a pending read could restore the pre-reconnect partition.
    if (second.generation !== first.generation) {
      this.#crossed.add(first.generation);
      this.#supersede();
      throw this.#changed(cause);
    }
    // A parallel replay already had this same-generation mint's grant adjudicated dead — don't
    // replay it.
    if (this.#dead.has(second.identity)) {
      return this.#adjudicate(second.identity, cause);
    }
    try {
      return await operation(second.creds);
    } catch (replayError) {
      if (!this.#options.isAuthError(replayError)) throw replayError;
      // A reconnect adopted during the replay supersedes it: the account's verdict on the old
      // mint could only be "superseded", so skip the ask rather than risk losing its answer.
      if (this.#moved(first.generation)) throw this.#changed(replayError);
      return this.#adjudicate(second.identity, replayError);
    }
  }

  /**
   * Resolves a confirmed credential rejection of a read not proven superseded (`run` rules that
   * out first): rethrown as retryable when a newer fetch already adopted a live grant,
   * adjudicated with the account otherwise.
   * @param read The read whose credentials the provider rejected.
   * @param cause Provider rejection being resolved.
   */
  async #report(read: CredentialsWithIdentity<Creds>, cause: unknown): Promise<never> {
    // A newer fetch adopted a live grant: this failure is stale, so that grant is neither
    // reported dead nor its cache authority dropped. The shortcut needs evidence the source
    // stands behind — an adopted identity that is itself dead, or one whose authority was
    // dropped, is no successor; then the account adjudicates.
    if (this.#generation !== undefined && read.identity !== this.#identity
      && this.#identity !== undefined && !this.#dead.has(this.#identity)) {
      throw this.#changed(cause);
    }
    return this.#adjudicate(read.identity, cause);
  }

  /**
   * Reports a rejection to the account and resolves it by the verdict: a refused report is
   * retryable, anything else is expiry. Replay paths call this directly once an adopted reconnect
   * is ruled out — their identity is just-minted, so no snapshot outranks it by identity and only
   * the account adjudicates.
   * @param identity Credential identity used by the failed call.
   * @param cause Provider rejection being resolved.
   */
  async #adjudicate(identity: string, cause: unknown): Promise<never> {
    // Drop at the ask: the rejection already proves this snapshot cannot vouch, whichever way
    // the answer goes — dead, its partition could serve the next principal stale data on a hit;
    // superseded, it no longer vouches for the current principal — so cache-first readers bypass
    // during the round trip instead of serving the rejected partition. Drop again on the answer:
    // the account keeps serving the grant until an accepted verdict, so a read landing meanwhile
    // may re-adopt it, and the death mark itself must wait for the account's word.
    this.#supersede();
    // The verdict adjudicates the identity, not the report, so concurrent reporters of one grant
    // — every replay of a shared dead mint, say — share the account round trip.
    const verdict = await this.#asks.run(identity, () => this.#note(identity));
    if (verdict === "superseded") {
      this.#supersede();
      throw this.#changed(cause);
    }
    this.#supersede(identity);
    throw new CredentialsExpiredError(this.#options.expiredMessage, { cause });
  }

  /** @returns The retryable error for credentials replaced mid-operation. */
  #changed(cause: unknown): Error {
    return new CredentialsChangedError({ cause });
  }

  /**
   * @param generation Connection generation of a caller's read.
   * @returns Whether that read is proven superseded — a newer generation adopted since it, or its
   * own observed crossed. An unknown authority alone is no proof (it cannot outrank the read's
   * own fetch), and neither is the last-seen generation: a fenced read can be newer than it, so
   * `#seen` only ever records, never refuses.
   */
  #moved(generation: string): boolean {
    return this.#crossed.has(generation)
      || (this.#generation !== undefined && this.#generation !== generation);
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
   * @param channel The configured refresh channel.
   * @returns Credentials minted past the rejected read.
   */
  async #refreshed(
    rejected: CredentialsWithIdentity<Creds>,
    channel: RefreshCredentials<Creds>,
  ): Promise<CredentialsWithIdentity<Creds>> {
    try {
      return await this.#replays.run(rejected, () => channel(rejected));
    } catch (error) {
      // A reconnect adopted meanwhile supersedes this read — every failure of its refresh,
      // confirmed expiry included, concerns a replaced grant, and the caller re-enters.
      if (this.#moved(rejected.generation)) throw this.#changed(error);
      // The channel confirming expiry is the account's own verdict: take the death fences, so a
      // read still in flight cannot restore the dead authority.
      if (isCredentialsExpired(error)) this.#supersede(rejected.identity);
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
      if (fence === this.#clearFence && isCredentialsExpired(error)) this.#generation = undefined;
      throw error;
    }
    // Dual guard, neither subsumes the other: the fence blocks fetches started before an expiry
    // report (a straggler can carry any old identity, not just a marked one), the dead set blocks
    // the grants the account keeps serving after their reports. The fence holds even against a
    // read resolving a reconnect: generations are opaque and equality-only, so a fenced response
    // cannot prove itself newest — authority stays the last unfenced fetch.
    if (fence === this.#clearFence && !this.#dead.has(current.identity)) {
      // Unfenced adoptions serialize, so adopting past a different last-seen generation is an
      // observed crossing. Compared against #seen, not the authority: a clear between the two
      // adoptions would otherwise take the evidence with it.
      if (this.#seen !== undefined && this.#seen !== current.generation) {
        this.#crossed.add(this.#seen);
      }
      this.#seen = current.generation;
      this.#generation = current.generation;
      this.#identity = current.identity;
    }
    return current;
  }

  /**
   * Reports expiry without replacing the provider error.
   * @param identity Credential identity used by the failed call.
   * @returns The account's verdict; an unreachable account reads as accepted, so an outage cannot
   * mask a dead grant as retryable.
   */
  async #note(identity: string): Promise<ExpiryVerdict> {
    try {
      return await this.#options.account().noteCredentialsExpired(identity);
    } catch (error) {
      this.#logger.error("failed to report credential expiry", {
        event: "credentials.expiry.report.failed",
        error,
      });
      return "accepted";
    }
  }
}
