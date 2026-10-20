import { describe, expect, it } from "vitest";
import type { WorkBuddyCredentialStore, WorkBuddyUpstreamClient } from "../src/core.ts";
import { createWorkBuddyFetch, KIND_STATUS } from "../src/fetch-adapter.ts";
import { failingSseStream, makeCredential, readAll } from "./helpers.ts";

function fakeStore(overrides: Partial<WorkBuddyCredentialStore> = {}): WorkBuddyCredentialStore {
  return {
    current: async () => makeCredential(),
    resolve: async () => makeCredential(),
    status: async () => ({ state: "signed-in" as const }),
    logout: async () => undefined,
    setDesktopPath: () => undefined,
    desktopAuthPath: () => undefined,
    ownAuthPath: () => "/tmp/auth.json",
    desktopAuthFormat: async () => "plaintext" as const,
    resolvedDesktopAuthPath: async () => undefined,
    desktopFilePresent: async () => true,
    ...overrides,
  } as WorkBuddyCredentialStore;
}

function fakeClient(
  chatStream: WorkBuddyUpstreamClient["chatStream"],
): WorkBuddyUpstreamClient {
  return {
    lastCatalog: undefined,
    chatStream,
    refreshToken: async () => ({ accessToken: "x" }),
    fetchModels: async () => [],
    fetchCredits: async () => ({ total: 0, accounts: [] }),
    probeEffort: async () => ({ status: 200, streamed: true }),
  };
}

const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

describe("createWorkBuddyFetch", () => {
  it("normalizes the assembled body and passes the upstream SSE response through", async () => {
    let captured: string | undefined;
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore(),
      client: fakeClient(async (_credential, body) => {
        captured = body;
        return { ok: true, response: new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }) };
      }),
    });

    const body = JSON.stringify({
      model: "glm-5.3",
      messages: [{ role: "developer", content: "system prompt" }, { role: "user", content: "hi" }],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    const response = await fetchImpl("http://workbuddy.internal.invalid/v1/chat/completions", { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await readAll(response.body)).toBe(SSE);

    const prepared = JSON.parse(captured ?? "{}");
    expect(prepared.stream).toBe(true);
    expect(prepared.messages[0].role).toBe("system");
    expect(prepared.tool_choice).toBe("read");
  });

  it("maps every upstream failure class onto its HTTP status and OpenAI error body", async () => {
    const kinds = ["hard_credit", "soft_rate", "session_dead", "not_found", "server", "client"] as const;
    for (const kind of kinds) {
      const fetchImpl = createWorkBuddyFetch({
        store: fakeStore(),
        client: fakeClient(async () => ({
          ok: false,
          status: 418,
          kind,
          message: "boom",
        })),
      });
      const response = await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: "{}" });
      expect(response.status).toBe(KIND_STATUS[kind]);
      const payload = JSON.parse(await response.text());
      expect(payload.error.code).toBe(kind);
      expect(payload.error.message).toContain(`workbuddy upstream ${kind}`);
    }
  });

  it("answers 401 when no credential can be resolved", async () => {
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore({
        resolve: async () => {
          throw new Error("no usable credential");
        },
      }),
      client: fakeClient(async () => ({ ok: true, response: new Response(SSE) })),
    });
    const response = await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(JSON.parse(await response.text()).error.code).toBe("not_signed_in");
  });

  it("propagates the request abort signal to the upstream call", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore(),
      client: fakeClient(async (_c, _b, signal) => {
        seen = signal;
        return { ok: true, response: new Response(SSE) };
      }),
    });
    await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: "{}", signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("reports the credential it resolved to the account tracker", async () => {
    const seen: string[] = [];
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore(),
      client: fakeClient(async () => ({ ok: true, response: new Response(SSE) })),
      onCredential: (credential) => seen.push(credential.uid),
    });
    await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: "{}" });
    expect(seen).toEqual(["user-1"]);
  });

  it("terminates a mid-flight stream failure with data: [DONE]", async () => {
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore(),
      client: fakeClient(async () => ({
        ok: true,
        response: new Response(failingSseStream('data: {"choices":[]}\n\n'), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      })),
    });
    const response = await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: "{}" });
    const text = await readAll(response.body);
    expect(text).toContain('data: {"choices":[]}');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("rejects a body it cannot serialize", async () => {
    const fetchImpl = createWorkBuddyFetch({
      store: fakeStore(),
      client: fakeClient(async () => ({ ok: true, response: new Response(SSE) })),
    });
    const response = await fetchImpl("http://x/v1/chat/completions", { method: "POST", body: new URLSearchParams() });
    expect(response.status).toBe(400);
  });
});
