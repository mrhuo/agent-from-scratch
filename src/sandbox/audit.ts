import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent, AuditLog } from "./types.js";

/**
 * 审计日志：每一次授权决策都要留痕。
 *
 * 沙箱解决的是「事前不让他做」，审计解决的是「事后说得清」。
 * 没有审计的权限系统一旦出事，只能靠猜——而猜的结论通常不可信。
 *
 * 两条硬要求：
 *  1. **只追加**：不提供修改与删除接口。日志被改过，就不再是证据。
 *  2. **写失败不阻断主流程**：审计写盘失败要报错到 stderr，但不能因此
 *     让 Agent 的正常工具调用跟着失败——否则攻击者只要把磁盘写满
 *     就能让沙箱整体失效（拒绝服务）。
 *     折中做法：记录到 stderr，保证有痕迹，但不让业务停摆。
 */

/** 内存审计日志：测试与演示用 */
export class MemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }

  list(): AuditEvent[] {
    return [...this.events];
  }
}

export interface FileAuditLogOptions {
  /** 日志文件路径 */
  file: string;
  /** 参数摘要的最大长度，默认 400 */
  maxArgsLength?: number;
  /** 写失败时的输出流，默认 stderr */
  errorStream?: NodeJS.WritableStream;
}

/** 文件审计日志：JSONL，一行一个事件，追加写入 */
export class FileAuditLog implements AuditLog {
  readonly file: string;
  private readonly maxArgsLength: number;
  private readonly errorStream: NodeJS.WritableStream;
  /** 内存镜像：list() 直接读它，不必每次读盘 */
  private readonly cache: AuditEvent[] = [];

  constructor(options: FileAuditLogOptions) {
    this.file = options.file;
    this.maxArgsLength = options.maxArgsLength ?? 400;
    this.errorStream = options.errorStream ?? process.stderr;
    const dir = dirname(this.file);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        this.errorStream.write(`[审计] 无法创建日志目录 ${dir}：${String(err)}\n`);
      }
    }
  }

  record(event: AuditEvent): void {
    this.cache.push(event);
    try {
      const line = `${JSON.stringify({
        ...event,
        args: this.truncate(event.args),
      })}\n`;
      appendFileSync(this.file, line, "utf8");
    } catch (err) {
      // 写盘失败：留痕但不阻断
      this.errorStream.write(
        `[审计] 写入 ${this.file} 失败：${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  list(): AuditEvent[] {
    return [...this.cache];
  }

  /** 读取日志文件里的全部事件（进程重启后仍可回溯） */
  readAll(): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    const out: AuditEvent[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AuditEvent);
      } catch {
        // 写了一半的行（进程被强杀）跳过，不让整份日志读不出来
      }
    }
    return out;
  }

  private truncate(s: string): string {
    return s.length > this.maxArgsLength ? `${s.slice(0, this.maxArgsLength)}…` : s;
  }
}
