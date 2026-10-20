/**
 * Zero-dependency OpenAI Chat Completions streaming.
 *
 * Pi's built-in implementation lives behind `@earendil-works/pi-ai`, which a
 * git-installed package cannot resolve (Pi installs no dependencies for git
 * sources, and the package must not ship a physical copy of a host-provided
 * module). So this module implements the small slice of that contract this
 * provider needs: convert Pi's normalized transcript into an OpenAI request,
 * consume the OpenAI SSE answer, and emit Pi's `AssistantMessageEvent`s.
 *
 * The wire hop itself is still the WorkBuddy fetch adapter, which normalizes
 * the body and maps upstream failures onto OpenAI error responses.
 */

// ---------------------------------------------------------------------------
// Structural types (mirrors of pi-ai's declarations; erased at runtime)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  api: string;
  provider: string;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AnyToolContent = ToolCallContent & {
  argumentsError?: string;
  streamIndex?: number;
  partialArgs?: string;
};

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | AnyToolContent)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
  durationMs?: number;
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  sessionId?: string;
  /** `null` suppresses a header, matching pi-ai's `ProviderHeaders` shape. */
  headers?: Record<string, string | null>;
  onPayload?: (payload: unknown, model?: ModelInfo) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: { status: number; headers: Record<string, string> }, model?: ModelInfo) => void | Promise<void>;
  onProviderStreamEvent?: (data: unknown, model?: ModelInfo) => void | Promise<void>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Event stream (same contract as pi-ai's AssistantMessageEventStream)
// ---------------------------------------------------------------------------

type Waiter = (result: { value: AssistantMessageEvent | undefined; done: boolean }) => void;

export class AssistantEventStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Waiter[] = [];
  private done = false;
  private finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (message: AssistantMessage) => void;
  private readonly startedAt = Date.now();
  private readonly startedAtMonotonic = performance.now();

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done") this.time(event.message);
    else if (event.type === "error") this.time(event.error);
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.time(result);
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<{ value: AssistantMessageEvent | undefined; done: boolean }>((resolve) =>
        this.waiting.push(resolve),
      );
      if (next.done || next.value === undefined) return;
      yield next.value;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }

  private time(message: AssistantMessage): void {
    if (this.done || message.durationMs !== undefined || message.timestamp < this.startedAt) return;
    message.durationMs = Math.max(0, Math.round(performance.now() - this.startedAtMonotonic));
  }
}

// ---------------------------------------------------------------------------
// Transcript replay: recover the current prompt/tools from system messages
// ---------------------------------------------------------------------------

interface ToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

interface SystemLike {
  role: "system";
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
  toolsRemoved?: { name: string }[];
}

interface AnyMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** Replay every system message into the current prompt text + section blocks. */
export function currentSystemText(messages: readonly AnyMessage[]): { text: string; sections: Record<string, string> } {
  const parts: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const sys = message as unknown as SystemLike;
    const text = contentText(sys.content);
    if (text.length > 0) parts.push(text);
    for (const [name, value] of Object.entries(sys.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return { text: parts.join("\n\n"), sections: Object.fromEntries(sections) };
}

/** Resolve the tools in effect after replaying every system-message delta. */
export function currentTools(messages: readonly AnyMessage[]): ToolDecl[] {
  const tools = new Map<string, ToolDecl>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const sys = message as unknown as SystemLike;
    for (const removed of sys.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of sys.toolsAdded ?? []) {
      if (isRecord(added) && typeof added["name"] === "string") {
        tools.set(added["name"], {
          name: added["name"],
          description: typeof added["description"] === "string" ? added["description"] : "",
          parameters: added["parameters"],
        });
      }
    }
  }
  return [...tools.values()];
}

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

type OpenAiMessage =
  | { role: "system" | "user" | "assistant"; content: string | OpenAiPart[] }
  | { role: "assistant"; content: string | null; tool_calls: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Pi thinking level → upstream `reasoning_effort`, or undefined to omit it. */
function effortOf(model: ModelInfo, level: ThinkingLevel | undefined): string | undefined {
  if (!model.reasoning || level === undefined) return undefined;
  if (level === "off") return undefined;
  // `minimal` is not part of the upstream vocabulary; the closest accepted
  // level is `low`, and the map on the model already expresses that intent.
  if (level === "minimal") return "low";
  return level;
}

export function buildRequestBody(
  model: ModelInfo,
  messages: readonly AnyMessage[],
  options: StreamOptions = {},
): Record<string, unknown> {
  const system = currentSystemText(messages);
  const tools = currentTools(messages);
  const body: Record<string, unknown> = {
    model: model.id,
    stream: true,
    messages: [] as OpenAiMessage[],
  };

  if (system.text !== "") {
    const sectionText = Object.values(system.sections).filter((value) => value !== "").join("\n\n");
    const prompt = sectionText === "" ? system.text : `${system.text}\n\n${sectionText}`;
    (body["messages"] as OpenAiMessage[]).push({ role: "system", content: prompt });
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const parts = toOpenAiParts(message.content);
      if (parts !== undefined) (body["messages"] as OpenAiMessage[]).push({ role: "user", content: parts });
      continue;
    }
    if (message.role === "assistant") {
      const converted = toAssistantMessage(message);
      if (converted !== undefined) (body["messages"] as OpenAiMessage[]).push(converted);
      continue;
    }
    if (message.role === "toolResult") {
      (body["messages"] as OpenAiMessage[]).push({
        role: "tool",
        tool_call_id: typeof message.toolCallId === "string" ? message.toolCallId : "",
        content: contentText(message.content),
      });
    }
  }

  if (tools.length > 0) {
    body["tools"] = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;
  const effort = effortOf(model, options.reasoning);
  if (effort !== undefined) body["reasoning_effort"] = effort;
  return body;
}

function toOpenAiParts(content: unknown): string | OpenAiPart[] | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: OpenAiPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image" && typeof block["data"] === "string") {
      const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "image/png";
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${block["data"]}` } });
    }
  }
  return parts.length > 0 ? parts : undefined;
}

function toAssistantMessage(message: AnyMessage): OpenAiMessage | undefined {
  const content = contentText(message.content);
  const toolCalls: OpenAiToolCall[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block) || block["type"] !== "toolCall") continue;
      const id = typeof block["id"] === "string" ? block["id"] : "";
      const name = typeof block["name"] === "string" ? block["name"] : "";
      const args = isRecord(block["arguments"]) ? block["arguments"] : {};
      toolCalls.push({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    }
  }
  if (toolCalls.length > 0) return { role: "assistant", content: content === "" ? null : content, tool_calls: toolCalls };
  if (content === "") return undefined;
  return { role: "assistant", content };
}

// ---------------------------------------------------------------------------
// SSE consumption → Pi events
// ---------------------------------------------------------------------------

interface OpenAiDelta {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAiToolDelta[] };
    finish_reason?: string | null;
  }[];
  /** The upstream sends `null` here on most frames; only an object carries counts. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: { message?: string; code?: string; type?: string };
}

interface OpenAiToolDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

const EMPTY_USAGE = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const EMPTY_MESSAGE = (model: ModelInfo, provider: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider,
  model: model.id,
  usage: EMPTY_USAGE(),
  stopReason: "pending",
  timestamp: Date.now(),
});

/** Split an SSE byte stream into `data:` payloads. */
async function* ssePayloads(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = findEventBoundary(buffer);
      if (boundary < 0) break;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, "");
      const payload = sseData(raw);
      if (payload !== undefined) yield payload;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    const payload = sseData(buffer);
    if (payload !== undefined) yield payload;
  }
}

function findEventBoundary(text: string): number {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return crlf;
  return lf;
}

function sseData(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  return data.join("\n");
}

/** Stream one OpenAI Chat Completions response into Pi's event protocol. */
export function streamOpenAiCompletions(
  model: ModelInfo,
  messages: readonly AnyMessage[],
  options: StreamOptions = {},
  provider = model.provider,
): AssistantEventStream {
  const stream = new AssistantEventStream();
  const message = EMPTY_MESSAGE(model, provider);
  stream.push({ type: "start", partial: message });

  void (async () => {
    try {
      let payload: unknown = buildRequestBody(model, messages, options);
      if (options.onPayload !== undefined) {
        const replaced = await options.onPayload(payload, model);
        if (replaced !== undefined) payload = replaced;
      }

      const fetchImpl = options.fetch ?? globalThis.fetch;
      const response = await fetchImpl(
        // The WorkBuddy fetch adapter ignores the URL: it intercepts every request.
        "http://workbuddy.internal.invalid/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
            ...options.headers,
          },
          body: JSON.stringify(payload),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );

      if (options.onResponse !== undefined) {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        await options.onResponse({ status: response.status, headers }, model);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(errorTextOf(response.status, text));
      }

      const toolIndexes = new Map<number, number>();
      let sawFinish = false;
      let finished = false;

      for await (const raw of ssePayloads(response)) {
        if (raw === "[DONE]") break;
        let event: OpenAiDelta;
        try {
          event = JSON.parse(raw) as OpenAiDelta;
        } catch {
          continue;
        }
        if (options.onProviderStreamEvent !== undefined) await options.onProviderStreamEvent(event, model);

        if (event.error !== undefined) {
          throw new Error(event.error.message ?? "provider returned an error event");
        }
        if (isRecord(event.usage)) applyUsage(message.usage, event.usage);

        const choice = event.choices?.[0];
        if (choice === undefined) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
          appendThinking(stream, message, delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content !== "") {
          appendText(stream, message, delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          appendToolCall(stream, message, toolIndexes, call);
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          sawFinish = true;
          message.stopReason = finishReasonOf(choice.finish_reason, message);
          finished = true;
        }
      }

      // Close any block still open from the provider's perspective.
      closeOpenBlocks(stream, message, toolIndexes);
      message.usage.totalTokens = message.usage.input + message.usage.output;

      if (options.signal?.aborted) {
        message.stopReason = "aborted";
        message.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
        return;
      }
      if (!sawFinish && !finished) {
        message.stopReason = message.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
      }
      if (message.stopReason === "error") {
        throw new Error(message.errorMessage ?? "provider returned an error stop reason");
      }
      stream.push({
        type: "done",
        reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    } catch (error) {
      for (const block of message.content) delete (block as AnyToolContent).streamIndex;
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      });
      stream.end();
    }
  })();

  return stream;
}

function errorTextOf(status: number, text: string): string {
  const trimmed = text.trim();
  if (trimmed !== "") {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string; code?: string } };
      if (typeof parsed.error?.message === "string" && parsed.error.message !== "") {
        return parsed.error.message;
      }
    } catch {
      return trimmed.slice(0, 400);
    }
  }
  return `HTTP ${status}`;
}

function applyUsage(usage: Usage, raw: NonNullable<OpenAiDelta["usage"]>): void {
  if (typeof raw.prompt_tokens === "number") usage.input = raw.prompt_tokens;
  if (typeof raw.completion_tokens === "number") usage.output = raw.completion_tokens;
  if (typeof raw.total_tokens === "number") usage.totalTokens = raw.total_tokens;
}

function finishReasonOf(reason: string, message: AssistantMessage): StopReason {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "content_filter") {
    message.errorMessage = "provider filtered the response (content_filter)";
    return "error";
  }
  if (message.content.some((block) => block.type === "toolCall")) return "toolUse";
  return "stop";
}

function appendText(stream: AssistantEventStream, message: AssistantMessage, delta: string): void {
  const last = message.content[message.content.length - 1];
  if (last !== undefined && last.type === "text") {
    last.text += delta;
    stream.push({ type: "text_delta", contentIndex: message.content.length - 1, delta, partial: message });
    return;
  }
  message.content.push({ type: "text", text: delta });
  const index = message.content.length - 1;
  stream.push({ type: "text_start", contentIndex: index, partial: message });
  stream.push({ type: "text_delta", contentIndex: index, delta, partial: message });
}

function appendThinking(stream: AssistantEventStream, message: AssistantMessage, delta: string): void {
  const last = message.content[message.content.length - 1];
  if (last !== undefined && last.type === "thinking") {
    last.thinking += delta;
    stream.push({ type: "thinking_delta", contentIndex: message.content.length - 1, delta, partial: message });
    return;
  }
  message.content.push({ type: "thinking", thinking: delta });
  const index = message.content.length - 1;
  stream.push({ type: "thinking_start", contentIndex: index, partial: message });
  stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: message });
}

function appendToolCall(
  stream: AssistantEventStream,
  message: AssistantMessage,
  toolIndexes: Map<number, number>,
  call: OpenAiToolDelta,
): void {
  const wireIndex = typeof call.index === "number" ? call.index : toolIndexes.size;
  let contentIndex = toolIndexes.get(wireIndex);
  if (contentIndex === undefined) {
    message.content.push({
      type: "toolCall",
      id: call.id ?? `call_${wireIndex}`,
      name: call.function?.name ?? "",
      arguments: {},
      streamIndex: wireIndex,
      partialArgs: "",
    } as AnyToolContent);
    contentIndex = message.content.length - 1;
    toolIndexes.set(wireIndex, contentIndex);
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
  }
  const block = message.content[contentIndex];
  if (block === undefined || block.type !== "toolCall") return;
  const tool = block as AnyToolContent;
  if (typeof call.id === "string" && call.id !== "") tool.id = call.id;
  if (typeof call.function?.name === "string" && call.function.name !== "") tool.name = call.function.name;
  const argsDelta = call.function?.arguments;
  if (typeof argsDelta === "string" && argsDelta !== "") {
    tool.partialArgs = (tool.partialArgs ?? "") + argsDelta;
    stream.push({ type: "toolcall_delta", contentIndex, delta: argsDelta, partial: message });
  }
}

/** Close text/thinking/tool blocks and settle each tool call's arguments. */
function closeOpenBlocks(
  stream: AssistantEventStream,
  message: AssistantMessage,
  toolIndexes: Map<number, number>,
): void {
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: message });
    } else if (block.type === "toolCall") {
      const tool = block as AnyToolContent;
      const raw = tool.partialArgs ?? "";
      if (raw.trim() === "") {
        tool.arguments = {};
      } else {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isRecord(parsed)) tool.arguments = parsed;
          else {
            tool.arguments = {};
            tool.argumentsError = `tool arguments were not a JSON object: ${raw.slice(0, 200)}`;
          }
        } catch {
          tool.arguments = {};
          tool.argumentsError = `tool arguments were not valid JSON: ${raw.slice(0, 200)}`;
        }
      }
      delete tool.partialArgs;
      delete tool.streamIndex;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: tool, partial: message });
    }
  }
  toolIndexes.clear();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
