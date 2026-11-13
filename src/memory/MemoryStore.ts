import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 一条长期记忆。
 *
 * 与「短期记忆」（一段对话的上下文）不同，长期记忆存活在进程之外——
 * 写进文件，下次启动还能读出来。这正是 Agent「失忆」与「跨会话记住你」
 * 这两个体感背后的区别。
 */
export interface MemoryEntry {
  /** 唯一 id，便于后续更新 / 删除 */
  id: string;
  /** 简短主题，例如「用户的名字」「项目代号」 */
  key: string;
  /** 要记住的具体内容 */
  content: string;
  /** 写入时间，ISO 字符串，用于排序与去重 */
  createdAt: string;
}

/**
 * 长期记忆存储：用一份 JSON 文件当「大脑外的笔记本」。
 *
 * 设计取舍：
 *  - 零依赖：只动 node:fs，不引数据库；单文件足够演示「持久化」本质。
 *  - 全量读写：文件通常很小（几百条以内），每次 save 都重写整份，
 *    逻辑简单、不易出并发脏写；真要上量再换 SQLite / 向量库。
 *  - 检索是关键词命中打分，不是语义向量；够用在「记得住、想得起来」，
 *    语义检索留到第 11 篇之后按需替换。
 */
export class MemoryStore {
  constructor(private readonly path: string) {}

  /** 读出全部记忆；文件不存在或解析失败都当作空库，不让读盘错误崩掉 Agent */
  async load(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // 只认长得像 MemoryEntry 的项，脏数据自动过滤
      return parsed.filter(
        (e): e is MemoryEntry =>
          !!e && typeof e === "object" && "id" in e && "key" in e && "content" in e,
      );
    } catch {
      return [];
    }
  }

  /** 记住一条新事实，返回写盘后的完整条目 */
  async save(key: string, content: string): Promise<MemoryEntry> {
    const entries = await this.load();
    const entry: MemoryEntry = {
      id: randomUUID(),
      key,
      content,
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    await this.persist(entries);
    return entry;
  }

  /** 更新某条记忆的主题或内容；找不到返回 false */
  async update(id: string, patch: { key?: string; content?: string }): Promise<boolean> {
    const entries = await this.load();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const cur = entries[idx]!;
    entries[idx] = {
      ...cur,
      key: patch.key ?? cur.key,
      content: patch.content ?? cur.content,
    };
    await this.persist(entries);
    return true;
  }

  /** 删除某条记忆；找不到返回 false */
  async remove(id: string): Promise<boolean> {
    const entries = await this.load();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    await this.persist(next);
    return true;
  }

  /**
   * 关键词检索：把 query 拆成 token，逐条统计命中数，按命中数降序返回前 limit 条。
   * 空 query 表示「全部翻出来」，返回最近 limit 条（倒序）。
   *
   * 分词对中文做了特殊处理：中文没有空格，按空白切会整句成一个 token、几乎永远
   * 匹配不上。这里把 ASCII 词原样取出，把连续中文字符切成二元组（bigram），
   * 这样既保留英文单词的精确匹配，又能让「小明喜欢什么语言」里的「小明」命中
   * 一条主题叫「用户的名字」的记忆。
   */
  async search(query: string, limit = 5): Promise<MemoryEntry[]> {
    const entries = await this.load();
    const q = query.trim().toLowerCase();
    if (!q) {
      return entries.slice(-limit).reverse();
    }
    const tokens = tokenize(q);
    if (tokens.length === 0) return [];
    return entries
      .map((e) => {
        const hay = `${e.key} ${e.content}`.toLowerCase();
        const score = tokens.reduce((s, t) => (hay.includes(t) ? s + 1 : s), 0);
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.e.createdAt.localeCompare(a.e.createdAt),
      )
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** 原子地整份写回磁盘：先建目录，再写文件。写失败有限重试，避免瞬时错误丢数据 */
  private async persist(entries: MemoryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const payload = JSON.stringify(entries, null, 2);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(this.path, payload, "utf8");
        return;
      } catch (err) {
        lastErr = err;
        // 偶发瞬时写错误（受限环境权限抖动、磁盘瞬时不可用）重试一次
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/**
 * 中英文混合分词：ASCII 词原样保留，连续中文字符切成二元组。
 * 例：「小明喜欢 TypeScript」→ ["小明","明喜","喜欢","type","script"]
 */
function tokenize(s: string): string[] {
  const ascii = s.match(/[a-z0-9]+/g) ?? [];
  const cjkRuns = s.match(/[一-鿿]+/g) ?? [];
  const cjk: string[] = [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      cjk.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        cjk.push(run.slice(i, i + 2));
      }
    }
  }
  return [...ascii, ...cjk];
}
