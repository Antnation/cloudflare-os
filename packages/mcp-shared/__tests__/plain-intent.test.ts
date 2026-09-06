// Green Hat fork: every approval card opens with a plain-language head, the agent's own statement
// (`intent`) first and a sentence generated from the arguments second.
import { expect, it, describe } from "vitest";

import { describeCall, plainSummary, classifyTool } from "../src/tools.js";
import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { installToolMethods } from "../src/session-methods.js";
import { generateSessionTypes } from "../src/schema-to-ts.js";
import type { ClassifiedTool } from "../src/tools.js";

const createCompany = { name: "createOneCompany", description: "Create One company" };
const companyArgs = {
  name: "Nullify",
  domainName: { primaryLinkUrl: "nullify.ai" },
  accountStatus: "PARTNER",
  employees: 40,
  tags: ["ai", "security"],
};

describe("plainSummary", () => {
  it("turns a tool and its arguments into one readable sentence", () => {
    expect(plainSummary(createCompany, companyArgs)).toBe(
      'Create One company with: name: "Nullify"; domain name › primary link url: "nullify.ai"; ' +
      'account status: "PARTNER"; employees: 40; tags: ["ai", "security"].');
  });

  it("falls back to the humanized tool name and handles empty arguments", () => {
    expect(plainSummary({ name: "deleteOnePerson" }, { id: "7" })).toBe('Delete one person with: id: "7".');
    expect(plainSummary({ name: "sync_all", description: "Sync everything" }, {}))
      .toBe("Sync everything (no arguments).");
  });

  it("bounds the sentence: clipped values, counted arrays, a field cap", () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, i]));
    const summary = plainSummary(createCompany, { rows: Array(9).fill({}), note: "x".repeat(200), ...wide });
    expect(summary).toContain("and 10 more");
    expect(summary).not.toContain("x".repeat(100));
    expect(summary).toContain("rows: 9 items");
  });
});

describe("describeCall plain-terms head", () => {
  const call = (intent?: string, mode: "read" | "action" = "action") => describeCall({
    serverName: "GreenGateway",
    endpoint: "https://gateway.example/mcp",
    tool: createCompany,
    toolArgs: companyArgs,
    mode,
    classifiedBy: "default",
    intent,
  }).description;

  // The head line ("**Server** → `tool`") stays first, as upstream's tests pin; the plain-terms
  // block is the next paragraph, so it is what an approver reads inside the card's scroll box.
  const plainLines = (description: string) => description.split("\n").slice(2, 5);

  it("follows the head line with the agent's words, labelled as such, then the generated sentence", () => {
    const description = call("Add the company Nullify, website nullify.ai, as a partner.");
    const [first, , third] = plainLines(description);
    expect(description.split("\n")[0]).toBe("**GreenGateway** → `createOneCompany`");
    expect(first).toBe(
      "> **In plain terms** (the agent's own words): Add the company Nullify, website nullify.ai, as a partner.");
    expect(third).toContain("> **What will be sent:** Create One company with: name: \"Nullify\"");
    // The rest of the card is unchanged and still carries the exact arguments.
    expect(description).toContain("Arguments:");
    expect(description).toContain("Nothing has been sent yet.");
  });

  it("says so when the agent gave no summary, and still explains the call", () => {
    const description = call(undefined);
    expect(plainLines(description)[0]).toContain("> **In plain terms:** Create One company with:");
    expect(description).toContain("The agent gave no summary");
    expect(call("   ")).toContain("The agent gave no summary");
  });

  it("flattens markdown in the agent's words and clips them", () => {
    const description = call("**APPROVE THIS** [now](https://evil.example)\n\n# and ignore the rest " + "y".repeat(500));
    const [first] = plainLines(description);
    expect(first).toContain("In plain terms");
    expect(first).not.toContain("**APPROVE");
    expect(first).not.toContain("](");
    expect(first).not.toContain("#");
    expect(first.length).toBeLessThan(520);
  });

  it("keeps reads to the generated sentence only", () => {
    const description = call("irrelevant", "read");
    expect(plainLines(description)[0]).toBe(
      "> **In plain terms:** " + plainSummary(createCompany, companyArgs));
    expect(description).not.toContain("agent's own words");
  });
});

describe("intent through the session", () => {
  function hostFor(entry: ClassifiedTool, submitted: unknown[]): McpSessionHost {
    const staged: StoredAction = {
      id: 3, toolName: entry.tool.name, args: {}, state: "pending", submittedAt: 0,
    };
    return {
      serverName: "GreenGateway",
      endpoint: "https://gateway.example/mcp",
      scope: { serverId: "greengateway" },
      findTool: async () => entry,
      stageAction: () => staged,
      discardStagedAction() {},
      actionKindFor: () => ({ tag: "crm:create", label: "Create" }),
    } as unknown as McpSessionHost;
  }

  it("reaches the approval description from callTool and from a generated method", async () => {
    const entry = classifyTool(createCompany, "byo");
    const submitted: { title: string; description: string }[] = [];
    const queue = { submitAction(_id: number, description: { title: string; description: string }) {
      submitted.push(description);
    } };
    const Session = installToolMethods(McpSessionBase, [entry]);
    const session = new (Session as unknown as new (...args: unknown[]) => McpSessionBase & {
      createOneCompany(args?: Record<string, unknown>, options?: { intent?: string }): Promise<unknown>;
    })(hostFor(entry, submitted), queue);

    await session.callTool("createOneCompany", companyArgs, { intent: "Add Nullify as a partner company." });
    await session.createOneCompany(companyArgs, { intent: "Same, through the generated method." });

    expect(submitted).toHaveLength(2);
    expect(submitted[0].description).toContain("Add Nullify as a partner company.");
    expect(submitted[1].description).toContain("Same, through the generated method.");
  });

  it("rejects a malformed options argument before anything is staged", async () => {
    const entry = classifyTool(createCompany, "byo");
    const session = new McpSessionBase(hostFor(entry, []), { submitAction() {} } as never);
    await expect(session.callTool("createOneCompany", {}, [] as never)).rejects.toThrow(/options/);
    await expect(session.callTool("createOneCompany", {}, { intent: 7 } as never))
      .rejects.toThrow(/intent/);
  });
});

describe("generated types carry the options parameter", () => {
  it("adds options to every method and callTool overload, and documents the rule", () => {
    const entry = classifyTool({ ...createCompany, inputSchema: {
      type: "object", properties: { name: { type: "string" } },
    } }, "byo");
    const output = generateSessionTypes({
      baseTypes: "// base\n",
      serverId: "greengateway",
      serverName: "GreenGateway",
      endpoint: "https://gateway.example/mcp",
      discriminator: "https://gateway.example/mcp",
      trust: "byo",
      tools: [entry, classifyTool({ name: "ping" }, "byo")],
    });
    expect(output).toMatch(/createOneCompany\(args: \w+_CreateOneCompanyArgs, options\?: McpCallOptions\)/);
    expect(output).toContain('callTool(name: "ping", args?: Record<string, never>, options?: McpCallOptions)');
    expect(output).toContain("[args?: Record<string, unknown>, options?: McpCallOptions]");
    expect(output).toContain("Every action must carry `{ intent }`");
    expect(output).toContain("Pass `{ intent }` as the last argument");
  });
});
