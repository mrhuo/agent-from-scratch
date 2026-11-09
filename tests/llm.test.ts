import { describe, it, expect, vi } from "vitest";
import { LLMClient } from "../src/llm/index.js";
import type { Message } from "../src/llm/types.js";

const messages: Message[] = [{ role: "user", content: "hi" }];

function makeClient(fetchImpl: typeof fetch): LLMClient {
  return new LLMClient({ apiKey: "test-key", model: "m", fetchImpl });
}

// 仅作为 vi.fn 的类型签名来源，运行时被 mockImplementation 覆盖
const fetchSig = (_url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error("not implemented");
};

describe("LLMClient.chat", () => {
  it("parses non-stream response and sends stream:false", async () => {
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const out = await makeClient(fakeFn as unknown as typeof fetch).chat(messages);
    expect(out).toBe("hello");

    const call = fakeFn.mock.calls[0]!;
    expect(String(call[0])).toContain("/chat/completions");
    const init = call[1]!;
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init.body as unknown as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe("m");
  });

  it("throws with status when response is not ok", async () => {
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(async () => new Response("unauthorized", { status: 401 }));

    await expect(
      makeClient(fakeFn as unknown as typeof fetch).chat(messages),
    ).rejects.toThrow(/401/);
  });
});

describe("LLMClient.chatStream", () => {
  it("parses SSE deltas and stops at [DONE]", async () => {
    const sse =
      [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        "data: [DONE]",
        "",
      ].join("\n");
    const stream = new Response(sse).body!;
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(
      async () =>
        new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const chunks: string[] = [];
    for await (const c of makeClient(fakeFn as unknown as typeof fetch).chatStream(messages)) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("你好");
  });

  it("ignores malformed SSE lines without throwing", async () => {
    const sse =
      ["data: {bad json", 'data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"].join(
        "\n",
      );
    const stream = new Response(sse).body!;
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(
      async () =>
        new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const out: string[] = [];
    for await (const c of makeClient(fakeFn as unknown as typeof fetch).chatStream(messages)) {
      out.push(c);
    }
    expect(out.join("")).toBe("ok");
  });
});

describe("LLMClient.chatWithTools", () => {
  it("parses tool_calls and their argument JSON string", async () => {
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "我来算一下",
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "calculator", arguments: '{"expression":"23 * 17"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const out = await makeClient(fakeFn as unknown as typeof fetch).chatWithTools(messages, [
      { type: "function", function: { name: "calculator", description: "", parameters: {} } },
    ]);
    expect(out.content).toBe("我来算一下");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe("calculator");
    expect(out.toolCalls[0]!.function.arguments).toEqual({ expression: "23 * 17" });

    const call = fakeFn.mock.calls[0]!;
    const init = call[1]!;
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init.body as string);
    expect(body.tools[0].function.name).toBe("calculator");
    expect(body.stream).toBe(false);
  });

  it("throws with status when response is not ok", async () => {
    const fakeFn = vi.fn(fetchSig);
    fakeFn.mockImplementation(async () => new Response("unauthorized", { status: 401 }));

    await expect(
      makeClient(fakeFn as unknown as typeof fetch).chatWithTools(messages, []),
    ).rejects.toThrow(/401/);
  });
});
