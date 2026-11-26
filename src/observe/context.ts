import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * 一次请求的观测上下文。
 *
 * 为什么用 AsyncLocalStorage 而不是层层传参：Agent Loop 里有 Promise.all 并行工具、
 * 有钩子回调、有 LLM 客户端的内部调用。把 traceId / spanId / signal 手工穿过每一层，
 * 会让前 11 篇的内核布满观测参数。ALS 让「同一个异步调用链」自动共享上下文，
 * 并发请求各自拿到自己的那一份，互不串线。
 */
export interface ObserveContext {
  traceId: string;
  requestId: string;
  /** 当前 span，作为子 span 的 parent */
  spanId?: string;
  /** 本次请求的取消信号；fetch 与循环检查共用同一个 signal */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<ObserveContext>();

/** 16 字节随机 ID，小写十六进制；不携带时间或机器信息 */
export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function currentContext(): ObserveContext | undefined {
  return storage.getStore();
}

export function withObserveContext<T>(ctx: ObserveContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 派生子上下文：继承 traceId 与 signal，只替换当前 span */
export function childContext(spanId: string): ObserveContext {
  const parent = currentContext();
  return {
    traceId: parent?.traceId ?? newId(),
    requestId: parent?.requestId ?? newId(),
    spanId,
    signal: parent?.signal,
  };
}

/** 无上下文时的兜底：单独造一条 trace，保证任何入口产生的 span 都可查询 */
export function ensureContext(): ObserveContext {
  return currentContext() ?? { traceId: newId(), requestId: newId() };
}
