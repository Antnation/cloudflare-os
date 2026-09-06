import { describe, expect, it, vi } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import {RpcTarget} from "capnweb";
import { DEFAULT_ADMIN_CONFIG, gatekeeperAvailabilityBlock, parseAdminConfig, serializeAdminConfig } from "../src/admin-config.js";
import { OverseerDurableObject, overseerTestInternals } from "../src/overseer.js";
import {makeRevalidatingRpcStub} from "../src/revalidating-rpc.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

type OverseerImplForTest = InstanceType<typeof overseerTestInternals.OverseerImpl>;

// Consume native JsRpcPromise rejections exactly once: expect(...).rejects forks them. Workerd still
// prints its server-side "Uncaught (in promise)" diagnostic for a NativeRpcStub target that rejects,
// even though this caller receives the error and Vitest reports no unhandled error.
async function expectRejection(call: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  expect(String(caught)).toMatch(pattern);
}

function makeOverseer(
    getConfig: () => Promise<string | null>,
    hook: { enabled: boolean; vendorId?: string; callback?: object } | null =
        { enabled: true, vendorId: "email" },
    legacyVendorId?: string,
    resourceUrl = "https://example.com",
    typeUrlPattern = "https://*",
): OverseerDurableObject {
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  let gatekeeper = {
    resourceUrl,
    ...(legacyVendorId ? {
      creationSpec: {
        type: "gatekeeper" as const,
        vendorId: legacyVendorId,
        resourceUrl,
        typeUrlPattern,
      },
    } : {}),
  };
  Object.assign(overseer, {
    env: { BLUEPRINTS: { get: getConfig } },
    impl: {
      assertGatekeeperAvailable: async (_id: number, fallbackVendorId?: string) => {
        let config = parseAdminConfig(await getConfig());
        let block = gatekeeperAvailabilityBlock(
            config, gatekeeper.creationSpec, gatekeeper.resourceUrl, fallbackVendorId);
        if (block) throw new Error("Gatekeeper is disabled.");
      },
      storage: {
        boundHooks: { get: () => hook && ({ ...hook, gatekeeperId: 1 }) },
        gatekeepers: { get: () => gatekeeper },
      },
    },
  });
  return overseer;
}

describe("OverseerDurableObject.startHook", () => {
  it.each([
    ["ordinary", DEFAULT_ADMIN_CONFIG, "email"],
    ["ambient", {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "optional" as const },
    }, "scheduler"],
  ])("allows delivery for an enabled %s vendor", async (_kind, config, vendorId) => {
    let deliver = vi.fn(async (value: string) => `delivered:${value}`);
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config),
        { enabled: true, vendorId, callback: {deliver} });

    let {callback} = await overseer.startHook(1);
    await expect((callback as any).deliver("event")).resolves.toBe("delivered:event");
    expect(deliver).toHaveBeenCalledWith("event");
  });

  it("rejects delivery for an administratively disabled ordinary vendor", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(async () => serializeAdminConfig(config));

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery for an administratively disabled ambient vendor", async () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "disabled" as const },
    };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId: "scheduler" });

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("enforces vendor policy for legacy hooks without a denormalized vendor ID", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true }, "email");

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery for an administratively disabled resource", async () => {
    let pattern = "https://calendar.google.com/calendar/:calendarId/*";
    let config = {...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [pattern]}};
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config),
        {enabled: true, vendorId: "google"},
        "google",
        "https://calendar.google.com/calendar/team/events",
        pattern);

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery when admin-config KV access fails", async () => {
    let overseer = makeOverseer(async () => { throw new Error("KV unavailable"); });

    await expect(overseer.startHook(1)).rejects.toThrow("KV unavailable");
  });

  it("rejects delivery when the hook was disabled", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: false, vendorId: "email" });

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("rejects delivery when the hook was deleted", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), null);

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("revokes an already-issued firing callback when its resource is disabled", async () => {
    let config = DEFAULT_ADMIN_CONFIG;
    let deliver = vi.fn();
    let pattern = "https://calendar.google.com/calendar/:calendarId/*";
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config),
        {enabled: true, vendorId: "google", callback: {deliver}},
        "google", "https://calendar.google.com/calendar/team/events", pattern);
    let {callback} = await overseer.startHook(1);

    config = {...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [pattern]}};

    await expectRejection((callback as any).deliver("event"), /Gatekeeper is disabled/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("revokes an already-issued firing callback when its hook is disabled", async () => {
    let deliver = vi.fn();
    let hook = {enabled: true, vendorId: "email", callback: {deliver}};
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), hook);
    let {callback} = await overseer.startHook(1);

    hook.enabled = false;

    await expectRejection((callback as any).deliver("event"), /deleted or disabled/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("re-checks a hook record after the async policy read", async () => {
    let release!: (config: string) => void;
    let hook = {enabled: true, vendorId: "email", callback: {}};
    let overseer = makeOverseer(
        () => new Promise(resolve => { release = resolve; }), hook);

    let pending = overseer.startHook(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    hook.enabled = false;
    release(serializeAdminConfig(DEFAULT_ADMIN_CONFIG));

    await expect(pending).rejects.toThrow(/deleted or disabled/);
  });
});

describe("revalidating RPC membrane", () => {
  it("blocks an existing session before another provider call after policy changes", async () => {
    let enabled = true;
    let read = vi.fn(async () => "calendar data");
    let session = makeRevalidatingRpcStub(
        () => ({read}) as any,
        async () => {
          if (!enabled) throw new Error("Calendar is disabled.");
        });

    await expect((session as any).read()).resolves.toBe("calendar data");
    enabled = false;
    await expectRejection((session as any).read(), /Calendar is disabled/);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("disposes each dynamic legacy-hook entrypoint after its forwarded call", async () => {
    let disposeEntrypoint = vi.fn();
    class Entrypoint extends RpcTarget {
      ping() {
        return "pong";
      }

      [Symbol.dispose]() {
        disposeEntrypoint();
      }
    }
    let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
    Object.assign(overseer, {
      impl: {
        assertGatekeeperAvailable: async () => {},
        getGadgetHookEntrypoint: () => new Entrypoint(),
      },
    });

    using callback = await overseer.startGatekeeperHook(1);
    await expect((callback as any).ping()).resolves.toBe("pong");
    expect(disposeEntrypoint).toHaveBeenCalledTimes(1);
  });
});

describe("observation authority", () => {
  it("does not leave the sharing latch behind when policy changes during its sharing check",
      async () => {
    let releaseSharingCheck!: () => void;
    let policyEnabled = true;
    let putProhibitAllSharing = vi.fn();
    let impl = Object.create(
        overseerTestInternals.OverseerImpl.prototype) as OverseerImplForTest;
    Object.assign(impl, {
      assertGatekeeperAvailable: vi.fn(async () => {
        if (!policyEnabled) throw new Error("Calendar is disabled.");
      }),
      getSharingManager: async () => {
        await new Promise<void>(resolve => { releaseSharingCheck = resolve; });
        return {hasAnyShares: () => false};
      },
      storage: {
        prohibitAllSharing: {put: putProhibitAllSharing},
      },
    });

    let pending = impl.authorizeObservation(
        1,
        {
          title: "Calendar results",
          description: "Calendar results",
          prohibitAllSharing: true,
        },
        {from: "agent", chatId: 1});
    await new Promise(resolve => setTimeout(resolve, 0));
    policyEnabled = false;
    releaseSharingCheck();

    await expect(pending).rejects.toThrow(/Calendar is disabled/);
    expect(putProhibitAllSharing).not.toHaveBeenCalled();
  });

  it("coalesces only overlapping deployment-policy reads", async () => {
    let releaseConfig!: (value: string) => void;
    let reads = 0;
    let firstConfig = new Promise<string>(resolve => { releaseConfig = resolve; });
    let impl = Object.create(
        overseerTestInternals.OverseerImpl.prototype) as OverseerImplForTest;
    Object.assign(impl, {
      env: {BLUEPRINTS: {get: async () => {
        reads++;
        return reads === 1
          ? firstConfig
          : serializeAdminConfig(DEFAULT_ADMIN_CONFIG);
      }}},
      storage: {
        gatekeepers: {get: () => ({id: 1, resourceUrl: "https://example.com"})},
      },
    });

    let first = impl.assertGatekeeperAvailable(1, "email");
    let second = impl.assertGatekeeperAvailable(1, "email");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    releaseConfig(serializeAdminConfig(DEFAULT_ADMIN_CONFIG));
    await Promise.all([first, second]);

    await impl.assertGatekeeperAvailable(1, "email");
    expect(reads).toBe(2);
  });
});

describe("connection minting authority", () => {
  it("removes a new facet when its resource is disabled during provider description", async () => {
    let activeConfig = DEFAULT_ADMIN_CONFIG;
    let records = new Map<number, any>();
    let removeGatekeeper = vi.fn((id: number) => { records.delete(id); });
    let calendarPattern = "https://calendar.google.com/calendar/:calendarId/*";
    let impl = Object.create(
        overseerTestInternals.OverseerImpl.prototype) as OverseerImplForTest;
    Object.assign(impl, {
      env: {BLUEPRINTS: {get: async () => serializeAdminConfig(activeConfig)}},
      storage: {
        gatekeepers: {
          get: (id: number) => records.get(id),
          put: (record: {id: number}) => { records.set(record.id, record); },
        },
      },
      allocateWorkpieceId: () => 1,
      getGatekeeperFacet: () => ({
        describe: async () => {
          activeConfig = {
            ...DEFAULT_ADMIN_CONFIG,
            disabledResources: {google: [calendarPattern]},
          };
          return {
            title: "Google Calendar",
            url: "https://calendar.google.com/calendar/team/events",
          };
        },
      }),
      removeGatekeeper,
    });

    await expect(impl.addGatekeeper({} as any, {
      type: "gatekeeper",
      vendorId: "google",
      resourceUrl: "https://calendar.google.com/calendar/team/events",
      typeUrlPattern: calendarPattern,
    })).rejects.toThrow(/disabled/);
    expect(removeGatekeeper).toHaveBeenCalledWith(1);
    expect(records.has(1)).toBe(false);
  });

  it("quarantines a provenance-less retained facet under a whole-vendor disable", async () => {
    let impl = Object.create(
        overseerTestInternals.OverseerImpl.prototype) as OverseerImplForTest;
    Object.assign(impl, {
      env: {BLUEPRINTS: {get: async () => serializeAdminConfig({
        ...DEFAULT_ADMIN_CONFIG,
        disabledGatekeepers: ["google"],
      })}},
      storage: {
        gatekeepers: {get: () => ({
          id: 1,
          resourceUrl: "https://calendar.google.com/calendar/team/events",
        })},
      },
    });

    await expect(impl.assertGatekeeperAvailable(1)).rejects.toThrow(/disabled/);
  });
});

async function makeTargetOverseer(
    gadgetId?: number,
    assertGatekeeperAvailable: (gatekeeperId: number, vendorId?: string) => Promise<void> =
        async () => {}) {
  let controllerEnable = vi.fn(async (_initiator: object, _target: object) => {});
  let record = {
    id: 4,
    actionId: 12,
    gatekeeperId: 1,
    vendorId: "email",
    gadgetId,
    controller: {enable: controllerEnable},
    callback: {},
    description: {title: "Incoming email", description: "Receives email"},
    enabled: false,
  };
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId: "user-id",
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      assertGatekeeperAvailable,
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ({id: "profile-id", name: "Test User"}),
        }),
      },
      ctx: {
        id: {toString: () => "workspace-id"},
        exports: {GatekeeperHookLoopback: ({props}: {props: object}) => props},
      },
      storage: {
        prohibitAllSharing: {get: () => false},
        boundHooks: {get: () => record, put: vi.fn()},
        actions: {get: () => undefined, put: vi.fn()},
      },
    },
  } satisfies Pick<OverseerDurableObject, "open"> & {impl: object};
  let notifyClosed = new NativeRpcStub<() => void>(() => {});
  let client = await overseer.open("user-id", "profile-id", notifyClosed);
  return {client, controllerEnable};
}

describe("hook target", () => {

  it("passes the workspace and gadget IDs to enable()", async () => {
    let {client, controllerEnable} = await makeTargetOverseer(17);

    await client.enableHook(4);

    expect(controllerEnable).toHaveBeenCalledTimes(1);
    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id", gadgetId: 17});
  });

  it("omits the gadget ID for a hook that is not pinned to one", async () => {
    let {client, controllerEnable} = await makeTargetOverseer();

    await client.enableHook(4);

    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id"});
  });

  it("checks a legacy hook's vendor before invoking its controller", async () => {
    let assertGatekeeperAvailable = vi.fn(async (_id: number, vendorId?: string) => {
      expect(vendorId).toBe("email");
      throw new Error("Gatekeeper is disabled.");
    });
    let {client, controllerEnable} = await makeTargetOverseer(
        undefined, assertGatekeeperAvailable);

    await expect(client.enableHook(4)).rejects.toThrow(/Gatekeeper is disabled/);
    expect(controllerEnable).not.toHaveBeenCalled();
  });

});

describe("disabled connection recovery", () => {
  it("refuses a pending approval but leaves explicit rejection available", async () => {
    let action = {
      id: 7,
      gatekeeperId: 1,
      caller: {from: "agent" as const, chatId: 2},
      createdAt: new Date(),
      state: "pending" as const,
      type: "action" as const,
      action: 41,
      description: {title: "Create meeting", description: "Creates a calendar event"},
    };
    let applyPendingAction = vi.fn(async () => {
      throw new Error(
          "Google Calendar is disabled. This pending action cannot be approved while the " +
          "connection is disabled; deny it to discard the staged change.");
    });
    let rejectAction = vi.fn(async () => {});
    let putAction = vi.fn();
    let drainAutoApprovals = vi.fn(async () => {});
    let overseer = {
      open: OverseerDurableObject.prototype.open,
      impl: {
        ownerId: "user-id",
        ensureAmbientCapsules: async () => {},
        markOutputsDirty: () => {},
        joinPresence: () => () => {},
        joinOutputsFanout: () => () => {},
        users: {
          idFromString: (id: string) => id,
          get: () => ({whoami: async () => ({id: "profile-id", name: "Test User"})}),
        },
        ctx: {
          id: {toString: () => "workspace-id"},
          waitUntil: (promise: Promise<unknown>) => { void promise; },
          facets: {abort: vi.fn()},
        },
        storage: {
          prohibitAllSharing: {get: () => false},
          actions: {get: () => action, put: putAction},
        },
        applyPendingAction,
        assertGatekeeperAvailable: async () => {
          throw new Error("Google Calendar is disabled.");
        },
        getGatekeeperFacet: () => ({rejectAction}),
        drainAutoApprovals,
      },
    } satisfies Pick<OverseerDurableObject, "open"> & {impl: object};
    let notifyClosed = new NativeRpcStub<() => void>(() => {});
    let client = await overseer.open("user-id", "profile-id", notifyClosed);

    await expect(client.approveAction(7)).rejects.toThrow(/cannot be approved.*deny it/);
    expect(applyPendingAction).toHaveBeenCalledTimes(1);
    expect(action.state).toBe("pending");
    expect(rejectAction).not.toHaveBeenCalled();

    await expect(client.rejectAction(7)).resolves.toBeUndefined();
    expect(rejectAction).not.toHaveBeenCalled();
    expect(action.state).toBe("rejected");
    expect(putAction).toHaveBeenCalled();
    expect(drainAutoApprovals).not.toHaveBeenCalled();
  });
});
