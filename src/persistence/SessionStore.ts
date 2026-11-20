import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventLog } from "./EventLog.js";
import {
  SCHEMA_VERSION,
  type SessionEvent,
  type SessionEventInput,
  type SessionMeta,
  type SessionSnapshot,
  type SessionStatus,
} from "./types.js";

/**
 * 会话存储：一份快照 + 一条事件日志。
 *
 * 为什么不只写快照：每次工具调用都把整段对话重写一遍，写放大严重，而且
 * 进程恰好在 rename 前后崩溃时，可能连最后一句都丢。
 * 为什么不只写日志：每次启动都从空消息重放几百轮，恢复时间与会话长度成正比。
 * 组合起来：快照是「定期存档点」，事件是「存档点之后的增量」。
 */
export class SessionStore {
  readonly dir: string;
  readonly sessionId: string;
  readonly log: EventLog;
  readonly snapshotPath: string;
  readonly backupPath: string;

  constructor(options: { dir: string; sessionId?: string; model?: string }) {
    this.dir = join(options.dir, options.sessionId ?? randomUUID());
    mkdirSync(this.dir, { recursive: true });
    this.sessionId = options.sessionId ?? this.dir.split(/[\\/]/).pop()!;
    this.snapshotPath = join(this.dir, "snapshot.json");
    this.backupPath = join(this.dir, "snapshot.json.bak");
    this.log = new EventLog(join(this.dir, "events.jsonl"));
    if (!this.loadSnapshot()) {
      // 第一次见面：先写一份空快照，保证任何时候磁盘上都有可用的起点。
      const now = new Date().toISOString();
      const meta: SessionMeta = {
        id: this.sessionId,
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        status: "active",
        model: options.model,
      };
      this.saveSnapshot({
        schemaVersion: SCHEMA_VERSION,
        meta,
        lastSeq: this.log.currentSeq,
        messages: [],
        pending: [],
        toolResults: {},
      });
    }
  }

  append(input: SessionEventInput): SessionEvent {
    return this.log.append(input);
  }

  /** 当前状态：以事件日志里最后一条 status 为准，快照不带这个瞬时信息 */
  status(): SessionStatus {
    const events = this.log.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "status") return e.status;
    }
    return this.loadSnapshot()?.meta.status ?? "active";
  }

  mark(status: SessionStatus, reason?: string): SessionEvent {
    return this.append({ type: "status", status, reason });
  }

  /**
   * 原子写快照：先写 .tmp，再 rename 覆盖正式文件。
   * rename 在同一文件系统上是原子的，进程在任意时刻被杀，正式文件非旧即新。
   * 覆盖前把旧快照挪到 .bak，多一层回滚机会。
   */
  saveSnapshot(snapshot: SessionSnapshot): void {
    const payload = JSON.stringify(snapshot, null, 2);
    const tmp = `${this.snapshotPath}.tmp`;
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    writeFileSync(tmp, payload, "utf8");
    if (existsSync(this.snapshotPath)) {
      try {
        renameSync(this.snapshotPath, this.backupPath);
      } catch {
        // 备份失败不影响主流程，正式文件仍可覆盖
      }
    }
    renameSync(tmp, this.snapshotPath);
  }

  /** 加载快照；主文件坏了就退到备份，两份都坏返回 undefined（由事件日志全量重放） */
  loadSnapshot(): SessionSnapshot | undefined {
    for (const file of [this.snapshotPath, this.backupPath]) {
      if (!existsSync(file)) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionSnapshot;
        if (this.isValid(parsed)) return parsed;
      } catch {
        // 换下一个候选
      }
    }
    return undefined;
  }

  /** 快照 + 后续事件，交给 restoreSession 重放 */
  load(): { snapshot: SessionSnapshot | undefined; events: SessionEvent[] } {
    const snapshot = this.loadSnapshot();
    const events = this.log.since(snapshot?.lastSeq ?? 0);
    return { snapshot, events };
  }

  /** 丢掉整个会话（只删本会话目录，不碰其他会话） */
  drop(): void {
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
  }

  /** 列出某个根目录下所有会话的摘要 */
  static list(dir: string): Array<{ id: string; status: SessionStatus; updatedAt: string }> {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const store = new SessionStore({ dir, sessionId: d.name });
        const snap = store.loadSnapshot();
        return {
          id: d.name,
          status: store.status(),
          updatedAt: snap?.meta.updatedAt ?? "",
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return entries;
  }

  private isValid(s: unknown): s is SessionSnapshot {
    if (!s || typeof s !== "object") return false;
    const x = s as Partial<SessionSnapshot>;
    return (
      x.schemaVersion === SCHEMA_VERSION &&
      typeof x.lastSeq === "number" &&
      Array.isArray(x.messages) &&
      Array.isArray(x.pending) &&
      !!x.meta &&
      typeof x.meta.id === "string"
    );
  }
}

