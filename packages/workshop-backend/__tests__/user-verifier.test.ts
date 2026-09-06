import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUserWithAccount(vendorId: string) {
  const verifier = {} as Fetcher<GatekeeperUserVerifier>;
  let verifierRequests = 0;
  const account = {
    async getVerifier() {
      verifierRequests++;
      return verifier;
    },
  } as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {
      BLUEPRINTS: {
        get: async () => null,
      },
    },
    storage: {
      connectedAccounts: {
        get: (accountId: number) => accountId === 7
          ? { id: accountId, account, vendorId }
          : undefined,
      },
    },
  });
  return { user, verifier, verifierRequests: () => verifierRequests };
}

describe("UserDurableObject.getVerifier", () => {
  it("returns a verifier when the connected account belongs to the expected vendor", async () => {
    const { user, verifier, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(7, "notion")).resolves.toBe(verifier);
    expect(verifierRequests()).toBe(1);
  });

  it("returns null when the account is missing", async () => {
    const { user, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(999, "notion")).resolves.toBeNull();
    expect(verifierRequests()).toBe(0);
  });

  it("throws when the connected account belongs to another vendor", async () => {
    const { user, verifierRequests } = makeUserWithAccount("linear");

    await expect(user.getVerifier(7, "notion")).rejects.toThrow(
        "Invalid account selection for this service.");
    expect(verifierRequests()).toBe(0);
  });

  it("disposes a verifier minted by an account that was replaced in flight", async () => {
    let disposeVerifier = vi.fn();
    let verifier = {[Symbol.dispose]: disposeVerifier} as Fetcher<GatekeeperUserVerifier>;
    let releaseVerifier!: () => void;
    let verifierEntered!: () => void;
    let entered = new Promise<void>(resolve => { verifierEntered = resolve; });
    let account = {
      async getVerifier() {
        verifierEntered();
        await new Promise<void>(resolve => { releaseVerifier = resolve; });
        return verifier;
      },
    } as Fetcher<GatekeeperUser>;
    let current: any = {id: 7, account, vendorId: "notion", accountGeneration: 0};
    let user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: {BLUEPRINTS: {get: async () => null}},
      storage: {connectedAccounts: {get: () => current}},
    });

    let pending = user.getVerifier(7, "notion");
    await entered;
    current = {id: 7, account: {}, vendorId: "notion", accountGeneration: 1};
    releaseVerifier();

    await expect(pending).rejects.toThrow(/account changed/);
    expect(disposeVerifier).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping authority KV reads without caching settled policy", async () => {
    let releaseConfig!: () => void;
    let reads = 0;
    let firstRead = new Promise<string | null>(resolve => { releaseConfig = () => resolve(null); });
    let verifier = {} as Fetcher<GatekeeperUserVerifier>;
    let account = {getVerifier: async () => verifier} as Fetcher<GatekeeperUser>;
    let record = {id: 7, account, vendorId: "notion"};
    let user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: {BLUEPRINTS: {get: async () => {
        reads++;
        if (reads === 1) return firstRead;
        return null;
      }}},
      storage: {connectedAccounts: {get: () => record}},
    });

    let first = user.getVerifier(7, "notion");
    let second = user.getVerifier(7, "notion");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    releaseConfig();
    await Promise.all([first, second]);
    // The final post-mint checks overlap too, but a later operation would start a fresh read.
    expect(reads).toBe(2);
    await user.getVerifier(7, "notion");
    expect(reads).toBe(4);
  });
});
