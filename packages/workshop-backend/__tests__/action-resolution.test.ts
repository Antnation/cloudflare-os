import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import type {AiChatAuthorInfo} from "@gadgets/workshop-shared/api";
import {
  overseerTestInternals,
  type ActionRecord,
  type OverseerDurableObject,
} from "../src/overseer.js";
import {makeMockStorage} from "./mock-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type OverseerImplForTest = InstanceType<typeof overseerTestInternals.OverseerImpl>;

const MANUAL_APPROVER: AiChatAuthorInfo = {
  type: "user",
  id: "manual@example.com",
  name: "Manual Approver",
};
const AUTO_APPROVER: AiChatAuthorInfo = {
  type: "user",
  id: "rule-owner@example.com",
  name: "Rule Owner",
};

function makeImpl(rawStorage: DurableObjectStorage = makeMockStorage()): OverseerImplForTest {
  let ctx = {
    id: {toString: () => "action-resolution-test"},
    storage: rawStorage,
    exports: {UserDurableObject: {}},
    facets: {get: vi.fn()},
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
  let impl = new overseerTestInternals.OverseerImpl(ctx, {} as Cloudflare.Env);
  vi.spyOn(impl, "assertGatekeeperAvailable").mockResolvedValue();
  return impl;
}

function putPendingAction(impl: OverseerImplForTest, id = 1): ActionRecord & {type: "action"} {
  let record: ActionRecord & {type: "action"} = {
    id,
    gatekeeperId: 17,
    caller: {from: "agent", chatId: 23},
    createdAt: new Date(),
    state: "pending",
    type: "action",
    action: 41,
    description: {
      title: "Create meeting",
      description: "Creates one external calendar event.",
      autoApprovable: true,
      actionKind: {tag: "calendar.create", label: "Create calendar events"},
    },
  };
  impl.storage.actions.put(record);
  return record;
}

function controlledCall() {
  let release!: () => void;
  let blocked = new Promise<void>(resolve => { release = resolve; });
  return {blocked, release};
}

describe("durable pending-action resolution", () => {
  it("lets only one of concurrent manual and automatic approvals dispatch the write", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let call = controlledCall();
    let applyAction = vi.fn(async () => call.blocked);
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({applyAction} as never);

    let manual = impl.applyPendingAction(action, MANUAL_APPROVER, false);
    await vi.waitFor(() => expect(applyAction).toHaveBeenCalledTimes(1));

    let claimed = impl.storage.actions.get(action.id);
    expect(claimed?.type === "action" && claimed.resolutionAttempt?.phase).toBe("resolving");
    await expect(impl.applyPendingAction(action, AUTO_APPROVER, true))
      .rejects.toThrow(/resolution is already in progress/);
    expect(applyAction).toHaveBeenCalledTimes(1);

    call.release();
    await manual;
    let resolved = impl.storage.actions.get(action.id);
    expect(resolved?.state).toBe("approved");
    expect(resolved?.type === "action" && resolved.resolutionAttempt).toBeUndefined();
    expect(resolved?.type === "action" && resolved.autoApproved).toBe(false);
    expect(resolved?.type === "action" && resolved.resolvedBy?.id).toBe(MANUAL_APPROVER.id);
  });

  it("does not retry an approval whose provider outcome is ambiguous", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let applyAction = vi.fn(async () => { throw new Error("connection lost"); });
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({applyAction} as never);

    await expect(impl.applyPendingAction(action, MANUAL_APPROVER, false))
      .rejects.toThrow(/could not confirm whether this action was applied/);
    let failed = impl.storage.actions.get(action.id);
    expect(failed?.state).toBe("pending");
    expect(failed?.type === "action" && failed.resolutionAttempt?.phase).toBe("failed");

    await expect(impl.applyPendingAction(action, MANUAL_APPROVER, false))
      .rejects.toThrow(/cannot be approved again safely/);
    expect(applyAction).toHaveBeenCalledTimes(1);
  });

  it("does not publish provider success after policy disappears in flight", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let policyReads = 0;
    vi.mocked(impl.assertGatekeeperAvailable).mockImplementation(async () => {
      if (++policyReads === 2) throw new Error("private policy detail");
    });
    let applyAction = vi.fn(async () => {});
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({applyAction} as never);

    await expect(impl.applyPendingAction(action, MANUAL_APPROVER, false))
      .rejects.toThrow(/provider outcome was not accepted/);
    let failed = impl.storage.actions.get(action.id);
    expect(failed?.state).toBe("pending");
    expect(failed?.type === "action" && failed.resolutionAttempt?.phase).toBe("failed");
    expect(applyAction).toHaveBeenCalledTimes(1);
  });

  it("fences an interrupted approval after a Durable Object restart and permits rejection", async () => {
    let stub = env.TEST_OVERSEER.getByName(`action-restart-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as {impl: OverseerImplForTest}).impl;
      let action = putPendingAction(impl);
      let stored = impl.storage.actions.get(action.id);
      if (!stored || stored.type !== "action") throw new Error("missing action");
      stored.resolutionAttempt = {
        attemptId: "interrupted-attempt",
        decision: "approve",
        phase: "resolving",
        startedAt: new Date(Date.now() - 60_000),
        resolvedBy: MANUAL_APPROVER,
        autoApproved: false,
      };
      impl.storage.actions.put(stored);
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let recovered = (instance as unknown as {impl: OverseerImplForTest}).impl;
      let afterRestart = recovered.storage.actions.get(1);
      if (!afterRestart || afterRestart.type !== "action") throw new Error("missing action");
      expect(afterRestart.resolutionAttempt?.phase).toBe("failed");

      let applyAction = vi.fn(async () => {});
      let rejectAction = vi.fn(async () => {});
      vi.spyOn(recovered, "assertGatekeeperAvailable").mockResolvedValue();
      vi.spyOn(recovered, "getGatekeeperFacet")
        .mockReturnValue({applyAction, rejectAction} as never);
      await expect(recovered.applyPendingAction(afterRestart, MANUAL_APPROVER, false))
        .rejects.toThrow(/cannot be approved again safely/);
      expect(applyAction).not.toHaveBeenCalled();

      let rejected = await recovered.rejectPendingAction(1, MANUAL_APPROVER);
      expect(rejectAction).toHaveBeenCalledTimes(1);
      expect(rejected.record.state).toBe("rejected");
      expect(recovered.storage.actions.get(1)?.state).toBe("rejected");
    });
  });

  it("does not let rejection race a provider apply already in flight", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let call = controlledCall();
    let applyAction = vi.fn(async () => call.blocked);
    let rejectAction = vi.fn(async () => {});
    vi.spyOn(impl, "getGatekeeperFacet")
      .mockReturnValue({applyAction, rejectAction} as never);

    let applying = impl.applyPendingAction(action, MANUAL_APPROVER, false);
    await vi.waitFor(() => expect(applyAction).toHaveBeenCalledTimes(1));
    await expect(impl.rejectPendingAction(action.id, MANUAL_APPROVER))
      .rejects.toThrow(/resolution is already in progress/);
    expect(rejectAction).not.toHaveBeenCalled();

    call.release();
    await applying;
    expect(impl.storage.actions.get(action.id)?.state).toBe("approved");
  });

  it("claims rejection before provider I/O and reports a structured prior apply", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let call = controlledCall();
    let rejectAction = vi.fn(async () => {
      await call.blocked;
      return {outcome: "applied" as const};
    });
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({rejectAction} as never);

    let first = impl.rejectPendingAction(action.id, MANUAL_APPROVER);
    await vi.waitFor(() => expect(rejectAction).toHaveBeenCalledTimes(1));
    await expect(impl.rejectPendingAction(action.id, AUTO_APPROVER))
      .rejects.toThrow(/resolution is already in progress/);
    expect(rejectAction).toHaveBeenCalledTimes(1);

    call.release();
    let result = await first;
    expect(result.record.state).toBe("approved");
    expect(result.outcomeUnknown).toBe(false);
  });

  it("revalidates provider rejection and exposes only a fixed local error", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let rejectAction = vi.fn()
      .mockRejectedValueOnce(new Error("private provider response"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({rejectAction} as never);

    await expect(impl.rejectPendingAction(action.id, MANUAL_APPROVER))
      .rejects.toThrow(/could not confirm that the staged action was discarded/);
    await expect(impl.rejectPendingAction(action.id, MANUAL_APPROVER))
      .resolves.toMatchObject({record: {state: "rejected"}});
    expect(rejectAction).toHaveBeenCalledTimes(2);
  });

  it("suppresses a structured provider outcome when policy disappears after rejection", async () => {
    let impl = makeImpl();
    let action = putPendingAction(impl);
    let policyReads = 0;
    vi.mocked(impl.assertGatekeeperAvailable).mockImplementation(async () => {
      if (++policyReads === 2) throw new Error("disabled");
    });
    let rejectAction = vi.fn(async () => ({outcome: "applied" as const}));
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({rejectAction} as never);

    let result = await impl.rejectPendingAction(action.id, MANUAL_APPROVER);
    expect(result.record.state).toBe("rejected");
    expect(result.outcomeUnknown).toBe(false);
    expect(rejectAction).toHaveBeenCalledTimes(1);
  });
});
