import { readFileSync, writeFileSync } from "node:fs";
import type { MCPServerTool } from "./server.js";

/**
 * 「任务看板」MCP 服务：一个典型的外部有状态服务。
 *
 * 选它做演示对象是有意的——前三篇的本地工具（readFile / searchFiles / webFetch）
 * 都是**无状态**的：调完即走，不留痕迹。而外部服务的典型特征恰恰是：
 *  - **有状态**：调 addTask 之后，list_tasks 能看到新增的那一条；
 *  - **有业务约束**：状态只能从 todo 流转到 done，不能倒退；
 *  - **schema 更复杂**：带枚举、带默认值、带可选字段。
 *
 * 这些特征正是本地工具教不会的东西，也是「接外部世界」真正的价值所在。
 */

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface BoardTask {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
}

/** 看板状态：内存里一份，同时落盘持久化，重启不丢 */
export class TaskBoard {
  private tasks: BoardTask[] = [];
  private nextId = 1;

  constructor(private readonly filePath?: string) {
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { tasks?: BoardTask[]; nextId?: number };
      this.tasks = parsed.tasks ?? [];
      this.nextId = parsed.nextId ?? this.tasks.length + 1;
    } catch {
      // 文件不存在或损坏：从空看板开始
      this.tasks = [];
      this.nextId = 1;
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      writeFileSync(this.filePath, JSON.stringify({ tasks: this.tasks, nextId: this.nextId }, null, 2), "utf8");
    } catch (err) {
      // 落盘失败不影响本次调用的内存结果，但必须留下痕迹——
      // 静默吞掉会让「状态没存上」这类问题无从排查
      process.stderr.write(
        `[taskboard] 落盘失败：${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  list(status?: TaskStatus): BoardTask[] {
    const all = this.tasks;
    const filtered = status ? all.filter((t) => t.status === status) : all;
    return filtered.sort((a, b) => a.id - b.id);
  }

  add(title: string, priority: TaskPriority = "medium"): BoardTask {
    const task: BoardTask = {
      id: this.nextId++,
      title,
      status: "todo",
      priority,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  /** 完成一个任务；若已完成则抛错（业务约束） */
  complete(id: number): BoardTask {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务 #${id} 不存在`);
    if (task.status === "done") throw new Error(`任务 #${id} 已经完成过了`);
    task.status = "done";
    this.save();
    return task;
  }

  search(query: string): BoardTask[] {
    const q = query.toLowerCase();
    return this.tasks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.status.includes(q),
    );
  }
}

/** 把看板包装成 MCP 工具清单 */
export function createBoardTools(board: TaskBoard): MCPServerTool[] {
  return [
    {
      name: "list_tasks",
      description:
        "列出看板上的任务。可按状态筛选（todo / doing / done）；不传状态则返回全部任务。" +
        "返回按任务编号升序排列的列表，每条包含 id、标题、状态、优先级、创建时间。",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["todo", "doing", "done"],
            description: "可选的状态筛选条件；省略则返回全部",
          },
        },
        required: [],
      },
      handler: (args) => {
        const status = args.status as TaskStatus | undefined;
        const tasks = board.list(status);
        if (tasks.length === 0) {
          return status ? `看板里没有状态为 ${status} 的任务。` : "看板是空的，还没有任务。";
        }
        return tasks
          .map((t) => `#${t.id} [${t.status}/${t.priority}] ${t.title}（创建于 ${t.createdAt}）`)
          .join("\n");
      },
    },
    {
      name: "add_task",
      description:
        "在看板里新增一条任务。任务初始状态为 todo。需要给出任务标题；" +
        "优先级可选 low / medium / high，默认 medium。返回新建任务的编号与标题。",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "任务标题，一句话说清要做什么",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "优先级，默认 medium",
          },
        },
        required: ["title"],
      },
      handler: (args) => {
        const title = String(args.title ?? "").trim();
        if (!title) throw new Error("任务标题不能为空");
        const priority = (args.priority as TaskPriority) ?? "medium";
        const task = board.add(title, priority);
        return `已创建任务 #${task.id}：${task.title}（优先级 ${task.priority}，状态 ${task.status}）`;
      },
    },
    {
      name: "complete_task",
      description:
        "把指定编号的任务标记为完成。任务不存在或已经完成过时会报错。返回完成后的任务状态。",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "要完成的任务编号（整数）",
          },
        },
        required: ["id"],
      },
      handler: (args) => {
        const id = Number(args.id);
        if (!Number.isInteger(id)) throw new Error("任务编号必须是整数");
        const task = board.complete(id);
        return `任务 #${task.id}「${task.title}」已完成，当前状态 ${task.status}`;
      },
    },
    {
      name: "search_tasks",
      description: "按关键词在任务标题里搜索，或按状态关键词过滤，返回匹配的任务列表。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词；为空时返回全部任务",
          },
        },
        required: ["query"],
      },
      handler: (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) {
          return board
            .list()
            .map((t) => `#${t.id} [${t.status}] ${t.title}`)
            .join("\n");
        }
        const hits = board.search(query);
        if (hits.length === 0) return `没有匹配「${query}」的任务。`;
        return hits.map((t) => `#${t.id} [${t.status}/${t.priority}] ${t.title}`).join("\n");
      },
    },
  ];
}
