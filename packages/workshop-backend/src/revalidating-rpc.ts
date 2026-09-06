import {RpcTarget} from "capnweb";
import {RpcStub as NativeRpcStub} from "cloudflare:workers";

/**
 * Wrap a provider-owned capability in a root-call membrane. The resolver re-checks live local
 * policy and state immediately before forwarding either a method call or a direct invocation.
 * NativeRpcStub is required because workerd currently treats a top-level Proxy as non-pipelineable.
 */
export function makeRevalidatingRpcStub(
    resolveTarget: () => RpcTarget | Promise<RpcTarget>,
    disposeTarget?: () => void): NativeRpcStub<RpcTarget> {
  return new NativeRpcStub(new Proxy((() => {}) as unknown as RpcTarget, {
    async apply(_target, _thisArg, args: unknown[]) {
      let target = await resolveTarget();
      return Reflect.apply(target as any, undefined, args);
    },
    get(_target, prop) {
      if (prop === Symbol.dispose) return disposeTarget;
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return async (...args: unknown[]) => {
        let target = await resolveTarget();
        return Reflect.apply((target as any)[prop], target, args);
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }));
}
