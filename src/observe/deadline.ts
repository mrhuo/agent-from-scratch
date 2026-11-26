/** 超时不是「等一会儿看看」，而是真的把取消信号送到还在跑的 I/O 上 */
export class DeadlineExceededError extends Error {
  readonly label: string;
  readonly limitMs: number;

  constructor(label: string, limitMs: number) {
    super(`${label} 超过 ${limitMs}ms 截止时间`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.limitMs = limitMs;
  }
}

export function isDeadlineExceeded(err: unknown): err is DeadlineExceededError {
  return err instanceof DeadlineExceededError;
}

/** 已有外部 signal 时，在循环边界主动检查，避免做无用功 */
export function throwIfAborted(signal: AbortSignal | undefined, label = "操作"): void {
  if (signal?.aborted) {
    throw new DeadlineExceededError(label, 0);
  }
}

/**
 * 给一段异步工作设截止时间。
 *
 * 两个动作同时发生：
 *  1. 到点 reject 一个 DeadlineExceededError，调用方拿到明确状态；
 *  2. AbortController.abort() —— LLMClient 把 signal 传给 fetch，真实 HTTP 请求会被取消。
 *
 * 边界必须说清：纯 CPU 或不支持 signal 的第三方调用无法被强制中断，
 * 它们只会在「超时后继续跑到自然结束」，结果被丢弃。因此超时统计只说明
 * 「调用方不再等待」，不等于「服务端停止工作」。
 */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  limitMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    throw new DeadlineExceededError(label, limitMs);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceededError(label, limitMs));
    }, limitMs);
    // 定时器不应阻止进程退出
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 等待固定时长；演示中的慢任务用它模拟外部依赖延迟 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeadlineExceededError("delay", ms));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DeadlineExceededError("delay", ms));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
