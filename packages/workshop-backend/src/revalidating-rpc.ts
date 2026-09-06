import {RpcStub as CapnRpcStub, RpcTarget} from "capnweb";
import {RpcStub as NativeRpcStub} from "cloudflare:workers";

const MAX_RPC_DEPTH = 64;
const MAX_RPC_NODES = 4096;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MIN_RPC_BIGINT = -(1n << 63n);
const MAX_RPC_BIGINT = (1n << 64n) - 1n;

type Callable = (...args: unknown[]) => unknown;
type RpcCapability = RpcTarget | Callable;
type Revalidate = () => void | Promise<void>;
type TransferDirection = "argument" | "result";

type MembraneOptions = {
  /** Release a target created solely for one forwarded call, after that call settles. */
  disposeResolvedTarget?: boolean;
  /**
   * The target is a proxy around an RPC stub, so its non-primitive results carry the RPC
   * runtime's owning result-container disposer even though `instanceof RpcStub` is false.
   */
  resultOwnership?: "rpc-container";
};

type TraversalBudget = {
  nodes: number;
  bytes: number;
};

type RuntimeConstructor = {
  [Symbol.hasInstance](value: unknown): boolean;
};

const nativeRpcStubRuntime = NativeRpcStub as unknown as RuntimeConstructor;
const capnRpcStubRuntime = CapnRpcStub as unknown as RuntimeConstructor;
const serializableViewPrototypes = new Set<object>([
  DataView.prototype,
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
]);

function isPlainObject(value: object): value is Record<string, unknown> {
  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function charge(budget: TraversalBudget, bytes = 0): void {
  budget.nodes++;
  budget.bytes += bytes;
  if (budget.nodes > MAX_RPC_NODES || budget.bytes > MAX_RPC_BYTES) {
    throw new Error("RPC value exceeds the revalidation membrane's size limit.");
  }
}

function stringBytes(value: string): number {
  // Count UTF-8 without allocating another potentially-large string-sized buffer.
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff &&
               i + 1 < value.length &&
               value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_RPC_BYTES) return bytes;
  }
  return bytes;
}

function optionalStringBytes(value: unknown): number {
  return typeof value === "string" ? stringBytes(value) : 0;
}

function dispose(value: unknown): void {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    try {
      let disposer = (value as {[Symbol.dispose]?: () => void})[Symbol.dispose];
      if (typeof disposer === "function") {
        disposer.call(value);
      }
    } catch {
      // Disposal is cleanup. Never let a broken remote disposer replace the actual call result.
    }
  }
}

function callCapability(target: RpcCapability, prop: string | undefined, args: unknown[]): unknown {
  if (prop === undefined) {
    if (typeof target !== "function") throw new TypeError("RPC target is not callable.");
    return Reflect.apply(target, undefined, args);
  }

  let method = Reflect.get(target, prop);
  if (typeof method !== "function") throw new TypeError(`RPC target has no method ${prop}.`);
  return Reflect.apply(method, target, args);
}

function hasThenMethod(value: object): boolean {
  // Do not read an arbitrary `then` getter. Walking descriptors also recognizes native and Cap'n
  // Web RpcPromises, whose proxy prototypes expose then(), without turning ordinary stubs into
  // accidental thenables.
  let current: object | null = value;
  for (let depth = 0; current !== null && depth <= MAX_RPC_DEPTH; depth++) {
    let descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor) return !("value" in descriptor) || typeof descriptor.value === "function";
    current = Object.getPrototypeOf(current);
  }
  // An exotic or unexpectedly deep prototype chain is not a supported RPC value.
  return current !== null;
}

function isRemoteStub(value: unknown): value is RpcCapability & {
  dup(): RpcCapability;
  [Symbol.dispose](): void;
} {
  return value instanceof nativeRpcStubRuntime || value instanceof capnRpcStubRuntime;
}

function chargeHeaders(headers: Headers, budget: TraversalBudget): void {
  for (let [name, value] of headers) {
    charge(budget, stringBytes(name) + stringBytes(value));
  }
}

function wrapAtomicValue(value: object, budget: TraversalBudget): object | undefined {
  let proto = Object.getPrototypeOf(value);
  if (proto === Date.prototype) {
    charge(budget, 8);
    return value;
  }
  if (proto === RegExp.prototype) {
    let expression = value as RegExp;
    charge(budget, stringBytes(expression.source) + stringBytes(expression.flags));
    return value;
  }
  if (proto === URL.prototype) {
    charge(budget, stringBytes((value as URL).href));
    return value;
  }
  if (proto === ArrayBuffer.prototype) {
    charge(budget, (value as ArrayBuffer).byteLength);
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (!serializableViewPrototypes.has(proto)) {
      throw new Error("RPC value contains an unsupported custom ArrayBuffer view.");
    }
    charge(budget, value.byteLength);
    return value;
  }
  if (proto === Blob.prototype) {
    let blob = value as Blob;
    charge(budget, blob.size + stringBytes(blob.type));
    return value;
  }
  if (proto === Headers.prototype) {
    charge(budget);
    chargeHeaders(value as Headers, budget);
    return value;
  }
  if (proto === Request.prototype) {
    let request = value as Request;
    let requestMetadata = request as unknown as {
      referrer?: unknown;
      referrerPolicy?: unknown;
      mode?: unknown;
      credentials?: unknown;
      destination?: unknown;
    };
    if (request.body !== null) {
      throw new Error("RPC value contains a request body that cannot be revalidated after return.");
    }
    charge(budget,
        optionalStringBytes(request.method) + optionalStringBytes(request.url) +
        optionalStringBytes(requestMetadata.referrer) +
        optionalStringBytes(requestMetadata.referrerPolicy) +
        optionalStringBytes(requestMetadata.mode) +
        optionalStringBytes(requestMetadata.credentials) +
        optionalStringBytes(request.cache) + optionalStringBytes(request.redirect) +
        optionalStringBytes(request.integrity) +
        optionalStringBytes(requestMetadata.destination));
    chargeHeaders(request.headers, budget);
    return value;
  }
  if (proto === Response.prototype) {
    let response = value as Response;
    if (response.body !== null) {
      throw new Error("RPC value contains a response body that cannot be revalidated after return.");
    }
    let webSocket = (response as Response & {webSocket?: unknown}).webSocket;
    if (webSocket !== undefined && webSocket !== null) {
      throw new Error("RPC value contains a WebSocket response that cannot be revalidated after return.");
    }
    charge(budget,
        8 + optionalStringBytes(response.statusText) + optionalStringBytes(response.url) +
        optionalStringBytes(response.type));
    chargeHeaders(response.headers, budget);
    return value;
  }
  if (value instanceof ReadableStream || value instanceof WritableStream) {
    throw new Error("RPC value contains a stream that cannot be revalidated after return.");
  }
  if (value instanceof Error) {
    // Error.cause, AggregateError.errors, and enumerable properties are recursively serialized by
    // Cap'n Web and can hide capabilities. Returned errors-as-data are unusual, so reject them.
    throw new Error("RPC value contains an Error object with unsupported nested state.");
  }
  return undefined;
}

function makeChildMembrane(
    value: RpcCapability,
    revalidate: Revalidate,
    direction: TransferDirection,
    rpcResultContainerOwnsCapabilities: boolean,
    transferredSources: Array<() => void>,
    owned: Array<() => void>): NativeRpcStub<RpcTarget> {
  let target: RpcCapability;
  let disposeTarget: (() => void) | undefined;
  if (isRemoteStub(value)) {
    // Parameter stubs are borrowed and result stubs are transferred, but in both cases the source
    // reference may be released when the enclosing RPC settles. Hold an independent reference.
    target = value.dup();
    disposeTarget = () => dispose(target);
    if (direction === "result" && !rpcResultContainerOwnsCapabilities) {
      transferredSources.push(() => dispose(value));
    }
  } else {
    target = value;
    // A local target returned by a provider transfers ownership to us. A local callback argument
    // remains owned by its caller and must never be disposed by the membrane.
    if (direction === "result") disposeTarget = () => dispose(target);
  }

  let child = makeRevalidatingRpcStub(() => target, revalidate, disposeTarget);
  let released = false;
  owned.push(() => {
    if (released) return;
    released = true;
    child[Symbol.dispose]();
  });
  return child;
}

function wrapRpcValue(
    value: unknown,
    revalidate: Revalidate,
    direction: TransferDirection,
    rpcResultContainerOwnsCapabilities: boolean,
    transferredSources: Array<() => void>,
    budget: TraversalBudget,
    ancestors: Set<object>,
    owned: Array<() => void>,
    depth: number): unknown {
  if (depth > MAX_RPC_DEPTH) {
    throw new Error("RPC value exceeds the revalidation membrane's nesting limit.");
  }

  if (value === null || value === undefined) {
    charge(budget);
    return value;
  }
  if (typeof value === "string") {
    charge(budget, stringBytes(value));
    return value;
  }
  if (typeof value === "number") {
    charge(budget, 8);
    return value;
  }
  if (typeof value === "bigint") {
    // Cap'n Proto's primitive integer space is bounded. Reject arbitrary-precision values before
    // their wire representation can bypass the byte budget.
    if (value < MIN_RPC_BIGINT || value > MAX_RPC_BIGINT) {
      throw new Error("RPC value contains an out-of-range bigint.");
    }
    charge(budget, 8);
    return value;
  }
  if (typeof value === "boolean") {
    charge(budget, 1);
    return value;
  }
  if (typeof value === "symbol") {
    throw new Error("RPC value contains an unsupported symbol.");
  }

  if (hasThenMethod(value)) {
    // Cap'n Web normally resolves RpcPromises in message trees and native Workers RPC rejects them
    // in parameters. Never turn an unexpected pending capability into a non-thenable wrapper.
    if (direction === "result") transferredSources.push(() => dispose(value));
    throw new Error("RPC value contains an unsupported thenable.");
  }

  if (isRemoteStub(value) || value instanceof RpcTarget || typeof value === "function") {
    charge(budget);
    return makeChildMembrane(
        value as RpcCapability, revalidate, direction,
        rpcResultContainerOwnsCapabilities, transferredSources, owned);
  }

  let atomic = wrapAtomicValue(value, budget);
  if (atomic !== undefined) return atomic;

  if (ancestors.has(value)) {
    // Cap'n Web messages are trees. Reject a cycle here instead of accidentally leaving a
    // capability behind an unvisited edge or relying on a later serializer failure.
    throw new Error("RPC value contains a cyclic value.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("RPC value contains an unsupported custom array.");
      }
      charge(budget);
      if (value.length > MAX_RPC_NODES - budget.nodes) {
        throw new Error("RPC value exceeds the revalidation membrane's size limit.");
      }
      let enumerated = 0;
      for (let key in value) {
        if (++enumerated > MAX_RPC_NODES) {
          throw new Error("RPC value exceeds the revalidation membrane's size limit.");
        }
        if (!Object.hasOwn(value, key)) continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new Error("RPC value contains an array with unsupported custom properties.");
        }
        let descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("RPC value contains an unsupported accessor property.");
        }
      }
      let result: unknown[] = [];
      result.length = value.length;
      for (let i = 0; i < value.length; i++) {
        let descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          throw new Error("RPC value contains an unsupported accessor property.");
        }
        result[i] = wrapRpcValue(
            descriptor.value, revalidate, direction, rpcResultContainerOwnsCapabilities,
            transferredSources,
            budget, ancestors, owned, depth + 1);
      }
      return result;
    }

    if (!isPlainObject(value)) {
      // Map/Set and application-defined containers can hide capabilities behind entries, accessors,
      // or prototype state. Neither is part of the Cap'n Web wire format used by this application.
      throw new Error("RPC value contains an unsupported non-plain container.");
    }

    charge(budget);
    let result: Record<string, unknown> = {};
    let enumerated = 0;
    for (let key in value) {
      if (++enumerated > MAX_RPC_NODES) {
        throw new Error("RPC value exceeds the revalidation membrane's size limit.");
      }
      if (!Object.hasOwn(value, key)) continue;
      let descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("RPC value contains an unsupported accessor property.");
      }
      charge(budget, stringBytes(key));
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrapRpcValue(
            descriptor.value, revalidate, direction, rpcResultContainerOwnsCapabilities,
            transferredSources,
            budget, ancestors, owned, depth + 1),
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function releaseAll(releases: Array<() => void>): void {
  for (let release of releases) {
    try {
      release();
    } catch {
      // Cleanup is best-effort and must never replace the provider result or authority failure.
    }
  }
  releases.length = 0;
}

function sanitizedError(error: unknown): Error {
  try {
    if (!(error instanceof Error)) return new Error("Provider RPC call failed.");
    let message = Object.getOwnPropertyDescriptor(error, "message");
    let messageText = message && "value" in message && typeof message.value === "string" &&
        stringBytes(message.value) <= 64 * 1024
      ? message.value
      : "Provider RPC call failed.";
    let result = new Error(messageText);
    let name = Object.getOwnPropertyDescriptor(error, "name");
    if (name && "value" in name && typeof name.value === "string" &&
        stringBytes(name.value) <= 1024) {
      result.name = name.value;
    }
    let propertyCount = 0;
    let propertyBytes = 0;
    for (let key in error) {
      if (++propertyCount > 32) break;
      if (!Object.hasOwn(error, key)) continue;
      let descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor || !("value" in descriptor)) continue;
      let value = descriptor.value;
      if (value === null || value === undefined ||
          typeof value === "string" || typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint" && value >= MIN_RPC_BIGINT && value <= MAX_RPC_BIGINT) {
        propertyBytes += stringBytes(key) +
            (typeof value === "string" ? stringBytes(value) : 8);
        if (propertyBytes > 64 * 1024) break;
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
    }
    return result;
  } catch {
    return new Error("Provider RPC call failed.");
  }
}

async function revalidateAfterProviderOutcome(revalidate: Revalidate): Promise<void> {
  try {
    await revalidate();
  } catch {
    // A provider error can contain resource data in its message or custom fields. Once authority
    // is gone, reveal neither that error nor policy internals observed during the post-call check.
    throw new Error("RPC capability is no longer available.");
  }
}

async function forwardCall(
    resolveTarget: () => RpcCapability | Promise<RpcCapability>,
    revalidate: Revalidate,
    options: MembraneOptions,
    prop: string | undefined,
    args: unknown[]): Promise<unknown> {
  let target: RpcCapability | undefined;
  let sourceResult: unknown;
  let argumentOwnership: Array<() => void> = [];
  let resultOwnership: Array<() => void> = [];
  let transferredResultSources: Array<() => void> = [];
  let resultHasRpcContainer = false;
  try {
    target = await resolveTarget();
    resultHasRpcContainer = options.resultOwnership === "rpc-container" || isRemoteStub(target);
    let forwardedArgs = wrapRpcValue(
        args, revalidate, "argument", false, [],
        {nodes: 0, bytes: 0}, new Set(), argumentOwnership, 0) as
        unknown[];
    // Target resolution and argument preparation may await. Check at the last point before the
    // provider call, then again after either outcome before releasing provider-derived data.
    await revalidate();
    try {
      sourceResult = await callCapability(target, prop, forwardedArgs);
    } catch (providerError) {
      await revalidateAfterProviderOutcome(revalidate);
      throw sanitizedError(providerError);
    }

    let result: unknown;
    try {
      result = wrapRpcValue(
          sourceResult, revalidate, "result", resultHasRpcContainer,
          transferredResultSources, {nodes: 0, bytes: 0}, new Set(),
          resultOwnership, 0);
    } catch (resultError) {
      await revalidateAfterProviderOutcome(revalidate);
      throw resultError;
    }
    await revalidateAfterProviderOutcome(revalidate);

    // An RPC response owns its original returned stubs. Child membranes hold dup()s, so release
    // the response container without invalidating the guarded copies.
    releaseAll(transferredResultSources);
    if (resultHasRpcContainer) dispose(sourceResult);
    resultOwnership.length = 0;
    return result;
  } catch (error) {
    releaseAll(resultOwnership);
    releaseAll(transferredResultSources);
    if (resultHasRpcContainer) dispose(sourceResult);
    throw sanitizedError(error);
  } finally {
    // A provider retaining a callback must dup() it. Releasing these handles after the call leaves
    // only correctly-retained provider references and frees all one-shot wrappers.
    releaseAll(argumentOwnership);
    if (options.disposeResolvedTarget) dispose(target);
  }
}

/**
 * Wrap a provider-owned capability in a recursive, reacquisition-safe membrane. The policy callback
 * runs immediately before every provider call and again before its result or error is released.
 * Capabilities nested in arguments or results get child membranes with the same policy, including
 * capabilities returned by earlier child calls.
 *
 * `resolveTarget` may return either a local RpcTarget/function or a remote stub. Local targets are
 * never duped; remote child stubs are duped explicitly and owned by their child membrane.
 */
export function makeRevalidatingRpcStub(
    resolveTarget: () => RpcCapability | Promise<RpcCapability>,
    revalidate: Revalidate,
    disposeTarget?: () => void,
    options: MembraneOptions = {}): NativeRpcStub<RpcTarget> {
  let disposed = false;
  let disposeRoot = () => {
    if (disposed) return;
    disposed = true;
    try {
      disposeTarget?.();
    } catch {
      // Best-effort cleanup; the capability is locally dead regardless of provider behavior.
    }
  };

  return new NativeRpcStub(new Proxy((() => {}) as Callable, {
    apply(_target, _thisArg, args: unknown[]) {
      if (disposed) throw new Error("RPC capability has been disposed.");
      return forwardCall(resolveTarget, revalidate, options, undefined, args);
    },
    get(_target, prop) {
      if (prop === Symbol.dispose) return disposeRoot;
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (...args: unknown[]) => {
        if (disposed) throw new Error("RPC capability has been disposed.");
        return forwardCall(resolveTarget, revalidate, options, prop, args);
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }) as Callable & RpcTarget);
}
