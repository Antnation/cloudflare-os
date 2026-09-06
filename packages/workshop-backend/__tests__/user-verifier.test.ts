import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";
import {DEFAULT_ADMIN_CONFIG} from "../src/admin-config.js";

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
    adminSettings: {
      getByName: () => ({getAdminConfig: async () => DEFAULT_ADMIN_CONFIG}),
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
      adminSettings: {
        getByName: () => ({getAdminConfig: async () => DEFAULT_ADMIN_CONFIG}),
      },
      storage: {connectedAccounts: {get: () => current}},
    });

    let pending = user.getVerifier(7, "notion");
    await entered;
    current = {id: 7, account: {}, vendorId: "notion", accountGeneration: 1};
    releaseVerifier();

    await expect(pending).rejects.toThrow(/account changed/);
    expect(disposeVerifier).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce overlapping authoritative Durable Object reads", async () => {
    let releases: Array<() => void> = [];
    let getAdminConfig = vi.fn(() => new Promise<typeof DEFAULT_ADMIN_CONFIG>(resolve => {
      releases.push(() => resolve(DEFAULT_ADMIN_CONFIG));
    }));
    let user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      adminSettings: {getByName: () => ({getAdminConfig})},
    });

    let first = (user as any).readAuthorityConfig();
    let second = (user as any).readAuthorityConfig();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getAdminConfig).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach(release => release());
    await Promise.all([first, second]);

    let third = (user as any).readAuthorityConfig();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getAdminConfig).toHaveBeenCalledTimes(3);
    releases.splice(0).forEach(release => release());
    await third;
  });
});
