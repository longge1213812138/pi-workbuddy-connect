import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Credential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { filterByVisibility, refreshCatalog } from "../src/catalog.ts";
import { WorkBuddyCatalog, type WorkBuddyCredential, type WorkBuddyUpstreamModel } from "../src/core.ts";
import type { VariantRuntime } from "../src/runtime.ts";
import { CatalogStore, VisibilityStore, accountKeyOf } from "../src/stores.ts";
import { makeCredential, makeUpstreamModel, tempDir } from "./helpers.ts";
import { toPiModel } from "../src/models.ts";

interface FakeOptions {
  models?: readonly WorkBuddyUpstreamModel[];
  fetchError?: string;
  credential?: WorkBuddyCredential | undefined;
  account?: string | undefined;
}

function makeRuntime(options: FakeOptions = {}): {
  runtime: VariantRuntime;
  getFetchCalls: () => number;
  setAccount: (account: string | undefined) => void;
} {
  const root = tempDir();
  const catalog = new WorkBuddyCatalog([makeUpstreamModel({ id: "fallback-model", name: "Fallback" })]);
  const savedCatalogs = new CatalogStore({ path: join(root, "catalog.json") });
  const visibilityStore = new VisibilityStore({ path: join(root, "visibility.json") });
  let account = options.account;
  let fetchCalls = 0;

  const runtime = {
    variant: { id: "workbuddy", region: "cn" },
    catalog,
    savedCatalogs,
    visibilityStore,
    catalogMeta: { origin: "fallback" },
    credentials: {
      resolve: async () => {
        if (options.fetchError === "credential") throw new Error("no usable credential");
        return options.credential ?? makeCredential();
      },
      current: async () => options.credential ?? makeCredential(),
    },
    client: {
      lastCatalog: { fetchedAtMs: 42, source: "workbuddy:cli" },
      fetchModels: async () => {
        fetchCalls += 1;
        if (options.fetchError !== undefined && options.fetchError !== "credential") throw new Error(options.fetchError);
        return options.models ?? [makeUpstreamModel({ id: "live-model" })];
      },
    },
    account: () => account,
    noteCredential: (credential: WorkBuddyCredential | undefined) => {
      account = credential === undefined ? undefined : accountKeyOf(credential);
    },
    models: () => catalog.current().map((info) => toPiModel(info, { providerId: "workbuddy", region: "cn" })),
    observedFor: () => undefined,
  } as unknown as VariantRuntime;

  return { runtime, getFetchCalls: () => fetchCalls, setAccount: (next) => (account = next) };
}

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    ...overrides,
  } as RefreshModelsContext;
}

describe("refreshCatalog", () => {
  it("fetches live, publishes, and saves per account", async () => {
    const { runtime } = makeRuntime({ models: [makeUpstreamModel({ id: "live-model" })] });
    await refreshCatalog(runtime, makeContext());
    expect(runtime.catalogMeta).toMatchObject({ origin: "live", source: "workbuddy:cli" });
    expect(runtime.catalog.current().map((m) => m.id)).toEqual(["live-model"]);
    expect(runtime.savedCatalogs.get("user-1:")?.models.map((m) => m.id)).toEqual(["live-model"]);
  });

  it("degrades to the built-in fallback when nothing is saved and the fetch fails", async () => {
    const { runtime } = makeRuntime({ fetchError: "offline" });
    await refreshCatalog(runtime, makeContext());
    expect(runtime.catalogMeta.origin).toBe("fallback");
    expect(runtime.catalogMeta.error).toContain("offline");
    expect(runtime.catalog.current().map((m) => m.id)).toEqual(["fallback-model"]);
  });

  it("degrades to this account's saved catalog before the fallback", async () => {
    // First run: fetch succeeds and saves.
    const first = makeRuntime({ models: [makeUpstreamModel({ id: "live-model" })], account: "user-1:" });
    await refreshCatalog(first.runtime, makeContext());

    // Second run (offline) sharing the same state root must serve the saved list.
    const offline = makeRuntime({ fetchError: "offline", account: "user-1:" });
    offline.runtime.savedCatalogs = first.runtime.savedCatalogs;
    offline.runtime.catalogMeta = { origin: "fallback" };
    await refreshCatalog(offline.runtime, makeContext());
    expect(offline.runtime.catalogMeta.origin).toBe("saved");
    expect(offline.runtime.catalog.current().map((m) => m.id)).toEqual(["live-model"]);
  });

  it("skips the network entirely when the host forbids it", async () => {
    const { runtime, getFetchCalls } = makeRuntime();
    await refreshCatalog(runtime, makeContext({ allowNetwork: false }));
    expect(getFetchCalls()).toBe(0);
    expect(runtime.catalogMeta.origin).toBe("fallback");
  });

  it("keeps the previous list when the fetch fails mid-session", async () => {
    const { runtime } = makeRuntime({ models: [makeUpstreamModel({ id: "live-model" })] });
    await refreshCatalog(runtime, makeContext());
    // Switch the fake to failing; the live list must survive the failed refresh.
    (runtime.client.fetchModels as unknown as () => Promise<never>) = async () => {
      throw new Error("boom");
    };
    await refreshCatalog(runtime, makeContext());
    // The restore phase re-adopts the saved (== live) list; the fetch failure is recorded.
    expect(runtime.catalogMeta.origin).toBe("saved");
    expect(runtime.catalogMeta.error).toContain("boom");
  });

  it("records a credential failure as an error without touching the catalog", async () => {
    const { runtime } = makeRuntime({ fetchError: "credential", models: [] });
    await refreshCatalog(runtime, makeContext());
    expect(runtime.catalogMeta.origin).toBe("fallback");
    expect(runtime.catalogMeta.error).toContain("no usable credential");
  });
});

describe("filterByVisibility", () => {
  const model = toPiModel(makeUpstreamModel({ id: "glm-5.3" }), { providerId: "workbuddy", region: "cn" });

  it("hides everything when no account is in effect", async () => {
    const { runtime, setAccount } = makeRuntime({ account: undefined });
    expect(filterByVisibility(runtime, [model], undefined)).toEqual([]);
    setAccount("user-1:");
    // Even with a cached account, an empty visibility list keeps models visible.
    expect(filterByVisibility(runtime, [model], undefined)).toEqual([model]);
  });

  it("prefers the account named by the stored marker", async () => {
    const { runtime } = makeRuntime({ account: "user-1:" });
    runtime.visibilityStore.setVisible("user-2:", "glm-5.3", false);
    const marker = { type: "api_key", key: "workbuddy-desktop", env: { WORKBUDDY_ACCOUNT: "user-2:" } } as Credential;
    expect(filterByVisibility(runtime, [model], marker)).toEqual([]);
    // The other account is unaffected.
    const otherMarker = { type: "api_key", key: "workbuddy-desktop", env: { WORKBUDDY_ACCOUNT: "user-1:" } } as Credential;
    expect(filterByVisibility(runtime, [model], otherMarker)).toEqual([model]);
  });

  it("filters only the listing — hidden models stay resolvable in getModels", async () => {
    const { runtime } = makeRuntime({ account: "user-1:", models: [makeUpstreamModel({ id: "glm-5.3" })] });
    await refreshCatalog(runtime, makeContext());
    runtime.visibilityStore.setVisible("user-1:", "glm-5.3", false);
    expect(filterByVisibility(runtime, runtime.models(), undefined)).toEqual([]);
    expect(runtime.models().map((m) => m.id)).toEqual(["glm-5.3"]);
  });
});
