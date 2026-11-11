import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ToolRegistry } from "../src/agent/index.js";
import { allTools, readFile, searchFiles, webFetch } from "../src/tools/index.js";

/**
 * 真工具测试：直接对工具做单元验证，不依赖真实 LLM 或外网。
 * 覆盖：readFile 正常/越权/缺失、searchFiles 命中、webFetch 本地服务成功+截断+连接拒绝。
 */

describe("readFile", () => {
  const reg = new ToolRegistry().register(readFile);

  it("reads an existing file inside data/", async () => {
    const obs = await reg.run("readFile", { path: "notes.txt" });
    expect(obs).toContain("Agent 系列开发笔记");
  });

  it("rejects path traversal before reading (sandbox)", async () => {
    const obs = await reg.run("readFile", { path: "../.env" });
    expect(obs).toContain("路径越权");
    expect(obs).toContain("execution"); // 注册表归类为 execution 观察
  });

  it("reports missing file clearly", async () => {
    const obs = await reg.run("readFile", { path: "does-not-exist.txt" });
    expect(obs).toContain("文件不存在");
  });
});

describe("searchFiles", () => {
  const reg = new ToolRegistry().register(searchFiles);

  it("finds keyword across data/ recursively", async () => {
    const obs = await reg.run("searchFiles", { query: "agent" });
    expect(obs).toContain("命中"); // 至少有一处命中
    expect(obs.toLowerCase()).toContain("agent");
  });

  it("reports when nothing matches", async () => {
    const obs = await reg.run("searchFiles", { query: "zzz_no_such_keyword_zzz" });
    expect(obs).toContain("没有找到包含");
  });
});

describe("webFetch (local server, no external network)", () => {
  let server: Server;
  let baseUrl: string;

  afterAll(() => {
    server?.close();
  });

  it("strips HTML and truncates long bodies", async () => {
    // 起一个本地 http 服务返回一段 HTML 正文
    const body = `<html><head><title>t</title></head><body>
      <script>var x=1;</script>
      <style>.a{color:red}</style>
      <p>hello world keyword</p>
      ${"padding ".repeat(2000)}
    </body></html>`;

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/`;

    const obs = await webFetch.execute({ url: baseUrl, maxChars: 30 });
    expect(obs).toContain("hello world keyword"); // 正文被保留
    expect(obs).not.toContain("<script"); // 标签被去掉
    expect(obs).toContain("已截断"); // 超长被截断
  });

  it("classifies connection-refused as execution error observation", async () => {
    const reg = new ToolRegistry().register(webFetch);
    const obs = await reg.run("webFetch", { url: "http://127.0.0.1:1/" });
    expect(obs).toContain("execution");
    expect(obs).toMatch(/抓取失败|超时/);
  });
});

describe("allTools aggregation", () => {
  it("registers four tools without name collision", () => {
    const reg = new ToolRegistry().registerAll(allTools);
    expect(reg.list()).toHaveLength(4);
    expect(reg.has("calculator")).toBe(true);
    expect(reg.has("readFile")).toBe(true);
    expect(reg.has("searchFiles")).toBe(true);
    expect(reg.has("webFetch")).toBe(true);
  });
});
