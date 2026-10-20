import { describe, expect, it } from "vitest";
import {
  buildRequestBody,
  currentSystemText,
  currentTools,
  streamOpenAiCompletions,
  type ModelInfo,
} from "../src/stream.ts";

const MODEL: ModelInfo = {
  id: "glm-5.3",
  api: "openai-completions",
  provider: "workbuddy",
  reasoning: true,
};

const systemMessage = (text: string, tools: unknown[] = []) => ({
  role: "system" as const,
  content: text,
  timestamp: 0,
  ...(tools.length > 0 ? { toolsAdded: tools } : {}),
});

const tool = (name: string, description = "", parameters: unknown = { type: "object", properties: {} }) => ({
  name,
  description,
  parameters,
});

/** A Response whose body emits the given SSE frames, then closes. */
function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

function deltaEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(
  model: ModelInfo,
  messages: readonly unknown[],
  options: Parameters<typeof streamOpenAiCompletions>[2] = {},
): Promise<{ types: string[]; final: Awaited<ReturnType<ReturnType<typeof streamOpenAiCompletions>["result"]>> }> {
  const stream = streamOpenAiCompletions(model, messages as never, options);
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  return { types, final: await stream.result() };
}

describe("transcript replay", () => {
  it("joins every system message and applies section patches", () => {
    const result = currentSystemText([
      { role: "system", content: "base prompt", sections: { a: "A1", b: "B1" } },
      { role: "user", content: "hi" },
      { role: "system", content: "later", sections: { b: null, c: "C1" } },
    ] as never);
    expect(result.text).toBe("base prompt\n\nlater");
    expect(result.sections).toEqual({ a: "A1", c: "C1" });
  });

  it("resolves the live tool set across additions and removals", () => {
    const tools = currentTools([
      systemMessage("p", [tool("read"), tool("write")]),
      { role: "system", content: "", toolsRemoved: [{ name: "write" }], toolsAdded: [tool("grep")], timestamp: 0 },
    ] as never);
    expect(tools.map((t) => t.name)).toEqual(["read", "grep"]);
  });
});

describe("buildRequestBody", () => {
  it("carries prompt, tools, images, tool results and reasoning effort", () => {
    const body = buildRequestBody(MODEL, [
      systemMessage("You are helpful.", [tool("read", "Read a file")]),
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "AAA", mimeType: "image/jpeg" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }] },
    ] as never, { reasoning: "high", maxTokens: 256, temperature: 0.2 });

    expect(body["model"]).toBe("glm-5.3");
    expect(body["stream"]).toBe(true);
    const messages = body["messages"] as any[];
    expect(messages[0]).toMatchObject({ role: "system", content: "You are helpful." });
    expect(messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
    expect(messages[2]).toMatchObject({ role: "assistant", content: "checking" });
    expect(messages[2].tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"a.txt"}' },
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file body" });
    expect(body["tools"]).toEqual([
      { type: "function", function: { name: "read", description: "Read a file", parameters: tool("read").parameters } },
    ]);
    expect(body["reasoning_effort"]).toBe("high");
    expect(body["max_tokens"]).toBe(256);
    expect(body["temperature"]).toBe(0.2);
  });

  it("omits reasoning_effort for non-reasoning models and for `off`", () => {
    expect(buildRequestBody({ ...MODEL, reasoning: false }, [], { reasoning: "high" })["reasoning_effort"]).toBeUndefined();
    expect(buildRequestBody(MODEL, [], { reasoning: "off" })["reasoning_effort"]).toBeUndefined();
  });

  it("maps `minimal` onto the upstream's lowest accepted level", () => {
    expect(buildRequestBody(MODEL, [], { reasoning: "minimal" })["reasoning_effort"]).toBe("low");
  });
});

describe("streamOpenAiCompletions", () => {
  it("emits start, text deltas, and done with usage", async () => {
    const { types, final } = await collect(MODEL, [systemMessage("p"), { role: "user", content: "hi" }], {
      fetch: async () =>
        sseResponse([
          deltaEvent({ choices: [{ delta: { content: "Hel" } }] }),
          deltaEvent({ choices: [{ delta: { content: "lo" } }] }),
          deltaEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
          "data: [DONE]\n\n",
        ]),
    });
    expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(final.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(final.stopReason).toBe("stop");
    expect(final.usage.input).toBe(7);
    expect(final.usage.output).toBe(2);
    expect(final.usage.totalTokens).toBe(9);
    expect(final.durationMs).toBeTypeOf("number");
  });

  it("streams thinking separately from text", async () => {
    const { types, final } = await collect(MODEL, [], {
      fetch: async () =>
        sseResponse([
          deltaEvent({ choices: [{ delta: { reasoning_content: "pondering" } }] }),
          deltaEvent({ choices: [{ delta: { content: "answer" } }] }),
          deltaEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        ]),
    });
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_end");
    expect(final.content).toEqual([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "answer" },
    ]);
  });

  it("accumulates fragmented tool-call arguments and reports toolUse", async () => {
    const { types, final } = await collect(MODEL, [], {
      fetch: async () =>
        sseResponse([
          deltaEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] } }] }),
          deltaEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
          deltaEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
    });
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_end");
    expect(final.stopReason).toBe("toolUse");
    expect(final.content[0]).toMatchObject({
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    // Streaming scratch buffers never persist on the final message.
    expect((final.content[0] as unknown as Record<string, unknown>)["partialArgs"]).toBeUndefined();
  });

  it("records malformed tool arguments as an argumentsError instead of throwing", async () => {
    const { final } = await collect(MODEL, [], {
      fetch: async () =>
        sseResponse([
          deltaEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{oops" } }] } }] }),
          deltaEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
    });
    const block = final.content[0] as unknown as Record<string, unknown>;
    expect(block["arguments"]).toEqual({});
    expect(String(block["argumentsError"])).toContain("not valid JSON");
  });

  it("reports a non-2xx answer as an error event carrying the OpenAI message", async () => {
    const { types, final } = await collect(MODEL, [], {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "workbuddy upstream hard_credit (http 402)", code: "hard_credit" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(types).toEqual(["start", "error"]);
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toContain("hard_credit");
  });

  it("converts an abort into an aborted result", async () => {
    const controller = new AbortController();
    const stream = streamOpenAiCompletions(MODEL, [], {
      signal: controller.signal,
      fetch: async () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    const final = await stream.result();
    expect(types).toEqual(["start", "error"]);
    expect(final.stopReason).toBe("aborted");
  });

  it("honors onPayload and onResponse instrumentation", async () => {
    let seenPayload: unknown;
    let seenStatus: number | undefined;
    await collect(MODEL, [], {
      onPayload: (payload) => ({ ...(payload as Record<string, unknown>), marker: "replaced" }),
      onResponse: (response) => {
        seenStatus = response.status;
      },
      fetch: async (_url, init) => {
        seenPayload = JSON.parse(String((init as RequestInit).body));
        return sseResponse([deltaEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
      },
    });
    expect((seenPayload as Record<string, unknown>)["marker"]).toBe("replaced");
    expect(seenStatus).toBe(200);
  });

  it("tolerates `usage: null` on every frame (the upstream's normal shape)", async () => {
    const { types, final } = await collect(MODEL, [], {
      fetch: async () =>
        sseResponse([
          deltaEvent({ choices: [{ delta: { content: "ok" } }], usage: null }),
          deltaEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null }),
        ]),
    });
    expect(types).toContain("done");
    expect(final.stopReason).toBe("stop");
    expect(final.content).toEqual([{ type: "text", text: "ok" }]);
    expect(final.usage.input).toBe(0);
  });

  it("treats a stream without finish_reason as a complete answer", async () => {
    const { final } = await collect(MODEL, [], {
      fetch: async () => sseResponse([deltaEvent({ choices: [{ delta: { content: "partial" } }] })]),
    });
    expect(final.stopReason).toBe("stop");
    expect(final.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("handles SSE frames split across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const frames = [deltaEvent({ choices: [{ delta: { content: "split" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"];
    const joined = frames.join("");
    const { final } = await collect(MODEL, [], {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Split mid-frame, mid-JSON, and across the data: prefix.
              for (const slice of [joined.slice(0, 5), joined.slice(5, 40), joined.slice(40)]) {
                controller.enqueue(encoder.encode(slice));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    expect(final.content).toEqual([{ type: "text", text: "split" }]);
  });
});
