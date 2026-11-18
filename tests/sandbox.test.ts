import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolRegistry, calculator, type Tool } from "../src/agent/index.js";
import {
  PathSandbox,
  PolicyEngine,
  ToolGuard,
  MemoryAuditLog,
  FileAuditLog,
  StaticApprover,
  DenyAllApprover,
  CallbackApprover,
  SequenceApprover,
  ConsoleApprover,
  strictestOf,
  denyAllPolicy,
  defaultSandboxPolicy,
  defaultFileSandbox,
  getArg,
  toolIs,
  argEquals,
  argIn,
  argMatches,
  argStartsWith,
  argUrlHostIn,
  argPathWithin,
  allOf,
  anyOf,
  not,
  allowRule,
  denyRule,
  askRule,
  type PermissionRequest,
} from "../src/sandbox/index.js";
import {
  createWriteFileTool,
  createDeleteFileTool,
  createRunCommandTool,
} from "../src/tools/dangerous.js";

// ---------------------------------------------------------------- 参数取值

describe("getArg：按路径取参数", () => {
  const args = {
    path: "notes.txt",
    nested: { a: { b: 42 } },
    list: [{ x: 1 }, { x: 2 }],
  };

  it("读取顶层字段", () => {
    expect(getArg(args, "path")).toBe("notes.txt");
  });

  it("读取嵌套字段", () => {
    expect(getArg(args, "nested.a.b")).toBe(42);
  });

  it("读取数组下标", () => {
    expect(getArg(args, "list[1].x")).toBe(2);
  });

  it("路径不存在时返回 undefined 而不是抛错", () => {
    expect(getArg(args, "missing.deep.path")).toBeUndefined();
    expect(getArg(args, "path.too.deep")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 匹配器

describe("参数级匹配器", () => {
  const req = (args: Record<string, unknown>, tool = "demo"): PermissionRequest => ({
    tool,
    args,
  });

  it("toolIs 按工具名精确匹配", () => {
    expect(toolIs("readFile")(req({}, "readFile"))).toBe(true);
    expect(toolIs("readFile")(req({}, "writeFile"))).toBe(false);
  });

  it("argEquals / argIn / argMatches / argStartsWith", () => {
    expect(argEquals("mode", "fast")(req({ mode: "fast" }))).toBe(true);
    expect(argIn("mode", ["fast", "safe"])(req({ mode: "safe" }))).toBe(true);
    expect(argIn("mode", ["fast"])(req({ mode: "slow" }))).toBe(false);
    expect(argMatches("path", /\.txt$/)(req({ path: "a.txt" }))).toBe(true);
    expect(argStartsWith("path", "src/")(req({ path: "src/a.ts" }))).toBe(true);
  });

  it("argUrlHostIn 按域名白名单匹配（支持子域）", () => {
    expect(argUrlHostIn("url", ["example.com"])(req({ url: "https://example.com/a" }))).toBe(true);
    expect(argUrlHostIn("url", ["example.com"])(req({ url: "https://api.example.com/a" }))).toBe(true);
    expect(argUrlHostIn("url", ["example.com"])(req({ url: "https://evil.com/a" }))).toBe(false);
    expect(argUrlHostIn("url", ["example.com"])(req({ url: "not-a-url" }))).toBe(false);
  });

  it("argPathWithin 用路径沙箱判断参数是否在允许范围内", () => {
    const sandbox = new PathSandbox({ roots: [resolve(process.cwd(), "data")] });
    const inside = argPathWithin("path", sandbox);
    expect(inside(req({ path: "notes.txt" }))).toBe(true);
    expect(inside(req({ path: "../.env" }))).toBe(false);
  });

  it("allOf / anyOf / not 组合匹配器", () => {
    const isRead = toolIs("readFile");
    const isTxt = argMatches("path", /\.txt$/);
    expect(allOf(isRead, isTxt)(req({ path: "a.txt" }, "readFile"))).toBe(true);
    expect(allOf(isRead, isTxt)(req({ path: "a.ts" }, "readFile"))).toBe(false);
    expect(anyOf(toolIs("a"), toolIs("b"))(req({}, "b"))).toBe(true);
    expect(not(isRead)(req({}, "writeFile"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 策略引擎

describe("PolicyEngine：顺序求值 + 默认拒绝", () => {
  it("第一条命中的规则决定决策", () => {
    const policy = new PolicyEngine([
      denyRule("d1", "拒绝一切", () => true, "命中第一条"),
      allowRule("a1", "放行一切", () => true),
    ]);
    const d = policy.evaluate({ tool: "x", args: {} });
    expect(d.decision).toBe("deny");
    expect(d.ruleId).toBe("d1");
  });

  it("没有任何规则命中时默认拒绝", () => {
    const policy = new PolicyEngine([allowRule("a1", "只允许 a", toolIs("a"))]);
    const d = policy.evaluate({ tool: "b", args: {} });
    expect(d.decision).toBe("deny");
    expect(d.ruleId).toContain("default");
  });

  it("规则求值抛异常时跳过该规则，且不会放行", () => {
    const errors: string[] = [];
    const policy = new PolicyEngine(
      [
        {
          id: "broken",
          description: "会抛异常的规则",
          decision: "allow",
          when: () => {
            throw new Error("boom");
          },
        },
        allowRule("a1", "放行 a", toolIs("a")),
      ],
      { onRuleError: (id) => errors.push(id) },
    );
    const d = policy.evaluate({ tool: "a", args: {} });
    expect(errors).toContain("broken");
    expect(d.decision).toBe("allow");
    expect(d.ruleId).toBe("a1");
  });

  it("ask 决策会带上规则理由", () => {
    const policy = new PolicyEngine([askRule("q1", "要问人", () => true, "风险较高")]);
    const d = policy.evaluate({ tool: "x", args: {} });
    expect(d.decision).toBe("ask");
    expect(d.reason).toBe("风险较高");
  });
});

describe("strictestOf：多策略合并取最严", () => {
  it("任一层拒绝，整体拒绝", () => {
    const p = strictestOf([
      new PolicyEngine([allowRule("a", "全放行", () => true)]),
      new PolicyEngine([denyRule("d", "全拒绝", () => true)]),
    ]);
    expect(p.evaluate({ tool: "x", args: {} }).decision).toBe("deny");
  });

  it("allow 与 ask 合并为 ask", () => {
    const p = strictestOf([
      new PolicyEngine([allowRule("a", "全放行", () => true)]),
      new PolicyEngine([askRule("q", "全问人", () => true)]),
    ]);
    expect(p.evaluate({ tool: "x", args: {} }).decision).toBe("ask");
  });

  it("某一层策略求值异常时整体按拒绝处理", () => {
    const broken = {
      name: "broken",
      evaluate(): never {
        throw new Error("策略崩了");
      },
    };
    const p = strictestOf([broken, new PolicyEngine([allowRule("a", "全放行", () => true)])]);
    expect(p.evaluate({ tool: "x", args: {} }).decision).toBe("deny");
  });

  it("denyAllPolicy 一律拒绝", () => {
    expect(denyAllPolicy().evaluate({ tool: "x", args: {} }).decision).toBe("deny");
  });
});

// ---------------------------------------------------------------- 路径沙箱

describe("PathSandbox：路径硬边界", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello", "utf8");
  writeFileSync(join(root, "b.exe"), "MZ", "utf8");

  const sandbox = new PathSandbox({ roots: [root], allowedExtensions: [".txt"] });

  it("允许沙箱内的文件", () => {
    const r = sandbox.check("a.txt");
    expect(r.ok).toBe(true);
  });

  it("拒绝 ../ 越权路径", () => {
    const r = sandbox.check("../secret.txt");
    expect(r.ok).toBe(false);
  });

  it("拒绝绝对路径（不在沙箱内）", () => {
    const r = sandbox.check(resolve(root, "..", "..", "etc", "passwd"));
    expect(r.ok).toBe(false);
  });

  it("拒绝扩展名不在白名单的文件", () => {
    const r = sandbox.check("b.exe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/白名单/);
  });

  it("拒绝指向沙箱外的符号链接", () => {
    const outside = join(tmpdir(), `sandbox-outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret", "utf8");
    const link = join(root, "link.txt");
    try {
      symlinkSync(outside, link, "file");
    } catch {
      return; // 某些环境不允许创建符号链接，跳过
    }
    const r = sandbox.check("link.txt");
    expect(r.ok).toBe(false);
  });

  it("拒绝空路径", () => {
    expect(sandbox.check("").ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 审批器

describe("审批器", () => {
  it("StaticApprover 返回固定结果", async () => {
    const a = new StaticApprover({ approved: true, approver: "bot" });
    const r = await a.approve({
      tool: "writeFile",
      args: {},
      proposed: { decision: "ask", reason: "x" },
    });
    expect(r.approved).toBe(true);
  });

  it("DenyAllApprover 一律拒绝", async () => {
    const r = await new DenyAllApprover().approve({
      tool: "writeFile",
      args: {},
      proposed: { decision: "ask", reason: "x" },
    });
    expect(r.approved).toBe(false);
  });

  it("SequenceApprover 按预设顺序返回结果", async () => {
    const seq = new SequenceApprover([
      { approved: true, approver: "op" },
      { approved: false, reason: "不想批", approver: "op" },
    ]);
    const req = {
      tool: "writeFile",
      args: {},
      proposed: { decision: "ask" as const, reason: "x" },
    };
    expect((await seq.approve(req)).approved).toBe(true);
    expect((await seq.approve(req)).approved).toBe(false);
    expect(seq.requests).toHaveLength(2);
  });

  it("ConsoleApprover 在非交互环境下直接拒绝，不阻塞", async () => {
    const a = new ConsoleApprover({ timeoutMs: 50 });
    const r = await a.approve({
      tool: "writeFile",
      args: {},
      proposed: { decision: "ask", reason: "x" },
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/交互式终端/);
  });
});

// ---------------------------------------------------------------- 守卫

describe("ToolGuard：策略 → 审批 → 执行 → 审计", () => {
  it("allow：直接执行并记审计", async () => {
    const audit = new MemoryAuditLog();
    const guard = new ToolGuard({
      policy: new PolicyEngine([allowRule("a", "放行", () => true)]),
      audit,
    });
    const out = await guard.execute("writeFile", { path: "a.txt" }, async () => "written");
    expect(out).toBe("written");
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]!.outcome).toBe("executed");
  });

  it("deny：不执行，记 denied 审计", async () => {
    const audit = new MemoryAuditLog();
    let called = false;
    const guard = new ToolGuard({
      policy: new PolicyEngine([denyRule("d", "拒绝", () => true, "策略不让")]),
      audit,
    });
    await expect(
      guard.execute("writeFile", {}, async () => {
        called = true;
        return "written";
      }),
    ).rejects.toThrow(/策略不让/);
    expect(called).toBe(false);
    expect(audit.list()[0]!.outcome).toBe("denied");
  });

  it("ask + 人工批准：执行并记 approved 审计", async () => {
    const audit = new MemoryAuditLog();
    const guard = new ToolGuard({
      policy: new PolicyEngine([askRule("q", "问人", () => true)]),
      approver: new StaticApprover({ approved: true, approver: "op" }),
      audit,
    });
    const out = await guard.execute("writeFile", {}, async () => "written");
    expect(out).toBe("written");
    const ev = audit.list()[0]!;
    expect(ev.outcome).toBe("executed");
    expect(ev.approver).toBe("op");
  });

  it("ask + 人工驳回：不执行，记 rejected 审计", async () => {
    const audit = new MemoryAuditLog();
    let called = false;
    const guard = new ToolGuard({
      policy: new PolicyEngine([askRule("q", "问人", () => true)]),
      approver: new StaticApprover({ approved: false, reason: "不批" }),
      audit,
    });
    await expect(
      guard.execute("writeFile", {}, async () => {
        called = true;
        return "written";
      }),
    ).rejects.toThrow(/不批/);
    expect(called).toBe(false);
    expect(audit.list()[0]!.outcome).toBe("rejected");
  });

  it("ask 但没有审批器：按拒绝处理", async () => {
    const guard = new ToolGuard({
      policy: new PolicyEngine([askRule("q", "问人", () => true)]),
    });
    const outcome = await guard.authorize("writeFile", {});
    expect(outcome.status).toBe("rejected");
  });

  it("审批超时：按拒绝处理", async () => {
    const slow = new CallbackApprover(
      () => new Promise((r) => setTimeout(() => r({ approved: true }), 200)),
      "slow",
    );
    const guard = new ToolGuard({
      policy: new PolicyEngine([askRule("q", "问人", () => true)]),
      approver: slow,
      approvalTimeoutMs: 30,
    });
    const outcome = await guard.authorize("writeFile", {});
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.decision.reason).toMatch(/超时/);
  });

  it("审批器抛异常：按拒绝处理", async () => {
    const broken = new CallbackApprover(() => {
      throw new Error("审批系统挂了");
    });
    const guard = new ToolGuard({
      policy: new PolicyEngine([askRule("q", "问人", () => true)]),
      approver: broken,
    });
    const outcome = await guard.authorize("writeFile", {});
    expect(outcome.status).toBe("rejected");
  });

  it("执行抛异常：记 error 审计后继续抛出", async () => {
    const audit = new MemoryAuditLog();
    const guard = new ToolGuard({
      policy: new PolicyEngine([allowRule("a", "放行", () => true)]),
      audit,
    });
    await expect(
      guard.execute("writeFile", {}, async () => {
        throw new Error("磁盘满了");
      }),
    ).rejects.toThrow(/磁盘满了/);
    expect(audit.list()[0]!.outcome).toBe("error");
  });
});

// ---------------------------------------------------------------- 注册表集成

describe("ToolRegistry 与权限关卡集成", () => {
  const echoParams = z.object({ a: z.unknown().optional() });
  const echoTool: Tool<typeof echoParams> = {
    name: "echo",
    description: "回显",
    parameters: echoParams,
    execute: (args) => `echo:${JSON.stringify(args)}`,
  };

  it("未装关卡时行为不变", async () => {
    const reg = new ToolRegistry().register(echoTool);
    expect(reg.hasGuard()).toBe(false);
    expect(await reg.run("echo", { a: 1 })).toBe('echo:{"a":1}');
  });

  it("装上关卡后，被拒绝的调用返回 [权限拒绝·策略拒绝]", async () => {
    const reg = new ToolRegistry()
      .register(echoTool)
      .setGuard(
        new ToolGuard({
          policy: new PolicyEngine([denyRule("d", "拒绝", () => true, "策略不让")]),
        }),
      );
    expect(reg.hasGuard()).toBe(true);
    const out = await reg.run("echo", { a: 1 });
    expect(out).toMatch(/^\[权限拒绝·策略拒绝\]/);
    expect(out).toMatch(/策略不让/);
  });

  it("人工驳回返回 [权限拒绝·人工驳回]", async () => {
    const reg = new ToolRegistry()
      .register(echoTool)
      .setGuard(
        new ToolGuard({
          policy: new PolicyEngine([askRule("q", "问人", () => true)]),
          approver: new StaticApprover({ approved: false, reason: "驳回" }),
        }),
      );
    const out = await reg.run("echo", {});
    expect(out).toMatch(/^\[权限拒绝·人工驳回\]/);
  });

  it("参数校验失败优先于权限检查（不打扰人审批）", async () => {
    let asked = false;
    const reg = new ToolRegistry()
      .register(calculator)
      .setGuard(
        new ToolGuard({
          policy: new PolicyEngine([askRule("q", "问人", () => true)]),
          approver: new CallbackApprover(() => {
            asked = true;
            return { approved: true };
          }),
        }),
      );
    const out = await reg.run("calculator", { expression: 123 }); // 类型不对
    expect(out).toMatch(/^\[工具错误·validation\]/);
    expect(asked).toBe(false);
  });

  it("允许的调用正常返回结果", async () => {
    const reg = new ToolRegistry()
      .register(echoTool)
      .setGuard(new ToolGuard({ policy: new PolicyEngine([allowRule("a", "放行", () => true)]) }));
    expect(await reg.run("echo", { a: 1 })).toBe('echo:{"a":1}');
  });
});

// ---------------------------------------------------------------- 高风险工具

describe("高风险工具自带的硬边界", () => {
  const root = mkdtempSync(join(tmpdir(), "danger-"));
  const sandbox = new PathSandbox({
    roots: [root],
    allowedExtensions: [".txt", ".md"],
  });

  // 写/删工具是同步实现，抛错发生在调用那一刻；
  // 统一包一层 async，把同步抛出转成 rejected promise 再断言。
  const rejects = async (fn: () => unknown): Promise<Error> => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    throw new Error("期望抛出异常，但没有");
  };

  it("writeFile 拒绝沙箱外的路径", async () => {
    const tool = createWriteFileTool({ sandbox });
    const err = await rejects(() => tool.execute({ path: "../escape.txt", content: "x" }));
    expect(err.message).toMatch(/沙箱拒绝/);
  });

  it("writeFile 拒绝不在白名单的扩展名", async () => {
    const tool = createWriteFileTool({ sandbox });
    const err = await rejects(() => tool.execute({ path: "a.exe", content: "x" }));
    expect(err.message).toMatch(/沙箱拒绝/);
    expect(err.message).toMatch(/白名单/);
  });

  it("writeFile 在沙箱内正常写入", async () => {
    const tool = createWriteFileTool({ sandbox });
    const out = await tool.execute({ path: "ok.txt", content: "hello" });
    expect(out).toMatch(/已写入/);
  });

  it("deleteFile 拒绝删除目录", async () => {
    mkdirSync(join(root, "dir"), { recursive: true });
    const tool = createDeleteFileTool({ sandbox });
    const err = await rejects(() => tool.execute({ path: "dir" }));
    expect(err.message).toMatch(/沙箱拒绝|拒绝删除目录/);
  });

  it("deleteFile 能删掉沙箱内的普通文件", async () => {
    writeFileSync(join(root, "gone.txt"), "x", "utf8");
    const tool = createDeleteFileTool({ sandbox });
    const out = await tool.execute({ path: "gone.txt" });
    expect(out).toMatch(/已删除/);
  });

  it("runCommand 拒绝白名单之外的程序", async () => {
    const tool = createRunCommandTool({ allowedPrograms: ["echo"] });
    const err = await rejects(() =>
      tool.execute({ program: "powershell", args: ["-Command", "ls"] }),
    );
    expect(err.message).toMatch(/允许清单/);
  });

  it("runCommand 拒绝带路径的程序名", async () => {
    const tool = createRunCommandTool({ allowedPrograms: ["echo"] });
    const err = await rejects(() => tool.execute({ program: "/bin/echo", args: [] }));
    expect(err.message).toMatch(/允许清单|必须是不带路径/);
  });

  it("runCommand 允许白名单程序并捕获输出", async () => {
    const tool = createRunCommandTool({ allowedPrograms: ["echo"] });
    const out = await tool.execute({ program: "echo", args: ["hello"] });
    expect(out).toMatch(/hello/);
  });
});

// ---------------------------------------------------------------- 预设策略

describe("默认预设策略", () => {
  const policy = defaultSandboxPolicy();
  const decide = (tool: string, args: Record<string, unknown>) =>
    policy.evaluate({ tool, args }).decision;

  it("沙箱内只读 → 放行", () => {
    expect(decide("readFile", { path: "notes.txt" })).toBe("allow");
  });

  it("沙箱外路径 → 拒绝", () => {
    expect(decide("readFile", { path: "../.env" })).toBe("deny");
  });

  it("疑似凭据文件 → 拒绝（连问都不问）", () => {
    expect(decide("readFile", { path: ".env" })).toBe("deny");
    expect(decide("readFile", { path: "keys/server.pem" })).toBe("deny");
  });

  it("写文件 / 删文件 / 执行命令 → 问人", () => {
    expect(decide("writeFile", { path: "out.txt", content: "x" })).toBe("ask");
    expect(decide("deleteFile", { path: "out.txt" })).toBe("ask");
    expect(decide("runCommand", { program: "ls", args: [] })).toBe("ask");
  });

  it("白名单域名抓取 → 放行，其他域名 → 问人", () => {
    expect(decide("webFetch", { url: "https://example.com/a" })).toBe("allow");
    expect(decide("webFetch", { url: "https://news.ycombinator.com/" })).toBe("ask");
  });

  it("未知工具 → 拒绝", () => {
    expect(decide("somethingElse", {})).toBe("deny");
  });

  it("默认文件沙箱限定在 data/ 目录", () => {
    const sandbox = defaultFileSandbox();
    expect(sandbox.check("notes.txt").ok).toBe(true);
    expect(sandbox.check("../package.json").ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 审计

describe("审计日志", () => {
  it("内存审计记录可回读", () => {
    const log = new MemoryAuditLog();
    log.record({
      ts: new Date().toISOString(),
      tool: "writeFile",
      args: "{}",
      decision: "allow",
      outcome: "executed",
      reason: "ok",
    });
    expect(log.list()).toHaveLength(1);
  });

  it("文件审计按 JSONL 追加，进程重启后可回溯", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const file = join(dir, "audit.jsonl");
    const log = new FileAuditLog({ file });
    log.record({
      ts: new Date().toISOString(),
      tool: "writeFile",
      args: JSON.stringify({ path: "a.txt" }),
      decision: "allow",
      outcome: "executed",
      reason: "ok",
    });
    log.record({
      ts: new Date().toISOString(),
      tool: "deleteFile",
      args: JSON.stringify({ path: "a.txt" }),
      decision: "deny",
      outcome: "rejected",
      reason: "人工驳回",
    });
    const all = log.readAll();
    expect(all).toHaveLength(2);
    expect(all[1]!.outcome).toBe("rejected");
    expect(all[1]!.reason).toBe("人工驳回");
  });
});
