import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAPABILITIES,
  auditCapabilities,
  renderMarkdown,
  renderTerminal,
  type Capability,
} from "../src/audit/capabilities.js";

const ROOT = resolve(process.cwd());

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cap-audit-"));
}

const sample: Capability = {
  id: "sample",
  name: "示例能力",
  post: "99",
  evidence: ["src/a.ts", "src/b.ts"],
  tests: ["tests/a.test.ts", "tests/missing.test.ts"],
  adk: "ADK 机制",
  mastra: "Mastra 机制",
  gap: "未覆盖部分",
};

describe("能力清单本身", () => {
  it("覆盖十二项，标识不重复", () => {
    expect(CAPABILITIES).toHaveLength(12);
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(12);
  });

  it("每项都写明三套实现的对应与差距", () => {
    for (const c of CAPABILITIES) {
      expect(c.adk.length).toBeGreaterThan(4);
      expect(c.mastra.length).toBeGreaterThan(4);
      expect(c.gap.length).toBeGreaterThan(4);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("auditCapabilities：证据扫描", () => {
  it("真实仓库里十二项证据齐全", () => {
    const rows = auditCapabilities(ROOT);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => !r.present)).toEqual([]);
    expect(rows.reduce((sum, r) => sum + r.sourceLines, 0)).toBeGreaterThan(3000);
  });

  it("每项能力都有测试文件覆盖", () => {
    for (const row of auditCapabilities(ROOT)) {
      expect(row.testFiles, `${row.id} 缺少测试文件`).toBeGreaterThan(0);
    }
  });

  it("行数统计不把末尾换行算成多一行", () => {
    const dir = freshDir();
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\n", "utf8");
      writeFileSync(join(dir, "src", "b.ts"), "three", "utf8");
      const [row] = auditCapabilities(dir, [sample]);
      // a.ts 两行 + b.ts 一行；b.ts 末尾无换行，不应多算一行
      expect(row!.sourceLines).toBe(3);
      expect(row!.present).toBe(true);
      expect(row!.missing).toEqual([]);
      expect(row!.testFiles).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("测试文件按实际存在计数", () => {
    const dir = freshDir();
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "src", "a.ts"), "x\n", "utf8");
      writeFileSync(join(dir, "src", "b.ts"), "y\n", "utf8");
      writeFileSync(join(dir, "tests", "a.test.ts"), "z\n", "utf8");
      const [row] = auditCapabilities(dir, [sample]);
      expect(row!.present).toBe(true);
      expect(row!.testFiles).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("只审计传入的能力子集", () => {
    const rows = auditCapabilities(ROOT, [sample]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("sample");
  });

  it("部分证据缺失时判为不齐全，并列出缺失路径", () => {
    const dir = freshDir();
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "x\n", "utf8");
      const [row] = auditCapabilities(dir, [sample]);
      expect(row!.present).toBe(false);
      expect(row!.missing).toEqual(["src/b.ts"]);
      expect(row!.sourceLines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("输出渲染", () => {
  it("终端输出含标题、逐项字段与合计", () => {
    const rows = auditCapabilities(ROOT, [CAPABILITIES[0]!]);
    const text = renderTerminal(rows);
    expect(text).toContain("能力对照审计 —— 1 项");
    expect(text).toContain("[post-02] agent-loop");
    expect(text).toContain("ADK");
    expect(text).toContain("Mastra");
    expect(text).toContain("合计 1/1 项证据齐全");
  });

  it("Markdown 输出含表头与一行数据", () => {
    const rows = auditCapabilities(ROOT, [CAPABILITIES[0]!]);
    const md = renderMarkdown(rows);
    const lines = md.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("| 能力 | 篇 | 本系列证据 | ADK 对应 | Mastra 对应 | 未覆盖 |");
    expect(lines[2]).toContain("Agent 循环与工具调用");
    expect(lines[2]).toContain("2 文件 / 515 行");
  });

  it("缺失证据在终端输出里显式标出", () => {
    const dir = freshDir();
    try {
      const rows = auditCapabilities(dir, [sample]);
      const text = renderTerminal(rows);
      expect(text).toContain("证据 ✗");
      expect(text).toContain("缺失: src/a.ts, src/b.ts");
      expect(text).toContain("合计 0/1 项证据齐全");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
