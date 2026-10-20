/**
 * Whole-chain smoke test: load the extension factory against a stub
 * ExtensionAPI and assert the two providers, the command family, and the
 * statusline wiring come up with the built-in fallback rosters.
 *
 * This is the test that would catch a broken vendored-module import or a
 * mis-shaped Provider before pi ever loads the package.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI, Provider } from "./stubs.ts";
import workBuddyConnect from "../extensions/index.ts";

const registeredProviders: Provider[] = [];
const registeredCommands = new Map<string, unknown>();
const eventHandlers = new Map<string, unknown>();

const stubApi = {
  registerProvider(provider: Provider) {
    registeredProviders.push(provider);
  },
  registerCommand(name: string, config: unknown) {
    registeredCommands.set(name, config);
  },
  on(event: string, handler: unknown) {
    eventHandlers.set(event, handler);
    return () => undefined;
  },
} as unknown as ExtensionAPI;

describe("extension factory", () => {
  beforeAll(() => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-workbuddy-agent-"));
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    // Point the desktop-auth probes at a present-but-unusable file so the test
    // is deterministic even on a machine whose WorkBuddy app is signed in.
    const fakeAuth = join(agentDir, "fake-desktop-auth.json");
    writeFileSync(fakeAuth, '{"not":"a workbuddy auth document"}', "utf8");
    process.env["WORKBUDDY_AUTH_FILE"] = fakeAuth;
    process.env["WORKBUDDY_AI_AUTH_FILE"] = fakeAuth;
    workBuddyConnect(stubApi as unknown as Parameters<typeof workBuddyConnect>[0]);
  });

  afterAll(() => {
    delete process.env["PI_CODING_AGENT_DIR"];
    delete process.env["WORKBUDDY_AUTH_FILE"];
    delete process.env["WORKBUDDY_AI_AUTH_FILE"];
  });

  it("registers both WorkBuddy providers with their fallback rosters", () => {
    const ids = registeredProviders.map((provider) => provider.id);
    expect(ids).toEqual(["workbuddy", "workbuddy-ai"]);

    const cn = registeredProviders[0];
    expect(cn.name).toBe("WorkBuddy");
    const models = cn.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === "workbuddy")).toBe(true);
    expect(models.every((model) => model.api === "openai-completions")).toBe(true);
    // CN fallback rows carry billing decorations in the display name.
    expect(models.some((model) => model.name.includes("·"))).toBe(true);

    const ai = registeredProviders[1];
    expect(ai.name).toBe("WorkBuddy AI");
    expect(ai.getModels().length).toBeGreaterThan(0);
  });

  it("hides every model while no account is in effect", () => {
    for (const provider of registeredProviders) {
      expect(provider.filterModels?.(provider.getModels(), undefined)).toEqual([]);
    }
  });

  it("wires auth that reports availability from the desktop credential", async () => {
    for (const provider of registeredProviders) {
      expect(provider.auth.apiKey?.name).toBe("WorkBuddy 桌面登录");
      // Signed out (fresh state dir): no configured auth, no models available.
      expect(await provider.auth.apiKey?.check?.({} as never).catch(() => undefined)).toBeUndefined();
      expect(await provider.auth.apiKey?.resolve?.({} as never).catch(() => undefined)).toBeUndefined();
    }
  });

  it("registers the /workbuddy command and the statusline events", () => {
    expect(registeredCommands.has("workbuddy")).toBe(true);
    expect(eventHandlers.has("session_start")).toBe(true);
    expect(eventHandlers.has("model_select")).toBe(true);
  });

  it("serves streams through the WorkBuddy fetch adapter without dialing the synthetic baseUrl", async () => {
    const provider = registeredProviders[0];
    const model = provider.getModels()[0];
    expect(model.baseUrl).toBe("http://workbuddy.internal.invalid/v1");
    // Streaming is delegated to the built-in openai-completions implementation;
    // a call against a signed-out store must terminate with an error event
    // (or a synchronous auth rejection) rather than touching the network.
    let terminated = false;
    try {
      const stream = provider.streamSimple(model, { messages: [] } as never, {} as never);
      for await (const event of stream) {
        if (event.type === "error" || event.type === "done") terminated = true;
      }
    } catch {
      terminated = true;
    }
    expect(terminated).toBe(true);
  });
});
