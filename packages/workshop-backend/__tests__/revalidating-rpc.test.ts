import {RpcStub as CapnRpcStub, RpcTarget} from "capnweb";
import {RpcStub as NativeRpcStub} from "cloudflare:workers";
import {describe, expect, it, vi} from "vitest";
import {makeRevalidatingRpcStub} from "../src/revalidating-rpc.js";

async function expectRejection(call: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  expect(String(caught)).toMatch(pattern);
}

class TestChild extends RpcTarget {
  constructor(
      private readonly readImpl: () => unknown,
      private readonly spawnImpl?: () => RpcTarget) {
    super();
  }

  read(): unknown {
    return this.readImpl();
  }

  spawn(): RpcTarget {
    if (!this.spawnImpl) throw new Error("No child configured.");
    return this.spawnImpl();
  }
}

describe("recursive revalidating RPC membrane", () => {
  it("guards capabilities nested in object/array results and descendants reacquired from them",
      async () => {
    let enabled = true;
    let leafRead = vi.fn(() => "leaf");
    let grandchildRead = vi.fn(() => "grandchild");
    class Root extends RpcTarget {
      nested() {
        return {items: [new TestChild(leafRead, () => new TestChild(grandchildRead))]};
      }
    }

    using session = makeRevalidatingRpcStub(
        () => new Root(),
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    using result = await (session as any).nested();
    let child = result.items[0];
    using grandchild = await child.spawn();

    enabled = false;
    await expectRejection(child.read(), /Calendar is disabled/);
    await expectRejection(grandchild.read(), /Calendar is disabled/);
    expect(leafRead).not.toHaveBeenCalled();
    expect(grandchildRead).not.toHaveBeenCalled();
  });

  it("guards callable results and accepts ordinary native and Cap'n Web stubs", async () => {
    let enabled = true;
    let called = vi.fn((value: string) => `called:${value}`);
    class Root extends RpcTarget {
      callable() {
        return called;
      }

      nativeChild() {
        return new NativeRpcStub(new TestChild(() => "native"));
      }

      capnChild() {
        return new CapnRpcStub(new TestChild(() => "capn"));
      }
    }

    using session = makeRevalidatingRpcStub(
        () => new Root(),
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    using fn = await (session as any).callable();
    using child = await (session as any).nativeChild();
    using capnChild = await (session as any).capnChild();
    await expect(child.read()).resolves.toBe("native");
    await expect(capnChild.read()).resolves.toBe("capn");

    enabled = false;
    await expectRejection(fn("value"), /Calendar is disabled/);
    expect(called).not.toHaveBeenCalled();
  });

  it("rejects nested RpcPromises and guards an immediate pipelined child call", async () => {
    let enabled = true;
    let childRead = vi.fn(() => "private");
    class Root extends RpcTarget {
      nestedPromise() {
        using child = new CapnRpcStub(new TestChild(() => "resolved"));
        return {pending: (child as any).read()};
      }

      child() {
        enabled = false;
        return new TestChild(childRead);
      }
    }

    using session = makeRevalidatingRpcStub(
        () => new Root(),
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    await expectRejection((session as any).nestedPromise(), /unsupported thenable/);

    enabled = true;
    let childPromise = (session as any).child();
    let pipelinedRead = childPromise.read();
    await Promise.all([
      expectRejection(childPromise, /RPC capability is no longer available/),
      expectRejection(pipelinedRead, /RPC capability is no longer available/),
    ]);
    expect(childRead).not.toHaveBeenCalled();
  });

  it("does not release a result when policy changes during an in-flight call", async () => {
    let enabled = true;
    let started!: () => void;
    let finish!: (value: string) => void;
    let didStart = new Promise<void>(resolve => { started = resolve; });
    let slowResult = new Promise<string>(resolve => { finish = resolve; });
    class Root extends RpcTarget {
      async read() {
        started();
        return slowResult;
      }
    }

    using session = makeRevalidatingRpcStub(
        () => new Root(),
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    let pending = (session as any).read();
    await didStart;
    enabled = false;
    finish("private calendar data");

    await expectRejection(pending, /RPC capability is no longer available/);
  });

  it("does not release a provider rejection when policy changes while the call is in flight",
      async () => {
    let enabled = true;
    let started!: () => void;
    let reject!: (reason: unknown) => void;
    let didStart = new Promise<void>(resolve => { started = resolve; });
    let providerResult = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    class Root extends RpcTarget {
      async read() {
        started();
        return providerResult;
      }
    }

    using source = new NativeRpcStub(new Root());
    using session = makeRevalidatingRpcStub(
        () => source,
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    let pending = (session as any).read();
    await didStart;
    enabled = false;
    reject(Object.assign(new Error("private calendar data"), {
      providerDetail: "secret attendee notes",
    }));

    let caught: any;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("RPC capability is no longer available.");
    expect(caught.message).not.toContain("private calendar data");
    expect(caught.providerDetail).toBeUndefined();
  });

  it("guards a provider-retained callback after its originating call returns", async () => {
    let enabled = true;
    let delivered = vi.fn();
    class Receiver extends RpcTarget {
      notify(value: string) {
        delivered(value);
      }
    }
    class Root extends RpcTarget {
      retained?: NativeRpcStub<RpcTarget>;

      subscribe(callback: NativeRpcStub<RpcTarget>) {
        this.retained = callback.dup();
      }

      fire() {
        if (!this.retained) throw new Error("No callback.");
        return (this.retained as any).notify("event");
      }

      [Symbol.dispose]() {
        this.retained?.[Symbol.dispose]();
      }
    }

    let root = new Root();
    using session = makeRevalidatingRpcStub(
        () => root,
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    await (session as any).subscribe(new Receiver());
    enabled = false;

    await expectRejection(root.fire(), /Calendar is disabled/);
    expect(delivered).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("recursively guards capabilities in retained-callback arguments and results", async () => {
    let enabled = true;
    let argumentChildRead = vi.fn(() => "argument child");
    let resultChildRead = vi.fn(() => "result child");
    class Receiver extends RpcTarget {
      saved?: NativeRpcStub<RpcTarget>;

      receive(value: {children: NativeRpcStub<RpcTarget>[]}) {
        this.saved = value.children[0].dup();
        return {children: [new TestChild(resultChildRead)]};
      }

      [Symbol.dispose]() {
        this.saved?.[Symbol.dispose]();
      }
    }
    class Root extends RpcTarget {
      retained?: NativeRpcStub<RpcTarget>;

      subscribe(callback: NativeRpcStub<RpcTarget>) {
        this.retained = callback.dup();
      }

      exchange() {
        if (!this.retained) throw new Error("No callback.");
        return (this.retained as any).receive({
          children: [new TestChild(argumentChildRead)],
        });
      }

      [Symbol.dispose]() {
        this.retained?.[Symbol.dispose]();
      }
    }

    let root = new Root();
    let receiver = new Receiver();
    using session = makeRevalidatingRpcStub(
        () => root,
        () => { if (!enabled) throw new Error("Calendar is disabled."); });
    await (session as any).subscribe(receiver);
    using response = await root.exchange();
    expect(receiver.saved).toBeDefined();
    enabled = false;

    await expectRejection((receiver.saved as any).read(), /Calendar is disabled/);
    await expectRejection(response.children[0].read(), /Calendar is disabled/);
    expect(argumentChildRead).not.toHaveBeenCalled();
    expect(resultChildRead).not.toHaveBeenCalled();
    receiver[Symbol.dispose]();
    root[Symbol.dispose]();
  });

  it("sanitizes thrown errors and rejects returned Error objects containing capabilities",
      async () => {
    class Root extends RpcTarget {
      returnedError() {
        return Object.assign(new Error("returned"), {
          cursor: new TestChild(() => "escaped"),
        });
      }

      thrownError() {
        throw Object.assign(new Error("provider failed"), {
          code: "SAFE_CODE",
          cursor: new TestChild(() => "escaped"),
        });
      }
    }

    using source = new NativeRpcStub(new Root());
    using session = makeRevalidatingRpcStub(() => source, () => undefined);
    await expectRejection(
        (session as any).returnedError(), /Error object with unsupported nested state/);

    let caught: any;
    try {
      await (session as any).thrownError();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("provider failed");
    expect(caught.cursor).toBeUndefined();
    expect(caught.cause).toBeUndefined();
  });

  it("fails closed for streams and body-bearing request/response values", async () => {
    class Root extends RpcTarget {
      stream() {
        return new ReadableStream({start(controller) { controller.enqueue(new Uint8Array([1])); }});
      }

      response() {
        return new Response("private body");
      }

      request() {
        return new Request("https://example.com", {method: "POST", body: "private body"});
      }

      safeResponse() {
        return new Response(null, {status: 204});
      }

      safeRequest() {
        return new Request("https://example.com/safe");
      }
    }

    using session = makeRevalidatingRpcStub(() => new Root(), () => undefined);
    await expectRejection((session as any).stream(), /stream.*cannot be revalidated/i);
    await expectRejection((session as any).response(), /response body.*cannot be revalidated/i);
    await expectRejection((session as any).request(), /request body.*cannot be revalidated/i);
    await expect((session as any).safeResponse()).resolves.toMatchObject({status: 204});
    await expect((session as any).safeRequest()).resolves.toMatchObject({
      method: "GET",
      url: "https://example.com/safe",
    });
  });

  it("fails closed on cycles and depth, node, and byte budget exhaustion", async () => {
    class CustomContainer {
      child = new TestChild(() => "escaped");
    }
    class CustomArray extends Array<unknown> {}
    class CustomView extends Uint8Array {}
    class Root extends RpcTarget {
      cycle() {
        let result: {self?: unknown} = {};
        result.self = result;
        return result;
      }

      deep() {
        let root: Record<string, unknown> = {};
        let cursor = root;
        for (let i = 0; i < 66; i++) {
          let next: Record<string, unknown> = {};
          cursor.next = next;
          cursor = next;
        }
        return root;
      }

      wide() {
        return Array.from({length: 4096}, () => null);
      }

      large() {
        return "x".repeat(8 * 1024 * 1024 + 1);
      }

      custom() {
        return new CustomContainer();
      }

      customArray() {
        return new CustomArray("safe", new TestChild(() => "escaped"));
      }

      customView() {
        return new CustomView([1, 2, 3]);
      }

      oversizedBigint() {
        return 1n << 65n;
      }
    }

    using session = makeRevalidatingRpcStub(() => new Root(), () => undefined);
    await expectRejection((session as any).cycle(), /cyclic/);
    await expectRejection((session as any).deep(), /nesting limit/);
    await expectRejection((session as any).wide(), /size limit/);
    await expectRejection((session as any).large(), /size limit/);
    await expectRejection((session as any).custom(), /unsupported non-plain container/);
    await expectRejection((session as any).customArray(), /unsupported custom array/);
    await expectRejection((session as any).customView(), /unsupported custom ArrayBuffer view/);
    await expectRejection((session as any).oversizedBigint(), /out-of-range bigint/);
  });

  it("does not serialize hidden capability edges", async () => {
    class Root extends RpcTarget {
      hidden() {
        let result: Record<PropertyKey, unknown> = {visible: "safe"};
        Object.defineProperty(result, "hidden", {
          value: new TestChild(() => "escaped"),
          enumerable: false,
        });
        result[Symbol.for("hidden")] = new TestChild(() => "escaped");
        return result;
      }
    }

    using session = makeRevalidatingRpcStub(() => new Root(), () => undefined);
    let result = await (session as any).hidden();
    expect(result).toEqual({visible: "safe"});
    expect(result.hidden).toBeUndefined();
    expect(Reflect.ownKeys(result)).not.toContain(Symbol.for("hidden"));
  });

  it("dups nested returned stubs before releasing the source result container", async () => {
    let disposed = vi.fn();
    class DisposableChild extends RpcTarget {
      read() {
        return "still live";
      }

      [Symbol.dispose]() {
        disposed();
      }
    }
    class Root extends RpcTarget {
      nested() {
        return {items: [new DisposableChild()]};
      }
    }

    using source = new NativeRpcStub(new Root());
    using session = makeRevalidatingRpcStub(() => source, () => undefined);
    let result = await (session as any).nested();
    expect(disposed).not.toHaveBeenCalled();
    await expect(result.items[0].read()).resolves.toBe("still live");
    result[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("releases an explicitly-owned proxied RPC result when traversal fails before a later stub",
      async () => {
    let childDisposed = vi.fn();
    let rootDisposed = vi.fn();
    class DisposableChild extends RpcTarget {
      [Symbol.dispose]() {
        childDisposed();
      }
    }
    class Root extends RpcTarget {
      invalidResult() {
        return {
          oversized: Array.from({length: 4096}, () => null),
          later: new DisposableChild(),
        };
      }

      [Symbol.dispose]() {
        rootDisposed();
      }
    }

    using source = new NativeRpcStub(new Root());
    let proxiedSource = new Proxy(source as any, {
      get(target, prop) {
        if (prop === Symbol.dispose) return () => target[Symbol.dispose]();
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf() {
        return RpcTarget.prototype;
      },
    });
    expect(proxiedSource).not.toBeInstanceOf(NativeRpcStub);

    using session = makeRevalidatingRpcStub(
        () => proxiedSource,
        () => undefined,
        undefined,
        {disposeResolvedTarget: true, resultOwnership: "rpc-container"});
    await expectRejection((session as any).invalidResult(), /size limit/);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(childDisposed).toHaveBeenCalledTimes(1);
    expect(rootDisposed).toHaveBeenCalledTimes(1);
  });
});
