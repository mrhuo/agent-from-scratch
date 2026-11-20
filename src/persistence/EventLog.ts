import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionEvent, SessionEventInput } from "./types.js";

/**
 * 只追加的事件日志。
 *
 * 三个刻意的选择：
 *  1. **同步追加**：appendFileSync 在返回前已把字节交给内核。异步 writeFile
 *     会在进程被强杀时丢掉缓冲区里的数据，而事件日志的价值正在于「最后一条也在」。
 *  2. **自带序号**：seq 由日志自己分配，恢复时按 seq 切掉快照已覆盖的部分。
 *     用文件大小或行号做切点都不可靠——日志轮转、撕裂行都会让行号漂移。
 *  3. **读时容错**：进程可能在写一行写到一半时被杀。这种尾行 JSON 解析失败，
 *     跳过即可；整份日志不能因为最后 3 个字节而读不出来。
 */
export class EventLog {
  readonly file: string;
  private lastSeq = 0;

  constructor(file: string) {
    this.file = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const all = this.readAll();
    this.lastSeq = all.length > 0 ? all[all.length - 1]!.seq : 0;
  }

  get currentSeq(): number {
    return this.lastSeq;
  }

  /** 追加一条事件，返回带 seq 与 ts 的完整事件 */
  append(input: SessionEventInput): SessionEvent {
    const event = {
      ...input,
      seq: this.lastSeq + 1,
      ts: new Date().toISOString(),
    } as SessionEvent;
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    // 只有写盘成功才推进序号：写失败时序号不变，下一次可以重试同号事件。
    this.lastSeq = event.seq;
    return event;
  }

  /** 读全部有效事件；解析失败的行与序号不连续的行都跳过 */
  readAll(): SessionEvent[] {
    if (!existsSync(this.file)) return [];
    const out: SessionEvent[] = [];
    let expected = 1;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        const event = JSON.parse(text) as SessionEvent;
        if (
          typeof event !== "object" ||
          event === null ||
          typeof event.seq !== "number" ||
          typeof event.type !== "string"
        ) {
          continue;
        }
        // 序号严格递增：撕裂行写坏后，后续事件即使存在也不能接上一个断裂点。
        if (event.seq !== expected) continue;
        out.push(event);
        expected += 1;
      } catch {
        // 半行：跳过。下一行若序号接续得上，仍可恢复。
      }
    }
    return out;
  }

  /** 只读 seq 大于 after 的事件 */
  since(after: number): SessionEvent[] {
    return this.readAll().filter((e) => e.seq > after);
  }
}
