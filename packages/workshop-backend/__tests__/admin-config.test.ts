import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, accountGrantIncludesDisabledResource, defaultOutputFormatId, gatekeeperAvailabilityBlock, normalizeResourceGrantSelection, parseAdminConfig, parseAdminConfigForAuthority, reorderFormats, resolveFormatOutput, sanitizeOutputOverrides, serializeAdminConfig } from "../src/admin-config.js";

describe("parseAdminConfig", () => {
  it("backfills fields missing from a config persisted before they existed", () => {
    // A config written before `formats` was added. Every consumer indexes into these, so a missing
    // field must come back as its default rather than undefined.
    let stored = JSON.stringify({ signupsEnabled: false, siteName: "acme" });
    let config = parseAdminConfig(stored);

    expect(config.signupsEnabled).toBe(false);
    expect(config.siteName).toBe("acme");
    expect(config.formats).toEqual([]);
    for (let key of Object.keys(DEFAULT_ADMIN_CONFIG)) {
      expect(config[key as keyof typeof config], key).toBeDefined();
    }
  });

  it("drops malformed format entries rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "good", enabled: true, agentHint: "  prefer me  " },
        { enabled: true },                       // no blueprintId
        "nonsense",
        { blueprintId: "defaults-enabled" },     // enabled omitted
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "good", enabled: true, agentHint: "prefer me" },
      { blueprintId: "defaults-enabled", enabled: true },
    ]);
  });

  // Everything downstream keys formats by blueprint id; setFormatOrder() in particular treats the
  // list as a set and refuses every reordering if it isn't one. A duplicate would make the menu
  // permanently unorderable, so it can't be allowed to survive a read.
  it("keeps only the first entry for a repeated blueprint", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "dup", enabled: true, agentHint: "first" },
        { blueprintId: "other", enabled: true },
        { blueprintId: "dup", enabled: false, agentHint: "second" },
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "dup", enabled: true, agentHint: "first" },
      { blueprintId: "other", enabled: true },
    ]);
  });
});

describe("reorderFormats", () => {
  let promoted = [
    { blueprintId: "a", enabled: true },
    { blueprintId: "b", enabled: true },
    { blueprintId: "c", enabled: true },
  ];

  it("rearranges into the order given", () => {
    expect(reorderFormats(promoted, ["c", "a", "b"]).map(f => f.blueprintId))
        .toEqual(["c", "a", "b"]);
  });

  // A repeated id passes both a length and a membership test, so without an explicit uniqueness
  // check it would drop "b" and leave a duplicate that makes every later reorder throw.
  it("refuses a repeated id", () => {
    expect(() => reorderFormats(promoted, ["a", "a", "c"])).toThrow(/exactly once/);
  });

  it("refuses a short list, a long list, and an unknown id", () => {
    expect(() => reorderFormats(promoted, ["a", "b"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "c", "a"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "z"])).toThrow(/exactly once/);
  });
});

describe("format presentation", () => {
  let declared = { id: "presentation", noun: "Slides", plural: "Slides", icon: "presentation" } as const;

  it("applies overrides over the blueprint's own declaration", () => {
    expect(resolveFormatOutput(declared, { noun: "Briefing", plural: "Briefings" }))
        .toEqual({ ...declared, noun: "Briefing", plural: "Briefings" });
  });

  it("has no format to offer when neither side supplies a complete one", () => {
    expect(resolveFormatOutput(undefined, { noun: "Briefing" })).toBeUndefined();
    expect(resolveFormatOutput(undefined, undefined)).toBeUndefined();
  });

  it("keeps only well-formed override fields", () => {
    expect(sanitizeOutputOverrides({ noun: "  Deck  ", icon: "notAnIcon", plural: "" }))
        .toEqual({ noun: "Deck" });
    expect(sanitizeOutputOverrides({ icon: "notAnIcon" })).toBeUndefined();
    expect(sanitizeOutputOverrides({ noun: "x".repeat(41) })).toBeUndefined();
  });

  it("derives a stable, valid grouping id without asking the admin for one", () => {
    expect(defaultOutputFormatId("acme.contract-memo")).toBe("acme.contract-memo");
    let long = "acme." + "contract-".repeat(8);
    expect(defaultOutputFormatId(long)).toBe(defaultOutputFormatId(long));
    expect(defaultOutputFormatId(long)).toHaveLength(40);
    expect(defaultOutputFormatId(long)).not.toBe(defaultOutputFormatId(long + "other"));
  });
});

describe("admin config site logo", () => {
  it("defaults legacy and malformed values to no custom logo", () => {
    expect(parseAdminConfig("{}").siteLogoConfigured).toBe(false);
    expect(parseAdminConfig('{"siteLogoConfigured":"yes"}').siteLogoConfigured).toBe(false);
  });

  it("round-trips configured logo state", () => {
    let config = parseAdminConfig('{"siteLogoConfigured":true}');
    expect(config.siteLogoConfigured).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
  });
});

describe("gatekeeper resource policy", () => {
  const gmail = {
    urlPattern: "https://mail.google.com/*",
    title: "Gmail",
    description: "Mail",
    grantable: true,
  };
  const calendar = {
    urlPattern: "https://calendar.google.com/calendar/:calendarId/*",
    title: "Google Calendar",
    description: "Calendar",
    grantable: true,
  };
  const profile = {
    urlPattern: "https://accounts.google.com/*",
    title: "Google profile",
    description: "Profile",
  };
  const config = {
    ...DEFAULT_ADMIN_CONFIG,
    disabledResources: { google: [calendar.urlPattern] },
  };

  it("normalizes vendor IDs and repeated resource patterns when parsing", () => {
    let parsed = parseAdminConfig(JSON.stringify({
      disabledResources: {
        Google: [calendar.urlPattern, calendar.urlPattern],
        google: [gmail.urlPattern],
      },
    }));

    expect(parsed.disabledResources).toEqual({
      google: [calendar.urlPattern, gmail.urlPattern],
    });
  });

  it("fails closed when a present authority policy is malformed", () => {
    expect(parseAdminConfigForAuthority(null)).toEqual(DEFAULT_ADMIN_CONFIG);
    expect(() => parseAdminConfigForAuthority("not json")).toThrow(/policy is malformed/);
    expect(() => parseAdminConfigForAuthority(JSON.stringify({
      disabledResources: {google: calendar.urlPattern},
    }))).toThrow(/resource policy is malformed/);
    expect(() => parseAdminConfigForAuthority(JSON.stringify({
      disabledGatekeepers: ["google", 7],
    }))).toThrow(/gatekeeper policy is malformed/);
    expect(() => parseAdminConfigForAuthority(JSON.stringify({
      signupsEnabled: "false",
    }))).toThrow(/signup policy is malformed/);
  });

  it("blocks retained ordinary, ambient, and legacy capabilities", () => {
    expect(gatekeeperAvailabilityBlock(config, {
      type: "gatekeeper",
      vendorId: "Google",
      resourceUrl: "https://calendar.google.com/calendar/team/",
      typeUrlPattern: calendar.urlPattern,
    })).toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});

    expect(gatekeeperAvailabilityBlock({
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: {scheduler: "disabled"},
    }, {type: "ambient", vendorId: "scheduler", accountId: 1}))
        .toEqual({kind: "gatekeeper", vendorId: "scheduler"});

    expect(gatekeeperAvailabilityBlock(
        config,
        {type: "ambient", vendorId: "google", accountId: 1},
        "https://calendar.google.com/calendar/team/events"))
        .toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});

    expect(gatekeeperAvailabilityBlock(config, {
      type: "gatekeeper",
      vendorId: "Google",
      resourceUrl: "https://calendar.google.com/calendar/team/events",
      // Historical persisted records can predate this now-required field.
    } as any)).toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});

    expect(gatekeeperAvailabilityBlock(config, {
      type: "gatekeeper",
      vendorId: "Google",
      // A crash-window historical row can lack both fields.
    } as any)).toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});

    expect(gatekeeperAvailabilityBlock(config, undefined))
        .toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});

    expect(gatekeeperAvailabilityBlock(
        config, undefined,
        "https://calendar.google.com/calendar/u/0/r?cid=team%40greenhatsec.com"))
        .toEqual({kind: "resource", vendorId: "google", urlPattern: calendar.urlPattern});
  });

  it("keeps unrelated and built-in capabilities enabled", () => {
    expect(gatekeeperAvailabilityBlock(config, {
      type: "gatekeeper",
      vendorId: "google",
      resourceUrl: "https://mail.google.com/mail/u/0/",
      typeUrlPattern: gmail.urlPattern,
    })).toBeUndefined();
    expect(gatekeeperAvailabilityBlock(config, {
      type: "aiModel", modelId: "m", provider: "p", modelName: "n",
    })).toBeUndefined();
  });

  it("quarantines ambiguous legacy records without shadowing modern specific resources", () => {
    let slackChannel = "https://app.slack.com/client/:teamId/:conversationId";
    let catchAllDisabled = {
      ...DEFAULT_ADMIN_CONFIG,
      disabledResources: {slack: ["https://*"]},
    };

    expect(gatekeeperAvailabilityBlock(catchAllDisabled, {
      type: "gatekeeper",
      vendorId: "slack",
      resourceUrl: "https://app.slack.com/client/T123/C456",
      typeUrlPattern: slackChannel,
    })).toBeUndefined();
    expect(gatekeeperAvailabilityBlock(
        catchAllDisabled, undefined, "https://notion.so/team/page"))
        .toEqual({kind: "resource", vendorId: "slack", urlPattern: "https://*"});
    expect(gatekeeperAvailabilityBlock(
        catchAllDisabled, undefined, "https://app.slack.com/client/T123/C456", "slack"))
        .toEqual({kind: "resource", vendorId: "slack", urlPattern: "https://*"});

    expect(gatekeeperAvailabilityBlock(
        {...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["google"]},
        undefined,
        "https://calendar.google.com/calendar/team/events"))
        .toEqual({kind: "gatekeeper", vendorId: "google"});
  });

  it("narrows an omitted grant and rejects explicit disabled or non-grantable resources", () => {
    let resources = [gmail, calendar, profile];
    expect(normalizeResourceGrantSelection(
        config, "Google", resources, undefined)).toEqual([gmail.urlPattern]);
    expect(normalizeResourceGrantSelection(
        DEFAULT_ADMIN_CONFIG, "google", resources, undefined)).toBeUndefined();
    expect(normalizeResourceGrantSelection(
        config, "google", resources, [gmail.urlPattern, gmail.urlPattern]))
        .toEqual([gmail.urlPattern]);
    expect(() => normalizeResourceGrantSelection(
        config, "google", resources, [calendar.urlPattern])).toThrow(/disabled/);
    expect(() => normalizeResourceGrantSelection(
        config, "google", resources, [profile.urlPattern])).toThrow(/non-grantable/);

    // A provider may return a user-specific or stale catalog which omits Calendar. Policy still
    // forces an explicit Gmail-only selection; `undefined` would mean "grant everything".
    expect(normalizeResourceGrantSelection(
        config, "google", [gmail], undefined)).toEqual([gmail.urlPattern]);
  });

  it("detects legacy or explicit grants that include a newly-disabled resource", () => {
    expect(accountGrantIncludesDisabledResource(
        config, "google", undefined)).toBe(true);
    expect(accountGrantIncludesDisabledResource(
        config, "google", [calendar.urlPattern])).toBe(true);
    expect(accountGrantIncludesDisabledResource(
        config, "google", [gmail.urlPattern])).toBe(false);
    // The account grant is authoritative; no live provider catalog is needed to retain the block.
  });
});
