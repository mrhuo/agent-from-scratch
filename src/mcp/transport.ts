import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcMessage } from "./protocol.js";

/**
 * 传输层抽象：把「怎么把字节送出去、怎么把字节读回来」与「MCP 语义」分开。
 *
 * MCPClient 只认这个接口，因此测试时可以塞一个假传输（不启子进程），
 * 也便于将来加 HTTP / SSE 传输而不改客户端逻辑。
 */
export interface Transport {
  /** 建立连接（stdio 传输即启动子进程） */
  start(): Promise<void>;
  /** 发一个请求并等待对应响应 */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 发一个通知（不等待响应） */
  notify(method: string, params?: Record<string, unknown>): void;
  /** 关闭连接并释放资源 */
  close(): void;
  /** 子进程标准错误输出（调试用） */
  readonly stderrText: string;
}

/** stdio 传输的启动参数 */
export interface StdioTransportOptions {
  /** 可执行命令，如 "node" 或 "npx" */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 额外环境变量（与 process.env 合并） */
  env?: Record<string, string>;
  /** 单次请求超时（毫秒），默认 30 秒 */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * stdio 传输：把 MCP 服务端作为**子进程**启动，
 * 用「一行一个 JSON」的换行分隔协议在 stdin / stdout 上收发 JSON-RPC 消息。
 *
 * 三个工程细节值得留意：
 *  1. **按行切分**：TCP/管道上的分块是任意的，一次 data 事件可能只到半条消息，
 *     也可能挤进三条消息。必须自己维护缓冲区、按 \n 切分，不能假设「一次 data 一条消息」。
 *  2. **stderr 与 stdout 分离**：服务端把日志打到 stderr 是惯例，
 *     若混进 stdout 就会污染 JSON 流。这里把 stderr 单独收集起来。
 *  3. **子进程退出要有交代**：进程没了却还有请求挂着，调用方会一直等。
 *     这里监听 exit，把所有 pending 请求立刻 reject 掉。
 */
export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly options: Required<Omit<StdioTransportOptions, "env" | "cwd">> &
    Pick<StdioTransportOptions, "env" | "cwd">;

  constructor(options: StdioTransportOptions) {
    this.options = {
      command: options.command,
      args: options.args ?? [],
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
  }

  get stderrText(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: { ...process.env, ...(this.options.env ?? {}) },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // stderr 只做记录，不参与协议
      this.stderr += chunk;
    });

    child.on("error", (err) => this.failAllPending(err));

    child.on("exit", (code, signal) => {
      this.failAllPending(
        new Error(`MCP 服务端进程已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`),
      );
      this.child = null;
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Transport 未启动，无法发送请求"));

    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0" as const,
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${this.options.timeoutMs}ms）：${method}`));
      }, this.options.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.write(JSON.stringify(message));
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const message = {
      jsonrpc: "2.0" as const,
      method,
      ...(params ? { params } : {}),
    };
    this.write(JSON.stringify(message));
  }

  close(): void {
    if (!this.child) return;
    this.failAllPending(new Error("MCP 连接已关闭"));
    try {
      this.child.kill();
    } catch {
      // 进程可能已经退出，忽略
    }
    this.child = null;
  }

  /** 写一行 JSON 并保证换行——协议以行为帧 */
  private write(line: string): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(`${line}\n`);
  }

  /** 收到 stdout 数据：追加进缓冲区，按行切分，逐行解析 */
  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  /** 解析一行 JSON，并把它交给等待中的请求 */
  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // 服务端打印了非 JSON 的东西（例如误把日志写到 stdout），忽略即可
      return;
    }
    if (!("id" in msg)) return; // 通知，无需处理
    const pending = this.pending.get(msg.id);
    if (!pending) return; // 没人等这个 id（比如超时后迟到的响应）
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    const resp = msg as { result?: unknown; error?: { code: number; message: string } };
    if (resp.error) {
      pending.reject(new Error(`MCP 返回错误（${resp.error.code}）：${resp.error.message}`));
    } else {
      pending.resolve(resp.result);
    }
  }

  /** 子进程挂了或连接关闭时，把所有等待中的请求立刻 reject */
  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
