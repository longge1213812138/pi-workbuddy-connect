/** Shared fixtures for the unit tests. No real FS roots, no network, no processes. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkBuddyCredential, WorkBuddyUpstreamModel } from "../src/core.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-workbuddy-test-"));
}

export function makeCredential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAtMs: Date.now() + 3600_000,
    domain: "codebuddy.cn",
    uid: "user-1",
    enterpriseId: "",
    source: "desktop",
    ...overrides,
  };
}

export function makeUpstreamModel(overrides: Partial<WorkBuddyUpstreamModel> = {}): WorkBuddyUpstreamModel {
  return {
    id: "glm-5.3",
    name: "GLM-5.3",
    contextWindow: 128_000,
    maxTokens: 32_768,
    supportsImages: true,
    ...overrides,
  };
}

export function makeReasoning(
  overrides: Partial<NonNullable<WorkBuddyUpstreamModel["reasoning"]>> = {},
): NonNullable<WorkBuddyUpstreamModel["reasoning"]> {
  return {
    supports: true,
    onlyReasoning: false,
    canDisableThinking: true,
    ...overrides,
  };
}

/** A `ReadableStream` that yields one chunk and then fails, for [DONE]-guard tests. */
export function failingSseStream(first: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
    pull(controller) {
      controller.error(new Error("upstream stream failed mid-flight"));
    },
  });
}

/** Read a whole byte stream into a string. */
export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    if (value !== undefined) out += decoder.decode(value, { stream: true });
  }
}
