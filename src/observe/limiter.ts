import { DeadlineExceededError } from "./deadline.js";

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * FIFO 信号量。
 *
 * 为什么不用简单的「计数 + 随机唤醒」：并发请求若平均等待时间差很多，
 * 后到的请求可能先跑， tails 延迟不可预测。队列先进先出，
 * 指标里的「排队耗时」才有稳定含义。
 *
 * 排队也有截止时间。请求在队列里等待过久，直接失败并返回明确状态，
 * 比「排了 30 秒才跑到、再由模型层超时」更容易定位瓶颈。
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("Semaphore.max 必须是 >= 1 的整数");
    }
  }

  get stats(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }

  async acquire(waitTimeoutMs?: number): Promise<{ release: () => void; waitedMs: number }> {
    const enqueuedAt = Date.now();
    if (this.active < this.max && this.waiters.length === 0) {
      this.active += 1;
      return { release: () => this.release(), waitedMs: 0 };
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, enqueuedAt };
      if (waitTimeoutMs !== undefined && waitTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new DeadlineExceededError("并发队列等待", waitTimeoutMs));
        }, waitTimeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });

    return { release: () => this.release(), waitedMs: Date.now() - enqueuedAt };
  }

  /** 自动释放的包装；异常路径也在 finally 里释放 */
  async run<T>(fn: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
    const { release, waitedMs } = await this.acquire(waitTimeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    if (next.timer) clearTimeout(next.timer);
    // 名额直接交接给队首：active 不变，避免中间出现「空位被后到者抢占」
    next.resolve();
  }
}
