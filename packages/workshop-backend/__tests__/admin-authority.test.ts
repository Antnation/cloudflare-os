import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it, vi} from "vitest";
import {DEFAULT_ADMIN_CONFIG, readAdminConfigForAuthority} from "../src/admin-config.js";
import {AdminSettings} from "../src/admin-settings.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
  }
}

describe("authoritative admin policy", () => {
  it("commits a monotonic revision before waiting for the KV presentation mirror", async () => {
    let stub = env.TEST_ADMIN.getByName("policy-race-" + crypto.randomUUID());
    await runInDurableObject(stub, async (admin: AdminSettings) => {
      let mirrorEntered!: () => void;
      let rejectMirror!: (error: Error) => void;
      let entered = new Promise<void>(resolve => { mirrorEntered = resolve; });
      let mirror = vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectMirror = reject;
        mirrorEntered();
      }));
      Object.assign(admin, {env: {BLUEPRINTS: {put: mirror}}});

      let pending = admin.updateAdminConfig({signupsEnabled: false});
      await entered;
      let visibleDuringMirror = admin.getAdminConfig();
      expect(visibleDuringMirror.signupsEnabled).toBe(false);
      expect(visibleDuringMirror.revision).toBe(1);

      rejectMirror(new Error("simulated eventual mirror outage"));
      await expect(pending).resolves.toBeUndefined();
      expect(admin.getAdminConfig()).toMatchObject({signupsEnabled: false, revision: 1});
      expect(mirror).toHaveBeenCalledTimes(1);
    });
  });

  it("increments the authoritative revision for every serialized mutation", async () => {
    let stub = env.TEST_ADMIN.getByName("policy-revisions-" + crypto.randomUUID());
    await stub.updateAdminConfig({signupsEnabled: false});
    await stub.updateAdminConfig({signupsEnabled: true});
    await expect(stub.getAdminConfig()).resolves.toMatchObject({
      signupsEnabled: true,
      revision: 2,
    });
  });

  it("never coalesces concurrent positive-authority reads", async () => {
    let revision = 0;
    let getAdminConfig = vi.fn(async () => ({
      ...DEFAULT_ADMIN_CONFIG,
      revision: ++revision,
    }));
    let namespace = {
      getByName: () => ({getAdminConfig}),
    } as unknown as DurableObjectNamespace<AdminSettings>;

    let [first, second] = await Promise.all([
      readAdminConfigForAuthority(namespace),
      readAdminConfigForAuthority(namespace),
    ]);

    expect(getAdminConfig).toHaveBeenCalledTimes(2);
    expect([first.revision, second.revision]).toEqual([1, 2]);
  });
});
