/**
 * The fetch adapter — the only new protocol code in this package.
 *
 * pi-ai's built-in `openai-completions` implementation builds the request
 * (system prompt, tools, images, thinking parameters) and parses the OpenAI
 * SSE answer; it accepts a custom `fetch`. This adapter sits exactly there:
 * it takes the assembled OpenAI Chat Completions body, normalizes it for the
 * WorkBuddy upstream (`prepareChatBody`), sends it through the upstream
 * client, and hands the raw response back — which is *already* an
 * OpenAI-compatible SSE stream.
 *
 * That is why route A needs no loopback HTTP shim: the transport seam and the
 * protocol seam are the same seam.
 */
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { WorkBuddyCredential, WorkBuddyCredentialStore, WorkBuddyUpstreamClient, WorkBuddyUpstreamErrorKind } from "./core.ts";
import { extractDisplayErrorMessage, prepareChatBody } from "./core.ts";

/** HTTP status each upstream failure class surfaces as (parity with the plugin's shim). */
export const KIND_STATUS: Record<WorkBuddyUpstreamErrorKind, number> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
};

export interface WorkBuddyFetchOptions {
  store: WorkBuddyCredentialStore;
  client: WorkBuddyUpstreamClient;
  /** Called with the credential every request resolved, for account tracking. */
  onCredential?: (credential: WorkBuddyCredential) => void;
}

/** Build the `fetch` implementation injected into the openai-completions API. */
export function createWorkBuddyFetch(options: WorkBuddyFetchOptions): FetchFunction {
  return async (_url, init) => {
    const raw = bodyToString(init?.body);
    if (raw === undefined) {
      return errorResponse(400, "client", "workbuddy fetch adapter received a request body it cannot serialize");
    }
    const prepared = prepareChatBody(raw);
    let credential: WorkBuddyCredential;
    try {
      credential = await options.store.resolve();
    } catch (error) {
      return errorResponse(401, "not_signed_in", `workbuddy: no usable credential: ${String(error)}`);
    }
    options.onCredential?.(credential);
    const result = await options.client.chatStream(credential, prepared, init?.signal ?? undefined);
    if (!result.ok) {
      const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400);
      const statusNote =
        (result.status === 401 || result.status === 403) && result.kind !== "session_dead" ? "" : ` (http ${result.status})`;
      return errorResponse(KIND_STATUS[result.kind], result.kind, `workbuddy upstream ${result.kind}${statusNote}: ${detail}`);
    }
    return withDoneGuard(result.response);
  };
}

/** Serialize whatever the SDK passed as `init.body`. */
function bodyToString(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return undefined;
}

/** An OpenAI-shaped error document, matching the shim's `writeOpenAIError`. */
function errorResponse(status: number, kind: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: kind, code: kind } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Guard an upstream SSE body so a mid-flight failure still terminates the
 * stream with `data: [DONE]`, exactly as the plugin's shim does: without it a
 * truncated stream would leave the SDK waiting for a terminator that never
 * comes.
 */
function withDoneGuard(response: Response): Response {
  const body = response.body;
  if (body === null) return response;
  const decoder = new TextDecoder();
  let sawDone = false;
  const reader = body.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value === undefined) return;
        if (decoder.decode(value, { stream: true }).includes("[DONE]")) sawDone = true;
        controller.enqueue(value);
      } catch {
        if (!sawDone) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
