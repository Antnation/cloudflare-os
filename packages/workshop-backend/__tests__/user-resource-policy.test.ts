import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {
  AdminConfig, DEFAULT_ADMIN_CONFIG, serializeAdminConfig,
} from "../src/admin-config.js";
import {ADMIN_CONFIG_KEY} from "../src/blueprint-archive.js";
import {UserDurableObject} from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const GMAIL_PATTERN = "https://mail.google.com/*";
const CALENDAR_PATTERN = "https://calendar.google.com/calendar/:calendarId/*";
const RESOURCES = [
  {urlPattern: GMAIL_PATTERN, title: "Gmail", description: "Mail", grantable: true},
  {
    urlPattern: CALENDAR_PATTERN,
    title: "Google Calendar",
    description: "Calendar",
    grantable: true,
  },
];

async function expectRejection(call: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  // Workerd logs a server-side diagnostic when a NativeRpcStub target rejects; consuming the
  // JsRpcPromise once keeps that expected denial from becoming a Vitest unhandled error as well.
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  expect(String(caught)).toMatch(pattern);
}

function makeUser() {
  let activeConfig: AdminConfig | string = {
    ...DEFAULT_ADMIN_CONFIG,
    disabledResources: {google: [CALENDAR_PATTERN]},
  };
  let connectAccount = vi.fn(async (_callback: unknown, _options?: unknown) =>
    ({url: "https://accounts.example/authorize"}));
  let ensureResources = vi.fn(async (_patterns: string[]) => ({}));
  let listCalendars = vi.fn(async () => ["team"]);
  let disposeConfiguratorUi = vi.fn();
  let configuratorFrame = {
    iframeHtml: "",
    ui: {listCalendars, [Symbol.dispose]: disposeConfiguratorUi},
  };
  let startResourceConfigurator = vi.fn(async (_pattern: string) => configuratorFrame);
  let listManagedItems = vi.fn(async () => ["item"]);
  let disposeAppUi = vi.fn();
  let appFrame = {
    iframeHtml: "",
    ui: {listManagedItems, [Symbol.dispose]: disposeAppUi},
  };
  let startAppUi = vi.fn(async (_context: {isAdmin: boolean}) => appFrame);
  let reconnect = vi.fn(async () => ({url: "https://accounts.example/reconnect"}));
  let describeAccount = vi.fn(async () => ({
    avatar: {url: "https://example.com/avatar.png"},
    grantedResourceUrlPatterns: [GMAIL_PATTERN, CALENDAR_PATTERN],
  }));
  let getAccountSupportedResources = vi.fn(async () => RESOURCES);
  let account = {
    getSupportedResources: getAccountSupportedResources,
    ensureResources,
    startResourceConfigurator,
    reconnect,
    describe: describeAccount,
    startAppUi,
  };
  let getVendorSupportedResources = vi.fn(async () => RESOURCES);
  let connectedRecord = {
    id: 3,
    vendorId: "google",
    account,
    description: {
      avatar: {url: "https://example.com/avatar.png"},
      grantedResourceUrlPatterns: [GMAIL_PATTERN, CALENDAR_PATTERN],
      providesUi: true,
    },
    credentialsExpired: false,
  };
  let currentRecord: typeof connectedRecord | Record<string, unknown> | undefined = connectedRecord;
  let putConnectedAccount = vi.fn();
  let deleteConnectedAccount = vi.fn();
  let user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {BLUEPRINTS: {get: async () => typeof activeConfig === "string"
      ? activeConfig
      : serializeAdminConfig(activeConfig)}},
    vendors: new Map([["google", {
      getSupportedResources: getVendorSupportedResources,
      connectAccount,
    }]]),
    storage: {
      profile: {get: () => ({id: "user@example.com"})},
      nextAccountId: {get: () => 4, put: vi.fn()},
      connectedAccounts: {
        get: () => currentRecord,
        put: putConnectedAccount,
        delete: deleteConnectedAccount,
      },
    },
    ctx: {
      id: {toString: () => "user-do-id"},
      exports: {GatekeeperConnectCallbackImpl: ({props}: {props: object}) => props},
    },
  });
  return {
    user,
    connectAccount,
    ensureResources,
    startResourceConfigurator,
    reconnect,
    describeAccount,
    putConnectedAccount,
    deleteConnectedAccount,
    connectedRecord,
    listCalendars,
    disposeConfiguratorUi,
    configuratorFrame,
    listManagedItems,
    disposeAppUi,
    startAppUi,
    getVendorSupportedResources,
    getAccountSupportedResources,
    setConfig(config: AdminConfig) {
      activeConfig = config;
    },
    setRawConfig(config: string) {
      activeConfig = config;
    },
    replaceConnectedRecord(record: Record<string, unknown> | undefined) {
      currentRecord = record;
    },
  };
}

describe("UserDurableObject resource policy", () => {
  it("narrows an omitted new-account grant to enabled resources", async () => {
    let {user, connectAccount} = makeUser();

    await expect(user.connectAccount("google")).resolves.toEqual({
      url: "https://accounts.example/authorize",
    });
    expect(connectAccount).toHaveBeenCalledTimes(1);
    expect(connectAccount.mock.calls[0][1]).toEqual({
      resourceUrlPatterns: [GMAIL_PATTERN],
    });
  });

  it("rejects a crafted request to grant a disabled resource", async () => {
    let {user, connectAccount} = makeUser();

    await expect(user.connectAccount("google", [CALENDAR_PATTERN])).rejects.toThrow(/disabled/);
    expect(connectAccount).not.toHaveBeenCalled();
  });

  it("re-checks policy after provider discovery before starting a new authorization", async () => {
    let {
      user, connectAccount, getVendorSupportedResources, setConfig,
    } = makeUser();
    let releaseCatalog!: () => void;
    let catalogEntered!: () => void;
    let entered = new Promise<void>(resolve => { catalogEntered = resolve; });
    getVendorSupportedResources.mockImplementationOnce(async () => {
      catalogEntered();
      await new Promise<void>(resolve => { releaseCatalog = resolve; });
      return RESOURCES;
    });

    let pending = user.connectAccount("google", [GMAIL_PATTERN]);
    await entered;
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [GMAIL_PATTERN]}});
    releaseCatalog();

    await expect(pending).rejects.toThrow(/disabled/);
    expect(connectAccount).not.toHaveBeenCalled();
  });

  it("does not return an authorization URL disabled while the provider minted it", async () => {
    let {user, connectAccount, setConfig} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    connectAccount.mockImplementationOnce(async () => {
      setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});
      return {url: "https://accounts.example/authorize"};
    });

    await expect(user.connectAccount("google")).rejects.toThrow(/disabled/);
    expect(connectAccount).toHaveBeenCalledTimes(1);
  });

  it("rejects disabled resource expansion and configurator entry", async () => {
    let {user, ensureResources, startResourceConfigurator} = makeUser();

    await expect(user.ensureAccountResources(3, [CALENDAR_PATTERN])).rejects.toThrow(/disabled/);
    expect(ensureResources).not.toHaveBeenCalled();
    await expect(user.startResourceConfigurator(3, CALENDAR_PATTERN)).rejects.toThrow(/disabled/);
    expect(startResourceConfigurator).not.toHaveBeenCalled();
  });

  it("re-checks policy after provider discovery before expanding a grant", async () => {
    let {
      user, ensureResources, getAccountSupportedResources, setConfig,
    } = makeUser();
    let releaseCatalog!: () => void;
    let catalogEntered!: () => void;
    let entered = new Promise<void>(resolve => { catalogEntered = resolve; });
    getAccountSupportedResources.mockImplementationOnce(async () => {
      catalogEntered();
      await new Promise<void>(resolve => { releaseCatalog = resolve; });
      return RESOURCES;
    });

    let pending = user.ensureAccountResources(3, [GMAIL_PATTERN]);
    await entered;
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [GMAIL_PATTERN]}});
    releaseCatalog();

    await expect(pending).rejects.toThrow(/disabled/);
    expect(ensureResources).not.toHaveBeenCalled();
  });

  it("refuses expansion when the provider would union in an already-disabled grant", async () => {
    let {user, ensureResources, getAccountSupportedResources} = makeUser();

    await expect(user.ensureAccountResources(3, [GMAIL_PATTERN]))
        .rejects.toThrow(/still grants a resource disabled/);
    expect(getAccountSupportedResources).toHaveBeenCalledTimes(1);
    expect(ensureResources).not.toHaveBeenCalled();
  });

  it("does not expand through an account capability replaced during provider discovery", async () => {
    let {
      user, ensureResources, getAccountSupportedResources, connectedRecord, setConfig,
      replaceConnectedRecord,
    } = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let releaseCatalog!: () => void;
    let catalogEntered!: () => void;
    let entered = new Promise<void>(resolve => { catalogEntered = resolve; });
    getAccountSupportedResources.mockImplementationOnce(async () => {
      catalogEntered();
      await new Promise<void>(resolve => { releaseCatalog = resolve; });
      return RESOURCES;
    });

    let pending = user.ensureAccountResources(3, [GMAIL_PATTERN]);
    await entered;
    replaceConnectedRecord({...connectedRecord, accountGeneration: 1, account: {}});
    releaseCatalog();

    await expect(pending).rejects.toThrow(/account changed/);
    expect(ensureResources).not.toHaveBeenCalled();
  });

  it("does not return an expansion flow disabled while the provider started it", async () => {
    let {user, ensureResources, setConfig} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    ensureResources.mockImplementationOnce(async () => {
      setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});
      return {url: "https://accounts.example/expand"};
    });

    await expect(user.ensureAccountResources(3, [CALENDAR_PATTERN])).rejects.toThrow(/disabled/);
    expect(ensureResources).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown resource configurator before forwarding it", async () => {
    let {user, startResourceConfigurator} = makeUser();

    await expect(user.startResourceConfigurator(3, "https://unknown.example/*"))
        .rejects.toThrow(/Unknown resource type/);
    expect(startResourceConfigurator).not.toHaveBeenCalled();
  });

  it("revokes an already-open resource configurator when policy changes", async () => {
    let {user, setConfig, listCalendars} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let frame = await user.startResourceConfigurator(3, CALENDAR_PATTERN);

    setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});

    await expectRejection((frame.ui as any).listCalendars(), /resource is disabled/);
    expect(listCalendars).not.toHaveBeenCalled();
  });

  it("disposes a configurator if policy changes while the provider starts it", async () => {
    let {
      user, setConfig, startResourceConfigurator, configuratorFrame, disposeConfiguratorUi,
    } = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    startResourceConfigurator.mockImplementationOnce(async () => {
      setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});
      return configuratorFrame;
    });

    await expect(user.startResourceConfigurator(3, CALENDAR_PATTERN))
        .rejects.toThrow(/resource is disabled/);
    expect(disposeConfiguratorUi).toHaveBeenCalledTimes(1);
  });

  it("revokes an already-open account app when its integration is disabled", async () => {
    let {user, setConfig, listManagedItems} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let frame = await user.startAccountAppUi(3, {isAdmin: false});

    setConfig({...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["google"]});

    await expectRejection((frame.ui as any).listManagedItems(), /Gatekeeper is disabled/);
    expect(listManagedItems).not.toHaveBeenCalled();
  });

  it("keeps account-level reconnect available for still-enabled services", async () => {
    let {user, reconnect} = makeUser();

    await expect(user.reconnectAccount(3)).resolves.toEqual({
      url: "https://accounts.example/reconnect",
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not return a reconnect URL when the vendor is disabled in flight", async () => {
    let {user, reconnect, setConfig} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    reconnect.mockImplementationOnce(async () => {
      setConfig({...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["google"]});
      return {url: "https://accounts.example/reconnect"};
    });

    await expect(user.reconnectAccount(3)).rejects.toThrow(/disabled/);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not restore a grant that gained a disabled resource while OAuth was open", async () => {
    let {user, connectedRecord, putConnectedAccount} = makeUser();

    await expect(user.markCredentialsRestored(3)).rejects.toThrow(/gained a resource disabled/);
    expect(connectedRecord.credentialsExpired).toBe(true);
    expect(putConnectedAccount).toHaveBeenCalledWith(connectedRecord);
  });

  it("rejects a completed disabled grant without another provider request", async () => {
    let {
      user, connectedRecord, getAccountSupportedResources, putConnectedAccount, setConfig,
    } = makeUser();
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});
    connectedRecord.description.grantedResourceUrlPatterns = [CALENDAR_PATTERN];

    await expect(user.putConnectedAccount(connectedRecord)).rejects.toThrow(/disabled/);
    expect(getAccountSupportedResources).not.toHaveBeenCalled();
    expect(putConnectedAccount).not.toHaveBeenCalled();
  });

  it("preflights an old OAuth callback before describing its provider account", async () => {
    let {user, connectedRecord, describeAccount, putConnectedAccount, setConfig} = makeUser();
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["google"]});

    await expect(user.completeConnectedAccount(
        7, connectedRecord.account as any, "google", undefined))
        .rejects.toThrow(/disabled/);
    expect(describeAccount).not.toHaveBeenCalled();
    expect(putConnectedAccount).not.toHaveBeenCalled();
  });

  it("re-checks policy after reconnect discovery before restoring credentials", async () => {
    let {
      user, describeAccount, connectedRecord, putConnectedAccount, setConfig,
    } = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let releaseDescription!: () => void;
    let descriptionEntered!: () => void;
    let entered = new Promise<void>(resolve => { descriptionEntered = resolve; });
    describeAccount.mockImplementationOnce(async () => {
      descriptionEntered();
      await new Promise<void>(resolve => { releaseDescription = resolve; });
      return {
        avatar: {url: "https://example.com/avatar.png"},
        grantedResourceUrlPatterns: [GMAIL_PATTERN, CALENDAR_PATTERN],
      };
    });

    let pending = user.markCredentialsRestored(3);
    await entered;
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledResources: {google: [CALENDAR_PATTERN]}});
    releaseDescription();

    await expect(pending).rejects.toThrow(/gained a resource disabled/);
    expect(connectedRecord.credentialsExpired).toBe(true);
    expect(putConnectedAccount).toHaveBeenCalledWith(connectedRecord);
  });

  it("does not overwrite a replacement account when an older restore callback settles", async () => {
    let {
      user, describeAccount, connectedRecord, putConnectedAccount, setConfig,
      replaceConnectedRecord,
    } = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let releaseDescription!: () => void;
    let descriptionEntered!: () => void;
    let entered = new Promise<void>(resolve => { descriptionEntered = resolve; });
    describeAccount.mockImplementationOnce(async () => {
      descriptionEntered();
      await new Promise<void>(resolve => { releaseDescription = resolve; });
      return {avatar: {url: "https://example.com/new.png"}};
    });

    let pending = user.markCredentialsRestored(3);
    await entered;
    let replacement = {
      ...connectedRecord,
      accountGeneration: 1,
      account: {},
      credentialsExpired: false,
    };
    replaceConnectedRecord(replacement);
    releaseDescription();

    await expect(pending).rejects.toThrow(/account changed/);
    expect(putConnectedAccount).not.toHaveBeenCalled();
    expect(replacement.credentialsExpired).toBe(false);
  });

  it("disposes a minted class when its account is replaced before publication", async () => {
    let {user, connectedRecord, setConfig, replaceConnectedRecord} = makeUser();
    setConfig(DEFAULT_ADMIN_CONFIG);
    let releaseClass!: () => void;
    let classEntered!: () => void;
    let entered = new Promise<void>(resolve => { classEntered = resolve; });
    let disposeClass = vi.fn();
    let cls = {[Symbol.dispose]: disposeClass};
    (connectedRecord.account as any).getGatekeeperClassFor = vi.fn(async () => {
      classEntered();
      await new Promise<void>(resolve => { releaseClass = resolve; });
      return {class: cls, resource: RESOURCES[0]};
    });

    let pending = user.getGatekeeperClassFor(3, "https://mail.google.com/inbox");
    await entered;
    replaceConnectedRecord({...connectedRecord, accountGeneration: 1, account: {}});
    releaseClass();

    await expect(pending).rejects.toThrow(/account changed/);
    expect(disposeClass).toHaveBeenCalledTimes(1);
  });

  it("fails closed before deleting a forced ambient account under malformed policy", async () => {
    let {
      user, connectedRecord, deleteConnectedAccount, setRawConfig,
    } = makeUser();
    let revoke = vi.fn();
    connectedRecord.autoProvisioned = true;
    connectedRecord.account.revoke = revoke;
    setRawConfig("not json");

    await expect(user.disconnectAccount(3)).rejects.toThrow(/policy is malformed/);
    expect(revoke).not.toHaveBeenCalled();
    expect(deleteConnectedAccount).not.toHaveBeenCalled();
  });

  it("does not contact the provider when a reconnect settles after whole-vendor disable", async () => {
    let {user, describeAccount, connectedRecord, putConnectedAccount, setConfig} = makeUser();
    setConfig({...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["google"]});

    await expect(user.markCredentialsRestored(3)).rejects.toThrow(/integration was disabled/i);
    expect(describeAccount).not.toHaveBeenCalled();
    expect(connectedRecord.credentialsExpired).toBe(true);
    expect(putConnectedAccount).toHaveBeenCalledWith(connectedRecord);
  });
});

describe("UserDurableObject ambient provisioning policy", () => {
  it("does not contact a whole-vendor-disabled provider", async () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      disabledGatekeepers: ["library"],
      ambientGatekeeperModes: {library: "optional" as const},
    };
    await env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(config));
    let stub = env.TEST_USER.getByName("ambient-disabled-" + crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      let describeVendor = vi.fn();
      let createAccount = vi.fn();
      Object.assign(user, {
        vendors: new Map([["library", {describe: describeVendor, createAccount}]]),
      });

      await expect(user.provisionAmbientAccount("library")).rejects.toThrow(/disabled/);
      expect(describeVendor).not.toHaveBeenCalled();
      expect(createAccount).not.toHaveBeenCalled();
    });
  });

  it("revokes instead of persisting when forced mode changes during creation", async () => {
    let enabled = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: {library: "enabled" as const},
    };
    await env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(enabled));
    let stub = env.TEST_USER.getByName("ambient-mode-race-" + crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      let describeAccount = vi.fn();
      let revoke = vi.fn(async () => {});
      let createAccount = vi.fn(async () => {
        await env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig({
          ...DEFAULT_ADMIN_CONFIG,
          ambientGatekeeperModes: {library: "optional"},
        }));
        return {describe: describeAccount, revoke};
      });
      let describeVendor = vi.fn(async () => ({
        title: "Library",
        description: "Library",
        autoProvisionsAccount: true,
      }));
      Object.assign(user, {
        vendors: new Map([["library", {describe: describeVendor, createAccount}]]),
      });

      await expect(user.listProvidedAccounts()).resolves.toEqual([]);
      expect(createAccount).toHaveBeenCalledTimes(1);
      expect(describeAccount).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledTimes(1);
    });
  });
});
