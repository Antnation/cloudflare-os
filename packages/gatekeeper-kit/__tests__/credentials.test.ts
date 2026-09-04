import { describe, expect, it, vi } from "vitest";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  CredentialSource,
  type CredentialCoordinatorOptions,
  type CredentialsKv,
  type CredentialSourceOptions,
  type CredentialsWithIdentity,
  type ExpiryVerdict,
} from "../src/credentials";
import { fakeKv } from "./fake-kv";

type Creds = { token: string; expiresAt: number };

function makeKv(): CredentialsKv {
  return fakeKv();
}

function coordinator(
  kv: CredentialsKv,
  upgrade?: CredentialCoordinatorOptions<Creds>["upgrade"],
  legacyKeys: readonly string[] = ["accessToken"],
) {
  return new CredentialCoordinator<Creds>(
    kv, { expiresAt: creds => creds.expiresAt, upgrade, legacyKeys });
}

const live: Creds = { token: "live", expiresAt: Date.now() + 60 * 60 * 1000 };
const stale: Creds = { token: "stale", expiresAt: Date.now() + 1000 };

describe("CredentialCoordinator", () => {
  it("reports expiry when nothing is stored", async () => {
    await expect(coordinator(makeKv()).fresh(async () => live))
      .rejects.toThrow(CredentialsExpiredError);
  });

  it("returns stored credentials until they near expiry, then refreshes once", async () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(live);
    const refresh = vi.fn(async () => ({ token: "refreshed", expiresAt: live.expiresAt }));

    expect(await instance.fresh(refresh)).toEqual(live);
    expect(refresh).not.toHaveBeenCalled();

    instance.connect(stale);
    expect((await instance.fresh(refresh)).token).toBe("refreshed");
    expect(instance.stored()?.token).toBe("refreshed");
  });

  it("rotates an unexpired credential the provider rejected, coalescing a burst", async () => {
    // What `fresh` cannot express: a 401 on a token nowhere near its recorded expiry. Three shipped
    // gatekeepers refresh unconditionally there, and returning the rejected token instead would
    // loop the retry and report a healthy grant dead.
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(live);
    let minted = 0;
    const refresh = vi.fn(async () => ({ token: `rotated${++minted}`, expiresAt: live.expiresAt }));

    const [first, second] = await Promise.all([instance.rotate(refresh), instance.rotate(refresh)]);
    expect(first.token).toBe("rotated1");
    expect(second.token).toBe("rotated1");
    expect(refresh).toHaveBeenCalledOnce();
    expect(instance.stored()?.token).toBe("rotated1");
  });

  it("refuses to rotate an account holding no grant", async () => {
    await expect(coordinator(makeKv()).rotate(async () => live))
      .rejects.toThrow(CredentialsExpiredError);
  });

  it("refuses a refresh window that would read a dead token as live", async () => {
    // Fails open, unlike a bad `maxPending`: a negative skew moves the freshness boundary past
    // expiry, and a non-finite one makes the comparison itself meaningless.
    for (const refreshSkewMs of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(() => new CredentialCoordinator<Creds>(makeKv(), { refreshSkewMs }))
        .toThrow(/refreshSkewMs must be a non-negative finite number/);
    }
    expect(() => new CredentialCoordinator<Creds>(makeKv(), { refreshSkewMs: 0 })).not.toThrow();
  });

  it("requires expiry callbacks to return a finite epoch or undefined", async () => {
    for (const expiresAt of [Infinity, -Infinity, Number.NaN]) {
      const instance = new CredentialCoordinator<Creds>(makeKv(), { expiresAt: () => expiresAt });
      instance.connect(live);
      await expect(instance.fresh(async () => live))
        .rejects.toThrow(`expiresAt must be finite or undefined, got ${expiresAt}.`);
    }

    for (const expiresAt of [undefined, live.expiresAt]) {
      const instance = new CredentialCoordinator<Creds>(makeKv(), { expiresAt: () => expiresAt });
      instance.connect(live);
      await expect(instance.fresh(async () => stale)).resolves.toEqual(live);
    }
  });

  it("honours a refresh window wider than the default", async () => {
    const instance = new CredentialCoordinator<Creds>(makeKv(), {
      expiresAt: creds => creds.expiresAt,
      refreshSkewMs: 5 * 60_000,
    });
    instance.connect({ token: "soon", expiresAt: Date.now() + 3 * 60_000 });

    // Three minutes out: outside the default one-minute window, inside this one.
    const refreshed = await instance.fresh(async () => ({
      token: "refreshed",
      expiresAt: live.expiresAt,
    }));
    expect(refreshed.token).toBe("refreshed");
  });

  it("coalesces concurrent refreshes onto one provider round-trip", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();
    const refresh = vi.fn(() => promise);

    const both = Promise.all([instance.fresh(refresh), instance.fresh(refresh)]);
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await both).map(creds => creds.token)).toEqual(["refreshed", "refreshed"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("coalesces refreshes across coordinator instances over one storage", async () => {
    // The flight is keyed by the storage object, so a port constructing a coordinator per call
    // still spends one single-use refresh token, not one per instance.
    const kv = makeKv();
    const first = coordinator(kv);
    const second = coordinator(kv);
    first.connect(stale);
    let minted = 0;
    const refresh = vi.fn(async () => ({ token: `rotated${++minted}`, expiresAt: live.expiresAt }));

    const both = await Promise.all([first.rotate(refresh), second.rotate(refresh)]);
    expect(both.map(creds => creds.token)).toEqual(["rotated1", "rotated1"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("preserves the connection generation across refresh, rotating it on connect and clear", async () => {
    const instance = coordinator(makeKv());
    // Minted on first read and stored, so it is never "".
    const generation = instance.connectionGeneration();
    expect(generation).toMatch(/^[0-9a-f]{64}$/);
    expect(instance.connectionGeneration()).toBe(generation);

    instance.connect(stale);
    const connected = instance.connectionGeneration();
    expect(connected).not.toBe(generation);

    // A refresh rotates the identity fence but must not invalidate connection-keyed consumers.
    const fence = instance.identity();
    await instance.fresh(async () => live);
    expect(instance.identity()).not.toBe(fence);
    expect(instance.connectionGeneration()).toBe(connected);

    instance.clear();
    expect(instance.connectionGeneration()).not.toBe(connected);
  });

  it("lets a reconnect landing mid-refresh win", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("reports expiry when a revoke lands mid-refresh", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.clear();
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
    expect(instance.stored()).toBeUndefined();
  });

  it("leaves credentials intact when a refresh fails for infrastructure reasons", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);

    await expect(instance.fresh(async () => { throw new Error("502 from origin"); }))
      .rejects.toThrow("502 from origin");
    expect(instance.stored()).toEqual(stale);

    await expect(instance.fresh(async () => {
      throw new CredentialsExpiredError("invalid_grant");
    })).rejects.toThrow(CredentialsExpiredError);
    expect(instance.stored()).toEqual(stale);
  });

  it("propagates an infrastructure failure that races a reconnect, unfenced", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    reject(new Error("502 from origin"));

    // Only grant death is fenced; swallowing this would hide the outage, and fencing it against a
    // clear() would report an infrastructure failure as expiry.
    await expect(refreshing).rejects.toThrow("502 from origin");
  });

  it("issues an unguessable identity per write that a deleteAll cannot reissue", () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    // The one value that is never a fence: no credentials have ever been surfaced.
    expect(instance.identity()).toBe("");

    instance.connect(live);
    const first = instance.identity();
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    instance.connect(live);
    expect(instance.identity()).not.toBe(first);

    // revoke() and the self-destruct alarm both deleteAll, which a counter would restart from 1.
    // Superseding rotates rather than deletes, so a fence taken before it cannot come back.
    instance.clear();
    const superseded = instance.identity();
    expect(superseded).toMatch(/^[0-9a-f]{64}$/);
    expect(superseded).not.toBe(first);
  });

  it("fences a record written before the account had identities", async () => {
    const kv = makeKv();
    // What a pre-kit gatekeeper left behind: the canonical key, with no identity beside it.
    kv.put("credentials", stale);
    const instance = coordinator(kv);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // Raw, as revoke()'s deleteAll() leaves it -- no rotation of its own for the fence to lean on.
    kv.delete("credentials");
    kv.delete("credentials:identity");
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    // Only the identity `stored()` lazily minted for the pre-kit record can fence this: an
    // unfenceable "" would commit it over the wipe and reconnect the account the user revoked.
    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
    expect(kv.get("credentials")).toBeUndefined();
  });

  it("retires the legacy migration when the account is cleared before its first read", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });

    // A reconnect lands before anything read the credentials, so the migration never ran.
    const instance = coordinator(kv, upgrade);
    instance.connect(live);
    instance.clear();

    // Running it now would resurrect the grant the user has since replaced and revoked.
    expect(instance.stored()).toBeUndefined();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("retires the legacy migration for an upgrade the deployment had not shipped yet", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");

    // The port lands in two deployments: this one has no upgrade() at all, and the user
    // disconnects under it.
    coordinator(kv).clear();

    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });

    // The next deployment adds one, and the legacy key it reads is still sitting there. This is why
    // clear() marks unconditionally: it cannot know which upgrade() a later version will bring.
    expect(coordinator(kv, upgrade).stored()).toBeUndefined();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("cannot resurrect a legacy grant that was adopted and then cleared", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    // This coordinator declares no legacy keys, so the marker is the only thing retiring them.
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    const instance = coordinator(kv, upgrade, []);

    expect(instance.stored()?.token).toBe("legacy");
    instance.clear();

    expect(instance.stored()).toBeUndefined();
    expect(upgrade).toHaveBeenCalledOnce();
  });

  // Both of these pin write ORDER inside a single implicit transaction. A throw does not roll one
  // back, so the order is the only thing deciding what a storage failure leaves behind.
  it("rotates the fence even when the credential write fails", async () => {
    const kv = makeKv();
    let failCredentialWrite = false;
    const failing: CredentialsKv = {
      get: kv.get,
      delete: kv.delete,
      put: (key, value) => {
        if (failCredentialWrite && key === "credentials") throw new Error("storage unavailable");
        kv.put(key, value);
      },
    };
    const instance = coordinator(failing);
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // A reconnect lands mid-refresh and its record write fails -- after the fence rotated.
    failCredentialWrite = true;
    expect(() => instance.connect(live)).toThrow("storage unavailable");
    failCredentialWrite = false;

    resolve({ token: "refreshed", expiresAt: live.expiresAt });
    // Publishing before rotating would leave this refresh's fence matching, and it would commit
    // over a reconnect that had already been accepted.
    expect((await refreshing).token).toBe("stale");
    expect(instance.stored()?.token).toBe("stale");
  });

  it("retires the migration even when the clear cannot finish", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    let failIdentityWrite = false;
    const failing: CredentialsKv = {
      get: kv.get,
      delete: kv.delete,
      put: (key, value) => {
        if (failIdentityWrite && key === "credentials:identity") {
          throw new Error("storage unavailable");
        }
        kv.put(key, value);
      },
    };
    const instance = coordinator(failing, upgrade, []);

    expect(instance.stored()?.token).toBe("legacy");
    failIdentityWrite = true;
    expect(() => instance.clear()).toThrow("storage unavailable");
    failIdentityWrite = false;

    // The record goes last, so a failure here drops nothing: the account is still connected, and
    // the marker already landed. Dropping it first would leave no record and no marker, and this
    // read would re-run the migration and hand back the grant the user was disconnecting.
    expect(instance.stored()?.token).toBe("legacy");
    expect(upgrade).toHaveBeenCalledOnce();
  });

  it("refuses a refresh fenced out by a revoke and reconnect that wiped storage", async () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // What revoke() does, followed by a fresh connection.
    kv.delete("credentials");
    kv.delete("credentials:identity");
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("never lets a stale grant's death expire the grant that replaced it", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    reject(new CredentialsExpiredError("invalid_grant"));

    // Fenced out: the failure belonged to the credentials the reconnect replaced.
    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("still reports expiry when a fenced-out failure finds nothing stored", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.clear();
    reject(new CredentialsExpiredError("invalid_grant"));

    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
  });

  it("migrates legacy keys once, then reads the migrated record", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    const upgrade = vi.fn((storage: Pick<CredentialsKv, "get">) => {
      const token = storage.get<string>("accessToken");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    const instance = coordinator(kv, upgrade);

    expect(instance.stored()?.token).toBe("legacy");
    expect(instance.stored()?.token).toBe("legacy");
    expect(upgrade).toHaveBeenCalledOnce();
    expect(kv.get("accessToken")).toBeUndefined();
    expect(kv.get<Creds>("credentials")?.token).toBe("legacy");
  });

  it("leaves the legacy grant intact when the migration throws", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    const instance = coordinator(kv, () => {
      throw new Error("malformed legacy record");
    });

    expect(() => instance.stored()).toThrow("malformed legacy record");
    // A throw cannot roll back a Durable Object's implicit transaction, so the migration may not
    // delete anything itself: the grant is still here to retry from, and is not marked migrated.
    expect(kv.get("accessToken")).toBe("legacy");
    expect(kv.get("credentials:migrated")).toBeUndefined();
  });

  it("retries a reap the migration could not finish", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    let reapable = false;
    const failing: CredentialsKv = {
      ...kv,
      delete: key => {
        if (!reapable && key === "accessToken") throw new Error("storage unavailable");
        kv.delete(key);
      },
    };
    const instance = new CredentialCoordinator<Creds>(failing, {
      expiresAt: creds => creds.expiresAt,
      legacyKeys: ["accessToken"],
      upgrade: storage => {
        const token = storage.get<string>("accessToken");
        return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
      },
    });

    expect(() => instance.stored()).toThrow("storage unavailable");
    // Committed, so no later read re-enters the migration -- the stale grant is still readable by
    // anything that knows the old key.
    expect(kv.get("accessToken")).toBe("legacy");
    expect(instance.stored()?.token).toBe("legacy");

    reapable = true;
    instance.clear();
    expect(kv.get("accessToken")).toBeUndefined();
  });

  it("refuses to declare a legacy key the coordinator owns", () => {
    // Sweeping the whole `credentials:` namespace would take the identity with it, and an
    // unfenceable "" would then let an in-flight refresh commit over a revoke.
    expect(() => coordinator(makeKv(), undefined, ["accessToken", "credentials:identity"]))
      .toThrow('Legacy key "credentials:identity" is one the coordinator owns.');
  });

  describe("snapshot", () => {
    it("returns a coherent triple of the stored credentials", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);

      const read = await instance.snapshot(async () => live);
      expect(read).toEqual({
        creds: live,
        identity: instance.identity(),
        generation: instance.connectionGeneration(),
      });
      expect(read.identity).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps the triple coherent against a connect landing mid-refresh", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { promise, resolve } = Promise.withResolvers<Creds>();

      const reading = instance.snapshot(() => promise);
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      const identity = instance.identity();
      const generation = instance.connectionGeneration();
      resolve({ token: "refreshed", expiresAt: live.expiresAt });

      // The reconnect won the refresh; the triple must be its credentials under its identity and
      // generation, never the refresh result under the reconnect's fence.
      expect(await reading).toEqual({
        creds: { token: "reconnected", expiresAt: live.expiresAt },
        identity,
        generation,
      });
    });

    it("notifies the Workshop before rethrowing a confirmed expiry of the stored grant", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});

      await expect(instance.snapshot(async () => {
        throw new CredentialsExpiredError("invalid_grant");
      }, { notify })).rejects.toThrow("invalid_grant");
      expect(notify).toHaveBeenCalledOnce();

      // A notify that throws is logged account-side; the caller still gets the expiry verdict.
      const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(instance.snapshot(async () => {
          throw new CredentialsExpiredError("invalid_grant");
        }, { notify: async () => { throw new Error("workshop unreachable"); } }))
          .rejects.toThrow("invalid_grant");
      } finally {
        logged.mockRestore();
      }
    });

    it("never notifies for a disconnect", async () => {
      const notify = vi.fn(async () => {});
      // Nothing stored: reading a disconnected account is not grant death.
      await expect(coordinator(makeKv()).snapshot(async () => live, { notify }))
        .rejects.toThrow(CredentialsExpiredError);

      // A revoke mid-refresh is the user's own action; announcing expiry would misattribute it.
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { promise, resolve } = Promise.withResolvers<Creds>();
      const reading = instance.snapshot(() => promise, { notify });
      instance.clear();
      resolve({ token: "refreshed", expiresAt: live.expiresAt });
      await expect(reading).rejects.toThrow(CredentialsExpiredError);

      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("adjudicateRejection", () => {
    const notifyless = { notify: async () => {} };

    it("answers superseded for an identity that is no longer current, before any heal", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const refresh = vi.fn(async () => live);
      const notify = vi.fn(async () => {});

      await expect(instance.adjudicateRejection("someone-elses-fence", { refresh, notify }))
        .resolves.toBe("superseded");
      expect(refresh).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('never matches "" against a never-connected account', async () => {
      // A never-connected read carries identity ""; the account's own identity() is also "". An
      // equality gate alone would heal — or expire — an account that was never connected.
      const notify = vi.fn(async () => {});
      await expect(coordinator(makeKv()).adjudicateRejection("", { notify }))
        .resolves.toBe("superseded");
      expect(notify).not.toHaveBeenCalled();
    });

    it("expires a current identity on a grant-death provider, notifying first", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const order: string[] = [];
      const notify = vi.fn(async () => { order.push("notify"); });

      const verdict = await instance.adjudicateRejection(instance.identity(), { notify });
      order.push("verdict");
      expect(verdict).toBe("expired");
      expect(order).toEqual(["notify", "verdict"]);
      expect(instance.stored()).toEqual(live);
    });

    it("heals a current rejected identity and answers superseded", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});
      const refresh = vi.fn(async () => ({ token: "minted", expiresAt: live.expiresAt }));

      await expect(instance.adjudicateRejection(instance.identity(), { refresh, notify }))
        .resolves.toBe("superseded");
      expect(instance.stored()?.token).toBe("minted");
      expect(notify).not.toHaveBeenCalled();
    });

    it("expires the grant when the heal confirms its death, keeping the verdict past a failed notify", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const refresh = async (): Promise<Creds> => {
        throw new CredentialsExpiredError("invalid_grant");
      };
      const notify = vi.fn(async () => {});

      await expect(instance.adjudicateRejection(instance.identity(), { refresh, notify }))
        .resolves.toBe("expired");
      expect(notify).toHaveBeenCalledOnce();

      // A throwing notify is the account's own trouble, never a different verdict.
      const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(instance.adjudicateRejection(instance.identity(), {
          refresh, notify: async () => { throw new Error("workshop unreachable"); },
        })).resolves.toBe("expired");
      } finally {
        logged.mockRestore();
      }
    });

    it("answers unavailable when the heal fails for non-credential reasons", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(instance.adjudicateRejection(instance.identity(), {
          refresh: async () => { throw new Error("502 from token endpoint"); },
          notify,
        })).resolves.toBe("unavailable");
      } finally {
        logged.mockRestore();
      }

      // Nothing adjudicated: the grant is intact and no expiry was announced.
      expect(instance.stored()).toEqual(stale);
      expect(notify).not.toHaveBeenCalled();
    });

    it("lets a reconnect racing the heal win as superseded, even when the mint dies", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const notify = vi.fn(async () => {});
      const mint = Promise.withResolvers<Creds>();

      const adjudicating = instance.adjudicateRejection(rejected, {
        refresh: () => mint.promise, notify,
      });
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      mint.reject(new CredentialsExpiredError("invalid_grant"));

      // The dead mint belonged to the grant the reconnect replaced; expiring now would retire the
      // grant the user just connected.
      await expect(adjudicating).resolves.toBe("superseded");
      expect(notify).not.toHaveBeenCalled();
      expect(instance.stored()?.token).toBe("reconnected");
    });

    it("collapses concurrent heals of one identity onto one mint", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const mint = Promise.withResolvers<Creds>();
      const refresh = vi.fn(() => mint.promise);

      const verdicts = Promise.all([
        instance.adjudicateRejection(rejected, { refresh, ...notifyless }),
        instance.adjudicateRejection(rejected, { refresh, ...notifyless }),
      ]);
      mint.resolve({ token: "minted", expiresAt: live.expiresAt });

      expect(await verdicts).toEqual(["superseded", "superseded"]);
      expect(refresh).toHaveBeenCalledOnce();
    });
  });
});

describe("CredentialSource", () => {
  function source(overrides: Partial<CredentialSourceOptions<Creds>> = {}) {
    const getCredentials =
      vi.fn(async () => ({ creds: live, identity: "id-a", generation: "gen-a" }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
      ...overrides,
    });
    return { instance, getCredentials, noteCredentialsExpired };
  }

  it("coalesces concurrent account round-trips", async () => {
    const { instance, getCredentials } = source();

    const [first, second] = await Promise.all([instance.get(), instance.get()]);
    expect(first).toEqual(live);
    expect(second).toEqual(live);
    expect(getCredentials).toHaveBeenCalledOnce();

    expect(await instance.get()).toEqual(live);
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("hands the operation the credentials it fetched", async () => {
    const { instance } = source();
    expect(await instance.run(async creds => creds.token)).toBe("live");
  });

  it("surfaces the authority only while the principal is known", async () => {
    let identity = "id-a";
    let generation = "gen-a";
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: async () => ({ creds: live, identity, generation }),
        noteCredentialsExpired: async () => "accepted" as const,
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });
    // Nothing fetched yet: a cache keyed on this must bypass, not hit a props-keyed partition.
    expect(instance.authority()).toBeUndefined();

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // A reported expiry means a reconnect will rotate the generation; forget the old one.
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();

    // The account keeps the dead grant until reconnect: refetching the same identity must not
    // restore its partition, or hit-only cache paths would mask the outage for the TTL.
    await instance.get();
    expect(instance.authority()).toBeUndefined();

    // A fetch adopting a different identity — refresh or reconnect — re-establishes it.
    identity = "id-b";
    generation = "gen-b";
    await instance.get();
    expect(instance.authority()).toBe("gen-b");
  });

  it("reports expiry against the identity the failed call used", async () => {
    const { instance, getCredentials, noteCredentialsExpired } = source();

    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");

    await instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  const fresh: Creds = { token: "fresh", expiresAt: Date.now() + 60 * 60 * 1000 };

  /** A source with an account refresh channel, the way a derived-bearer port wires one. */
  function replayableSource(
    refresh: (rejected: CredentialsWithIdentity<Creds>) => Promise<CredentialsWithIdentity<Creds>>,
  ) {
    const refreshCredentials = vi.fn(refresh);
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const getCredentials =
      vi.fn(async () => ({ creds: live, identity: "id-a", generation: "gen-a" }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      refreshCredentials,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });
    return { instance, getCredentials, refreshCredentials, noteCredentialsExpired };
  }

  /** Starts a run whose 401 stalls until released, resolving once the operation has entered. */
  async function stalledRun(
    instance: CredentialSource<Creds>, options: { replayable?: boolean } = {},
  ) {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const run = instance.run(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("401");
    }, options);
    await entered.promise;
    return { run, release: gate.resolve };
  }

  it("replays a replayable operation once with credentials refreshed past the rejection", async () => {
    // A derived bearer minted from the same grant: identity does not move on a legitimate refresh.
    const { instance, refreshCredentials, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));

    const result = await instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      return creds.token;
    }, { replayable: true });

    expect(result).toBe("fresh");
    expect(refreshCredentials)
      .toHaveBeenCalledWith({ creds: live, identity: "id-a", generation: "gen-a" });
    // A recovered rejection is a stale bearer, not expiry; the connection survives untouched.
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-a");
  });

  it("reports the grant whose freshest credentials were rejected", async () => {
    const { instance, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));
    const operation = vi.fn(async () => { throw new Error("401"); });

    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(noteCredentialsExpired).toHaveBeenCalledOnce();
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");
    expect(instance.authority()).toBeUndefined();
  });

  it("reports the successor identity when the refresh rotates the grant", async () => {
    // A rotating refresh token (confluence-style) commits a successor grant while minting.
    const { instance, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-b", generation: "gen-a" }));

    await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");

    // The report must name what was replayed: the account gates on its current identity, so naming
    // the pre-rotation grant would be gated out, leaving the dead grant accepted and the Workshop
    // never told to reconnect.
    expect(noteCredentialsExpired).toHaveBeenCalledOnce();
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
  });

  it("refuses a replayable operation without a refresh channel", async () => {
    const { instance, getCredentials, noteCredentialsExpired } = source();
    const operation = vi.fn(async () => "unreached");

    // A derived-bearer port that forgot the wiring would otherwise report a routine stale-bearer
    // rejection as grant death; the misconfiguration surfaces at first use instead.
    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow("requires a refreshCredentials channel");
    expect(getCredentials).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("resolves a report the account refuses as superseded into a retry", async () => {
    // Another source instance over the same account refreshed past id-a; this snapshot cannot see
    // that, so the account's answer is what keeps the caller off a false reconnect prompt.
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "superseded" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: async () => ({ creds: live, identity: "id-a", generation: "gen-a" }),
        noteCredentialsExpired,
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");
    // The refusal proves this snapshot stale: its authority cannot vouch for the current
    // principal, so caches bypass until the next read re-establishes it.
    expect(instance.authority()).toBeUndefined();
  });

  it("refuses the replay when the refresh crosses a reconnect", async () => {
    const { instance, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-b", generation: "gen-b" }));

    await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
      .rejects.toThrow("credentials changed during the operation");

    // The replacement belongs to a connection the caller never fetched: replaying could act as a
    // different principal, and reporting would retire the grant the user just connected. The
    // crossing also proves the rejected generation superseded — cache hits under it could serve
    // the prior principal's entries — so the authority drops until the next read.
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
    expect(instance.authority()).toBeUndefined();
  });

  it("does not replay a mint whose grant was already reported dead", async () => {
    const { instance, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-b", generation: "gen-a" }));
    const operation = vi.fn(async () => { throw new Error("401"); });

    // The first run replays the rotated mint and has its grant (id-b) reported dead.
    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");
    expect(operation).toHaveBeenCalledTimes(2);

    // A later rejection whose refresh resolves to the dead grant reports instead of replaying.
    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(2);
    expect(noteCredentialsExpired).toHaveBeenLastCalledWith("id-b");
  });

  it.each([
    { verdict: "accepted", message: "Reconnect the account." },
    { verdict: "superseded", message: "credentials changed" },
  ] as const)("clears an authority adopted while the expiry answer was pending (verdict $verdict)",
    async ({ verdict, message }) => {
      const answer = Promise.withResolvers<ExpiryVerdict>();
      const noteCredentialsExpired = vi.fn((_identity: string) => answer.promise);
      const instance = new CredentialSource<Creds>({
        account: () => ({
          getCredentials: async () => ({ creds: live, identity: "id-a", generation: "gen-a" }),
          noteCredentialsExpired,
        }),
        isAuthError: error => error instanceof Error && error.message === "401",
        expiredMessage: "Reconnect the account.",
      });

      const report = instance.run(async () => { throw new Error("401"); });
      await vi.waitFor(() => expect(noteCredentialsExpired).toHaveBeenCalled());

      // A read landing mid-adjudication re-adopts the grant the account still serves; the
      // verdict-time drop clears it, so the adoption cannot outlive the answer either way.
      await instance.get();
      expect(instance.authority()).toBe("gen-a");

      answer.resolve(verdict);
      await expect(report).rejects.toThrow(message);
      expect(instance.authority()).toBeUndefined();
    });

  it("stops vouching for a rejected authority while the verdict is pending", async () => {
    const answer = Promise.withResolvers<ExpiryVerdict>();
    const noteCredentialsExpired = vi.fn((_identity: string) => answer.promise);
    const { instance } = source({
      account: () => ({
        getCredentials: async () => ({ creds: live, identity: "id-a", generation: "gen-a" }),
        noteCredentialsExpired,
      }),
    });

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // The rejection alone drops the authority: cache-first readers bypass during the round trip
    // rather than serving the partition the provider just rejected.
    const report = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(noteCredentialsExpired).toHaveBeenCalled());
    expect(instance.authority()).toBeUndefined();

    answer.resolve("accepted");
    await expect(report).rejects.toThrow("Reconnect the account.");
  });

  it("reports a rejection served by a fenced read once the authority is unknown", async () => {
    const reads: Array<(value: CredentialsWithIdentity<Creds>) => void> = [];
    const answer = Promise.withResolvers<ExpiryVerdict>();
    const noteCredentialsExpired = vi.fn(async (identity: string) =>
      identity === "id-a" ? answer.promise : "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: vi.fn(() =>
          new Promise<CredentialsWithIdentity<Creds>>(resolve => { reads.push(resolve); })),
        noteCredentialsExpired,
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const first = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0]({ creds: live, identity: "id-a", generation: "gen-a" });
    await vi.waitFor(() => expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a"));

    // A second run's read starts before the refusal lands, so its result arrives fenced: served
    // to the caller, never adopted.
    const second = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    answer.resolve("superseded");
    await expect(first).rejects.toThrow("credentials changed");
    reads[1]({ creds: fresh, identity: "id-b", generation: "gen-b" });

    // The retained id-a identity is no successor once its authority dropped — the failure under
    // the account's actual current credential must reach the account, not resolve as stale.
    await expect(second).rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenLastCalledWith("id-b");
  });

  it("fences a reconnect-crossing refresh even when the authority is already unknown", async () => {
    const reads: Array<(value: CredentialsWithIdentity<Creds>) => void> = [];
    const refreshGate = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const refreshCredentials = vi.fn(() => refreshGate.promise);
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: vi.fn(() =>
          new Promise<CredentialsWithIdentity<Creds>>(resolve => { reads.push(resolve); })),
        noteCredentialsExpired: async () => "superseded" as const,
      }),
      refreshCredentials,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const replay = instance.run(async () => { throw new Error("401"); }, { replayable: true });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0]({ creds: live, identity: "id-a", generation: "gen-a" });
    await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalled());

    // A refused report drops the authority to unknown while the refresh is still minting.
    const refused = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]({ creds: live, identity: "id-a", generation: "gen-a" });
    await expect(refused).rejects.toThrow("credentials changed");
    expect(instance.authority()).toBeUndefined();

    // A read started after the refusal can still resolve pre-reconnect account state.
    const straggler = instance.get();
    await vi.waitFor(() => expect(reads).toHaveLength(3));

    // The crossing must fence again, or that straggler restores the gen-a partition.
    refreshGate.resolve({ creds: fresh, identity: "id-b", generation: "gen-b" });
    await expect(replay).rejects.toThrow("credentials changed");
    reads[2]({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await straggler).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });

  it("skips the refresh when a reconnect was adopted before the rejection resolved", async () => {
    const reads = [
      { creds: live, identity: "id-a", generation: "gen-a" },
      { creds: fresh, identity: "id-b", generation: "gen-b" },
    ];
    const refreshCredentials = vi.fn(async () => reads[1]);
    const { instance } = source({
      account: () => ({
        getCredentials: async () => reads.shift()!,
        noteCredentialsExpired: async () => "accepted" as const,
      }),
      refreshCredentials,
    });

    const stalled = await stalledRun(instance, { replayable: true });

    // A plain read adopts a reconnect while the operation is still in flight.
    expect(await instance.get()).toEqual(fresh);
    expect(instance.authority()).toBe("gen-b");

    // The outcome is already decided: no mint is spent on the superseded read, and a refresh
    // failure or stall cannot reach a caller who only needs to re-enter.
    stalled.release();
    await expect(stalled.run).rejects.toThrow("credentials changed");
    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-b");
  });

  it("passes a replay failure that is not a credential rejection through untouched", async () => {
    const { instance, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));

    await expect(instance.run(async creds => {
      throw new Error(creds.token === "live" ? "401" : "500");
    }, { replayable: true })).rejects.toThrow("500");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("treats a replay failure under superseded credentials as stale, not expiry", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "superseded" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials: async () => ({ creds: fresh, identity: "id-b", generation: "gen-a" }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    await expect(instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      // A reconnect lands and another caller refetches while the replay is out.
      current = { creds: live, identity: "id-c", generation: "gen-c" };
      await instance.get();
      throw new Error("401");
    }, { replayable: true })).rejects.toThrow("credentials changed during the operation");

    // The mint the replay used was superseded by the adopted reconnect: the account's only
    // possible verdict is already known, so no ask is spent and the live authority stands.
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-c");
  });

  it("coalesces concurrent replays of one rejected read", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, refreshCredentials } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));
    const operation = async (creds: Creds) => {
      if (creds.token === "live") {
        await gate.promise;
        throw new Error("401");
      }
      return creds.token;
    };

    // Two provider calls 401 together, the way one dead bearer fails parallel calls in a request.
    const calls = [
      instance.run(operation, { replayable: true }),
      instance.run(operation, { replayable: true }),
    ];
    gate.resolve();

    expect(await Promise.all(calls)).toEqual(["fresh", "fresh"]);
    expect(refreshCredentials).toHaveBeenCalledOnce();
  });

  it("recovers both concurrent rejections when the refresh rotates the grant", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, refreshCredentials, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-b", generation: "gen-a" }));
    const operation = async (creds: Creds) => {
      if (creds.token === "live") {
        await gate.promise;
        throw new Error("401");
      }
      return creds.token;
    };

    const calls = [
      instance.run(operation, { replayable: true }),
      instance.run(operation, { replayable: true }),
    ];
    gate.resolve();

    // The sibling's rejection is of the read the refresh replaced; it must ride the same replay,
    // not die as "changed" while the recovery it needs has already happened.
    expect(await Promise.all(calls)).toEqual(["fresh", "fresh"]);
    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("refreshes distinct rejected reads separately, each conveying its own credentials", async () => {
    const bearers = [
      { token: "bearer-1", expiresAt: live.expiresAt },
      { token: "bearer-2", expiresAt: live.expiresAt },
    ];
    let reads = 0;
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const refreshCredentials = vi.fn(async (rejected: CredentialsWithIdentity<Creds>) => ({
      creds: { token: `minted-${rejected.creds.token}`, expiresAt: live.expiresAt },
      identity: "id-a",
      generation: "gen-a",
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials:
          async () => ({ creds: bearers[reads++]!, identity: "id-a", generation: "gen-a" }),
        noteCredentialsExpired,
      }),
      refreshCredentials,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const gate = Promise.withResolvers<void>();
    const firstAttempt = Promise.withResolvers<void>();
    const operation = async (creds: Creds) => {
      if (creds.token.startsWith("bearer-")) {
        if (creds.token === "bearer-1") firstAttempt.resolve();
        await gate.promise;
        throw new Error("401");
      }
      return creds.token;
    };

    // Sequential starts read distinct bearers under one grant identity; both then 401 together.
    const first = instance.run(operation, { replayable: true });
    await firstAttempt.promise;
    const second = instance.run(operation, { replayable: true });
    gate.resolve();

    // An identity-keyed refresh would coalesce these, replaying to one caller the very
    // credentials the other already saw rejected — and expiring a still-refreshable grant.
    expect(await Promise.all([first, second])).toEqual(["minted-bearer-1", "minted-bearer-2"]);
    expect(refreshCredentials).toHaveBeenCalledTimes(2);
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("a read opened before the refresh cannot overwrite the replayed grant", async () => {
    const reads: Array<(read: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      reads.push(resolve);
    }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const refreshGate = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      refreshCredentials: () => refreshGate.promise,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const replaying = Promise.withResolvers<void>();
    const replayGate = Promise.withResolvers<void>();
    const call = instance.run(async creds => {
      if (creds.token === "live") {
        firstAttempt.resolve();
        throw new Error("401");
      }
      replaying.resolve();
      await replayGate.promise;
      throw new Error("401");
    }, { replayable: true });
    reads[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    await firstAttempt.promise;

    // Another caller's read opens before the refresh lands and resolves while the replay is out.
    const straggler = instance.get();
    refreshGate.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await replaying.promise;
    reads[1]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await straggler).toEqual(live);

    // The pre-refresh read must not overwrite the successor: the replay's rejection is the
    // freshest evidence, so it reports rather than dying as "changed".
    replayGate.resolve();
    await expect(call).rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledOnce();
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
  });

  it("never replays under a grant already reported dead", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, refreshCredentials, noteCredentialsExpired } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));

    // Two calls share one read; the slower one's rejection lands after the grant was refreshed,
    // re-rejected, and reported dead.
    const slowOp = vi.fn(async () => {
      await gate.promise;
      throw new Error("401");
    });
    const fast = instance.run(async () => { throw new Error("401"); }, { replayable: true });
    const slow = instance.run(slowOp, { replayable: true });
    await expect(fast).rejects.toThrow("Reconnect the account.");

    gate.resolve();
    await expect(slow).rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");
    // No second mint and no provider call under credentials the source confirmed dead.
    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(slowOp).toHaveBeenCalledOnce();
  });

  it("leaves the refresh channel uncalled for a first failure that is not a rejection", async () => {
    const { instance, refreshCredentials } = replayableSource(
      async () => ({ creds: fresh, identity: "id-a", generation: "gen-a" }));

    await expect(instance.run(async () => { throw new Error("500"); }, { replayable: true }))
      .rejects.toThrow("500");
    expect(refreshCredentials).not.toHaveBeenCalled();
  });

  it("skips the ask for a replay rejection after an adopted reconnect", async () => {
    const reads: Array<(read: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      reads.push(resolve);
    }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "superseded" as const);
    const refreshGate = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      refreshCredentials: () => refreshGate.promise,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const replaying = Promise.withResolvers<void>();
    const replayGate = Promise.withResolvers<void>();
    const call = instance.run(async creds => {
      if (creds.token === "live") {
        firstAttempt.resolve();
        throw new Error("401");
      }
      replaying.resolve();
      await replayGate.promise;
      throw new Error("401");
    }, { replayable: true });
    reads[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    await firstAttempt.promise;

    // A concurrent read resolves a reconnect mid-replay: plain reads are the snapshot's only
    // writer, so the mint never fenced it and it adopts normally.
    const straggler = instance.get();
    refreshGate.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await replaying.promise;
    reads[1]?.({ creds: live, identity: "id-c", generation: "gen-b" });
    expect(await straggler).toEqual(live);
    expect(instance.authority()).toBe("gen-b");

    // The replay's rejection concerns a mint the reconnect superseded: the only verdict the
    // account could return is already known, so the caller re-enters without an ask and the
    // reconnect's live authority stands.
    replayGate.resolve();
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-b");
  });

  it("stands down a refresh overtaken by a reconnect adoption", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials: () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      firstAttempt.resolve();
      throw new Error("401");
    }, { replayable: true });
    await firstAttempt.promise;
    await refreshStarted.promise;

    // A reconnect lands and another caller adopts it while the refresh is out.
    current = { creds: live, identity: "id-c", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);
    expect(instance.authority()).toBe("gen-b");

    // The late result belongs to the replaced connection: adopting it would put the cache back on
    // the dead partition, and replaying it would act as the old principal.
    refreshGate.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(instance.authority()).toBe("gen-b");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("keeps a reconnect's authority when an overtaken refresh confirms expiry", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<never>();
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials: () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      firstAttempt.resolve();
      throw new Error("401");
    }, { replayable: true });
    await firstAttempt.promise;
    await refreshStarted.promise;

    current = { creds: live, identity: "id-c", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);

    // The expiry belongs to the replaced grant's lineage; the live successor decides now, so the
    // caller re-enters instead of seeing an expiry the reconnect already answered.
    refreshGate.reject(new CredentialsExpiredError("invalid_grant"));
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(instance.authority()).toBe("gen-b");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("treats a refresh failure overtaken by a reconnect as superseded, not infrastructure", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<never>();
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials: () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      firstAttempt.resolve();
      throw new Error("401");
    }, { replayable: true });
    await firstAttempt.promise;
    await refreshStarted.promise;

    current = { creds: live, identity: "id-c", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);

    // The mint was for a grant the reconnect replaced; its infrastructure trouble is not this
    // caller's outcome — the retry reads fresh and surfaces any real outage itself.
    refreshGate.reject(new Error("mint transport lost"));
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(instance.authority()).toBe("gen-b");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("keeps a reconnect's authority when a delayed refresh returns a dead mint", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const secondRefresh = Promise.withResolvers<void>();
    const lateRefresh = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    let mints = 0;
    const refreshCredentials = (): Promise<CredentialsWithIdentity<Creds>> => {
      mints += 1;
      if (mints === 1) {
        return Promise.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
      }
      secondRefresh.resolve();
      return lateRefresh.promise;
    };
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // A first run has the mint id-b adjudicated dead.
    await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");

    // A second run's refresh response is still in flight when a reconnect lands and is adopted.
    const call = instance.run(async () => { throw new Error("401"); }, { replayable: true });
    await secondRefresh.promise;
    current = { creds: live, identity: "id-c", generation: "gen-c" };
    expect(await instance.get()).toEqual(live);
    expect(instance.authority()).toBe("gen-c");

    // The delayed response carries the dead mint, but the read it answers is superseded: the
    // dead shortcut must not adjudicate it against the live successor.
    lateRefresh.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(1);
    expect(instance.authority()).toBe("gen-c");
  });

  it("refuses a delayed mint from a generation another refresh saw crossed", async () => {
    const current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const crossing = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const delayed = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const firstMint = Promise.withResolvers<void>();
    const secondMint = Promise.withResolvers<void>();
    let mints = 0;
    const refreshCredentials = (): Promise<CredentialsWithIdentity<Creds>> => {
      mints += 1;
      if (mints === 1) {
        firstMint.resolve();
        return crossing.promise;
      }
      secondMint.resolve();
      return delayed.promise;
    };
    const { instance } = source({
      // Fresh read objects, so the sequential runs hold distinct reads with distinct flights.
      account: () => ({ getCredentials: async () => ({ ...current }), noteCredentialsExpired }),
      refreshCredentials,
    });

    const operation = vi.fn(async () => { throw new Error("401"); });
    const one = instance.run(operation, { replayable: true });
    await firstMint.promise;
    const two = instance.run(operation, { replayable: true });
    await secondMint.promise;

    // The first refresh observes the reconnect's crossing: gen-a is now proven superseded.
    crossing.resolve({ creds: fresh, identity: "id-b", generation: "gen-b" });
    await expect(one).rejects.toThrow("credentials changed during the operation");

    // The second read's mint ran before the reconnect and its response arrives after the crossing
    // was observed: it must never be replayed, even with the authority already unknown.
    delayed.resolve({ creds: fresh, identity: "id-c", generation: "gen-a" });
    await expect(two).rejects.toThrow("credentials changed during the operation");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("records a crossing carried by a dead mint instead of adjudicating past it", async () => {
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    let mints = 0;
    const refreshCredentials = vi.fn(async (): Promise<CredentialsWithIdentity<Creds>> => {
      mints += 1;
      return { creds: fresh, identity: "id-b", generation: mints === 1 ? "gen-a" : "gen-b" };
    });
    const { instance } = source({
      account: () => ({
        getCredentials: async () => ({ creds: live, identity: "id-a", generation: "gen-a" }),
        noteCredentialsExpired,
      }),
      refreshCredentials,
    });

    // Two runs hold distinct gen-a reads whose operations stall.
    const one = await stalledRun(instance, { replayable: true });
    const two = await stalledRun(instance, { replayable: true });

    // A third run's rotated mint (id-b) is replayed and adjudicated dead, clearing the authority
    // with no crossing observed by any adoption.
    await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
      .rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
    expect(instance.authority()).toBeUndefined();

    // The first stalled run's mint is that dead identity on a newer generation: the crossing is
    // recorded and the read refused — never adjudicated against the dead set.
    one.release();
    await expect(one.run).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(1);

    // The recorded crossing refuses the second gen-a read before it can spend the channel.
    two.release();
    await expect(two.run).rejects.toThrow("credentials changed during the operation");
    expect(refreshCredentials).toHaveBeenCalledTimes(2);
  });

  it("records a crossing observed by a plain read, surviving a later authority clear", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const refreshCredentials = vi.fn(
      async () => ({ creds: fresh, identity: "id-d", generation: "gen-a" }));
    const { instance } = source({
      account: () => ({ getCredentials: async () => ({ ...current }), noteCredentialsExpired }),
      refreshCredentials,
    });

    const stalled = await stalledRun(instance, { replayable: true });

    // A plain read adopts the reconnect — the crossing evidence — before the new grant itself
    // dies and clears the authority.
    current = { creds: live, identity: "id-c", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();

    // The stalled gen-a read is refused on the recorded crossing without spending the channel.
    stalled.release();
    await expect(stalled.run).rejects.toThrow("credentials changed during the operation");
    expect(refreshCredentials).not.toHaveBeenCalled();
  });

  it("records the crossing when an adoption lands mid-refresh, for the next delayed mint", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (identity: string) =>
      identity === "id-a" ? ("superseded" as const) : ("accepted" as const));
    const mint = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const refreshCredentials = vi.fn(() => mint.promise);
    const { instance } = source({
      account: () => ({ getCredentials: async () => ({ ...current }), noteCredentialsExpired }),
      refreshCredentials,
    });

    // Two runs hold distinct gen-a reads; the first enters its refresh, the second stays stalled.
    const one = await stalledRun(instance, { replayable: true });
    const two = await stalledRun(instance, { replayable: true });
    one.release();
    await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalled());

    // A refused report clears the authority (no death) while the first run's mint is still out.
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("credentials changed during the operation");
    current = { creds: live, identity: "id-b", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);

    // The first run's mint resolves under the adopted reconnect: refused, with the crossing
    // recorded at the refusal itself as well as at the adoption.
    mint.resolve({ creds: fresh, identity: "id-c", generation: "gen-a" });
    await expect(one.run).rejects.toThrow("credentials changed during the operation");

    // The reconnect's grant dies and clears the authority; only the recorded crossing now proves
    // the second stalled gen-a read superseded, keeping its delayed mint unreplayed.
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();
    two.release();
    await expect(two.run).rejects.toThrow("credentials changed during the operation");
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("refuses a channelless rejection once its generation is seen crossed", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const { instance } = source({
      account: () => ({ getCredentials: async () => ({ ...current }), noteCredentialsExpired }),
    });

    const stalled = await stalledRun(instance);

    // A plain read adopts the reconnect — recording the crossing — before the new grant itself
    // dies and clears the authority.
    current = { creds: live, identity: "id-b", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
    expect(instance.authority()).toBeUndefined();

    // The stalled gen-a read is provably superseded: resolved as retryable, never adjudicated —
    // an "accepted" verdict here would bury a stale identity in the dead set and prompt a
    // reconnect right after one succeeded.
    stalled.release();
    await expect(stalled.run).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(1);
  });

  it("records a crossing adopted from an unknown authority, refusing the delayed mint", async () => {
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    let verdict: ExpiryVerdict = "superseded";
    const noteCredentialsExpired = vi.fn(async (_identity: string) => verdict);
    const mint = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    const refreshCredentials = vi.fn(() => mint.promise);
    const { instance } = source({
      account: () => ({ getCredentials: async () => ({ ...current }), noteCredentialsExpired }),
      refreshCredentials,
    });

    const stalled = await stalledRun(instance, { replayable: true });
    stalled.release();
    await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalled());

    // A refused report clears the authority before any crossing is observed.
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("credentials changed");

    // The reconnect is adopted from that unknown authority: the last-seen generation, which
    // survives the clear, is what records the crossing.
    current = { creds: live, identity: "id-b", generation: "gen-b" };
    expect(await instance.get()).toEqual(live);

    // The new grant dies too, clearing the authority again.
    verdict = "accepted";
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");

    // The delayed gen-a mint arrives under two clears straddling the reconnect: refused, never
    // replayed under the pre-reconnect principal.
    mint.resolve({ creds: fresh, identity: "id-a2", generation: "gen-a" });
    await expect(stalled.run).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(2);
  });

  it("resolves a replay the account refuses as superseded into a retry", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
    let current = { creds: live, identity: "id-a", generation: "gen-a" };
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "superseded" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials: async () => current, noteCredentialsExpired }),
      refreshCredentials: () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      firstAttempt.resolve();
      throw new Error("401");
    }, { replayable: true });
    await firstAttempt.promise;
    await refreshStarted.promise;

    // Another minting path — a sibling source over the same account — rotates the identity
    // within the generation while the refresh is out; this snapshot cannot order the two mints.
    current = { creds: fresh, identity: "id-x", generation: "gen-a" };
    expect(await instance.get()).toEqual(fresh);

    // The stale mint replays and is rejected; the account, which can order them, refuses the
    // report — the caller retries, and the authority bypasses until the next read.
    refreshGate.resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await expect(call).rejects.toThrow("credentials changed during the operation");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
    expect(instance.authority()).toBeUndefined();
  });

  it("never lets a fenced read opened after a report restore authority", async () => {
    const reads: Array<(read: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      reads.push(resolve);
    }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const gate = Promise.withResolvers<void>();
    const fast = instance.run(async () => { throw new Error("401"); });
    const slow = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    });
    reads[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    await expect(fast).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();

    // A read opens while the authority is unknown, and a second report fences it in flight.
    const pending = instance.get();
    gate.resolve();
    await expect(slow).rejects.toThrow("Reconnect the account.");

    // Resolving now must not restore authority: this is a fenced response, not a fetch started
    // after the report — however its generation compares to the unknown one it opened under.
    reads[1]?.({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await pending).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });

  it("fences a refresh-confirmed expiry against a read still in flight", async () => {
    const reads: Array<(read: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      reads.push(resolve);
    }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      refreshCredentials: async () => { throw new CredentialsExpiredError("invalid_grant"); },
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const firstAttempt = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      firstAttempt.resolve();
      throw new Error("401");
    }, { replayable: true });
    reads[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    await firstAttempt.promise;
    const straggler = instance.get();

    await expect(call).rejects.toThrow("invalid_grant");
    expect(instance.authority()).toBeUndefined();

    // The dead grant's pending read resolving must not restore its cache authority.
    reads[1]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await straggler).toEqual(live);
    expect(instance.authority()).toBeUndefined();
    // The account confirmed the expiry itself; there is nothing to report back.
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("treats an auth failure under superseded credentials as stale, not expiry", async () => {
    let identity = "id-a";
    let generation = "gen-a";
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: async () => ({ creds: live, identity, generation }),
        noteCredentialsExpired,
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    await expect(instance.run(async () => {
      // A reconnect lands and another caller refetches while this call is in flight.
      identity = "id-b";
      generation = "gen-b";
      await instance.get();
      throw new Error("401");
    })).rejects.toThrow("credentials changed during the operation");

    // Reporting would expire the grant the user just reconnected, and clearing the authority
    // would drop its live partition; both belong to the grant that actually died.
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-b");
  });

  it("keeps the reconnect message when reporting expiry fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { instance } = source({
        account: () => ({
          getCredentials: async () => ({ creds: live, identity: "id-a", generation: "gen-a" }),
          noteCredentialsExpired: async () => { throw new Error("account unreachable"); },
        }),
      });

      await expect(instance.run(async () => { throw new Error("401"); }))
        .rejects.toThrow("Reconnect the account.");
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("passes other failures through untouched", async () => {
    const { instance, noteCredentialsExpired } = source();

    await expect(instance.run(async () => { throw new Error("500"); })).rejects.toThrow("500");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("never hands a caller the fetch in flight when credentials were reported dead", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => "accepted" as const }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Two provider calls share one fetch, the way parallel calls in one gadget request do.
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const firstCall = instance.run(async () => {
      await first.promise;
      throw new Error("401");
    });
    const secondCall = instance.run(async () => {
      await second.promise;
      throw new Error("401");
    });
    fetches[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });

    // The first 401 empties the cache, so the next caller opens a second fetch...
    second.resolve();
    await expect(secondCall).rejects.toThrow("Reconnect the account.");
    const riding = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);

    // ...which is still in flight when the second 401 declares those credentials dead.
    first.resolve();
    await expect(firstCall).rejects.toThrow("Reconnect the account.");

    // Riding it would hand a caller credentials that have already been reported expired.
    const after = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(3);

    const fromSecond = { token: "second-fetch", expiresAt: live.expiresAt };
    const fromThird = { token: "third-fetch", expiresAt: live.expiresAt };
    fetches[1]?.({ creds: fromSecond, identity: "id-b", generation: "gen-a" });
    fetches[2]?.({ creds: fromThird, identity: "id-c", generation: "gen-a" });
    expect(await riding).toEqual(fromSecond);
    expect(await after).toEqual(fromThird);
  });

  it("never resurrects a generation cleared while another fetch was in flight", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => "accepted" as const }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    const gate = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    });
    fetches[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);

    // Another caller's fetch opens while the provider call is out, and is still in flight when the
    // 401 clears the generation.
    const pending = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(call).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();

    // That fetch resolving carries the dead grant's generation; adopting it would put the cache
    // back on the dead partition.
    fetches[1]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await pending).toEqual(live);
    expect(instance.authority()).toBeUndefined();

    // A fetch opened after the clear re-establishes the principal.
    const after = instance.get();
    fetches[2]?.({ creds: live, identity: "id-b", generation: "gen-b" });
    expect(await after).toEqual(live);
    expect(instance.authority()).toBe("gen-b");
  });

  it("drops the authority only when a fetch fails with confirmed expiry", async () => {
    let failure: Error | undefined;
    const instance = new CredentialSource<Creds>({
      account: () => ({
        getCredentials: async () => {
          if (failure) throw failure;
          return { creds: live, identity: "id-a", generation: "gen-a" };
        },
        noteCredentialsExpired: async () => "accepted" as const,
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // An account hiccup is not an expiry: the partition survives and warm reads keep hitting.
    failure = new Error("account unreachable");
    await expect(instance.get()).rejects.toThrow("account unreachable");
    expect(instance.authority()).toBe("gen-a");

    // A failed refresh is a confirmed expiry. RPC strips the class, so the name is the contract.
    failure = Object.assign(new Error("Reconnect the account."),
      { name: "CredentialsExpiredError" });
    await expect(instance.get()).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();
  });

  it("ignores a straggler fetch that rejects with expiry after the partition revived", async () => {
    const fetches: Array<PromiseWithResolvers<CredentialsWithIdentity<Creds>>> = [];
    const getCredentials = vi.fn(() => {
      const fetch = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
      fetches.push(fetch);
      return fetch.promise;
    });
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => "accepted" as const }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Grant A is adopted, another fetch opens, then A's expiry forgets that fetch mid-flight.
    const gate = Promise.withResolvers<void>();
    const call = instance.run(async () => { await gate.promise; throw new Error("401"); });
    fetches[0]?.resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const straggler = instance.get();
    gate.resolve();
    await expect(call).rejects.toThrow("Reconnect the account.");

    // A successful refresh commits a new identity on the same connection: the partition revives.
    const revived = instance.get();
    fetches[2]?.resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await revived).toEqual(live);
    expect(instance.authority()).toBe("gen-a");

    // The forgotten fetch's stale coalesced refresh finally fails; it must not clear the revival.
    fetches[1]?.reject(
      Object.assign(new Error("Reconnect the account."), { name: "CredentialsExpiredError" }));
    await expect(straggler).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBe("gen-a");
  });

  it("never adopts a straggler fetch that outlived later expiry reports", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => "accepted" as const }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Grant A is adopted, another fetch opens, then A's expiry forgets that fetch mid-flight.
    const gate = Promise.withResolvers<void>();
    const callA = instance.run(async () => { await gate.promise; throw new Error("401"); });
    fetches[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const straggler = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(callA).rejects.toThrow("Reconnect the account.");

    // Grant B is adopted and dies too, rotating the dead marker away from A.
    const callB = instance.run(async () => { throw new Error("401"); });
    fetches[2]?.({ creds: live, identity: "id-b", generation: "gen-b" });
    await expect(callB).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();

    // The straggler resolves with A, which no longer matches the marker. Adopting it would
    // resurrect a dead partition and misroute genuine B failures as superseded.
    fetches[1]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await straggler).toEqual(live);
    expect(instance.authority()).toBeUndefined();

    // A failure under the still-current dead grant routes to expiry, not "retry".
    const callC = instance.run(async () => { throw new Error("401"); });
    fetches[3]?.({ creds: live, identity: "id-b", generation: "gen-b" });
    await expect(callC).rejects.toThrow("Reconnect the account.");
    expect(instance.authority()).toBeUndefined();
  });

  it("reports a failure under fenced-out credentials as expiry when nothing live succeeded them", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => "accepted" as const);
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Grant A is adopted, a concurrent operation's fetch opens, then A's expiry fences it out.
    const gate = Promise.withResolvers<void>();
    const callA = instance.run(async () => { await gate.promise; throw new Error("401"); });
    fetches[0]?.({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const callB = instance.run(async () => { throw new Error("401"); });
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(callA).rejects.toThrow("Reconnect the account.");

    // The fenced-out fetch delivers B, which fails too. Nothing live was adopted since A's
    // report, so "the credentials changed" would be a lie — B's death is fresh evidence.
    fetches[1]?.({ creds: live, identity: "id-b", generation: "gen-a" });
    await expect(callB).rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-b");
    expect(instance.authority()).toBeUndefined();

    // The account keeps serving the unrefreshed grant; readopting it would let cache hits mask
    // the expiry it just confirmed.
    const refetch = instance.get();
    fetches[2]?.({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await refetch).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });

  it("keeps a dead grant refused however many stale failures report after it", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => "accepted" as const }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Nine operations park holding distinct stale identities, read one at a time so nothing
    // coalesces.
    const gates = Array.from({ length: 9 }, () => Promise.withResolvers<void>());
    const stale: Promise<unknown>[] = [];
    for (const [index, gate] of gates.entries()) {
      const reading = Promise.withResolvers<void>();
      stale.push(instance.run(async () => {
        reading.resolve();
        await gate.promise;
        throw new Error("401");
      }));
      fetches[index]?.({ creds: live, identity: `id-stale-${index}`, generation: "gen-a" });
      await reading.promise;
    }

    // Grant B — a same-generation rotation, so no crossing proves the stale reads superseded —
    // is adopted and dies, then every stale operation reports its own identity dead.
    const callB = instance.run(async () => { throw new Error("401"); });
    fetches[9]?.({ creds: live, identity: "id-b", generation: "gen-a" });
    await expect(callB).rejects.toThrow("Reconnect the account.");
    for (const gate of gates) gate.resolve();
    for (const failure of stale) await expect(failure).rejects.toThrow("Reconnect the account.");

    // The stale reports land after B's in mark order; none may push B back into adoption.
    const refetch = instance.get();
    fetches[10]?.({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await refetch).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });
});
