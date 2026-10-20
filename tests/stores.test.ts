import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CatalogStore,
  ProbeStore,
  VisibilityStore,
  accountKeyOf,
  fingerprintModel,
  type ProbeRecord,
} from "../src/stores.ts";
import { makeCredential, makeUpstreamModel, tempDir } from "./helpers.ts";

describe("accountKeyOf", () => {
  it("keys by uid:enterpriseId", () => {
    expect(accountKeyOf(makeCredential())).toBe("user-1:");
    expect(accountKeyOf(makeCredential({ enterpriseId: "ent-9" }))).toBe("user-1:ent-9");
  });

  it("refuses to key credentials without a uid — those accounts share nothing", () => {
    expect(accountKeyOf(makeCredential({ uid: "" }))).toBeUndefined();
  });
});

describe("fingerprintModel", () => {
  it("is stable across display-only changes", () => {
    const a = makeUpstreamModel({ name: "GLM-5.3", contextWindow: 1000, billing: { credits: "x0.9", free: false } });
    const b = makeUpstreamModel({ name: "Renamed", contextWindow: 2000, billing: { credits: "x0.1", free: true, badges: ["限时免费"] } });
    expect(fingerprintModel(a)).toBe(fingerprintModel(b));
  });

  it("changes when the reasoning shape changes — that re-probes", () => {
    const a = makeUpstreamModel({ reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true } });
    const b = makeUpstreamModel({ reasoning: { supports: true, onlyReasoning: true, canDisableThinking: true } });
    expect(fingerprintModel(a)).not.toBe(fingerprintModel(b));
  });
});

describe("ProbeStore", () => {
  const record = (store: ProbeStore, over: Partial<ProbeRecord> = {}): ProbeRecord => ({
    fingerprint: "fp",
    validation: "validating",
    efforts: ["low", "high"],
    probedAtMs: Date.now(),
    pluginVersion: "test",
    account: "user-1:",
    ...over,
  });

  it("serves observations only to their own account and fingerprint", () => {
    const store = new ProbeStore({ path: join(tempDir(), "probe.json"), pluginVersion: "test" });
    store.set("m", record(store));
    expect(store.get("m", "fp", "user-1:")?.validation).toBe("validating");
    expect(store.get("m", "fp", "user-2:")).toBeUndefined();
    expect(store.get("m", "other-fp", "user-1:")).toBeUndefined();
  });

  it("expires observations past the TTL", () => {
    let now = 1_000_000;
    const store = new ProbeStore({ path: join(tempDir(), "probe.json"), pluginVersion: "test", now: () => now });
    store.set("m", record(store, { probedAtMs: now }));
    now += 14 * 24 * 60 * 60 * 1000 + 1;
    expect(store.get("m", "fp", "user-1:")).toBeUndefined();
  });

  it("never lets a transient unknown erase a decisive observation", () => {
    const store = new ProbeStore({ path: join(tempDir(), "probe.json"), pluginVersion: "test" });
    store.set("m", record(store));
    store.set("m", record(store, { validation: "unknown", efforts: [] }));
    expect(store.get("m", "fp", "user-1:")?.validation).toBe("validating");
    // A decisive answer does replace a decisive one.
    store.set("m", record(store, { validation: "non-validating", efforts: [] }));
    expect(store.get("m", "fp", "user-1:")?.validation).toBe("non-validating");
  });

  it("survives a reload and forgives a corrupt file", () => {
    const path = join(tempDir(), "probe.json");
    const store = new ProbeStore({ path, pluginVersion: "test" });
    store.set("m", record(store));
    const reloaded = new ProbeStore({ path, pluginVersion: "test" });
    expect(reloaded.get("m", "fp", "user-1:")?.efforts).toEqual(["low", "high"]);

    writeFileSync(path, "{ not json", "utf8");
    const afterCorrupt = new ProbeStore({ path, pluginVersion: "test" });
    expect(afterCorrupt.get("m", "fp", "user-1:")).toBeUndefined();
  });

  it("clear() drops every account's records", () => {
    const store = new ProbeStore({ path: join(tempDir(), "probe.json"), pluginVersion: "test" });
    store.set("m", record(store));
    store.set("m", record(store, { account: "user-2:" }));
    store.clear();
    expect(store.all()).toEqual({});
  });
});

describe("VisibilityStore", () => {
  it("hides and re-shows per account, removing empty entries", () => {
    const store = new VisibilityStore({ path: join(tempDir(), "visibility.json") });
    store.setVisible("user-1:", "glm-5.3", false);
    store.setVisible("user-1:", "hy3", false);
    store.setVisible("user-2:", "glm-5.3", false);
    expect(store.disabled("user-1:")).toEqual(["glm-5.3", "hy3"]);
    expect(store.disabled("user-2:")).toEqual(["glm-5.3"]);

    store.setVisible("user-1:", "glm-5.3", true);
    store.setVisible("user-1:", "hy3", true);
    expect(store.disabled("user-1:")).toEqual([]);
    // Re-showing the last hidden model drops the account entry entirely.
    expect(JSON.parse(readFileSync(store.filePath(), "utf8")).accounts["user-1:"]).toBeUndefined();
  });

  it("persists preferences across reloads", () => {
    const path = join(tempDir(), "visibility.json");
    const store = new VisibilityStore({ path });
    store.setVisible("user-1:", "glm-5.3", false);
    expect(new VisibilityStore({ path }).disabled("user-1:")).toEqual(["glm-5.3"]);
  });

  it("reads a corrupt file as nothing hidden", () => {
    const path = join(tempDir(), "visibility.json");
    writeFileSync(path, "not json at all", "utf8");
    expect(new VisibilityStore({ path }).disabled("user-1:")).toEqual([]);
  });
});

describe("CatalogStore", () => {
  it("keeps one saved catalog per account", () => {
    const store = new CatalogStore({ path: join(tempDir(), "catalog.json") });
    store.set("user-1:", { source: "workbuddy:cli", fetchedAtMs: 111, models: [makeUpstreamModel()] });
    store.set("user-2:", { source: "workbuddy-ai:app", fetchedAtMs: 222, models: [makeUpstreamModel({ id: "gpt-5.5" })] });
    expect(store.get("user-1:")?.models.map((m) => m.id)).toEqual(["glm-5.3"]);
    expect(store.get("user-2:")?.source).toBe("workbuddy-ai:app");

    store.delete("user-1:");
    expect(store.get("user-1:")).toBeUndefined();
  });

  it("survives a reload and forgives a corrupt file", () => {
    const path = join(tempDir(), "catalog.json");
    const store = new CatalogStore({ path });
    store.set("user-1:", { source: "live", fetchedAtMs: 5, models: [makeUpstreamModel()] });
    expect(new CatalogStore({ path }).get("user-1:")?.models).toHaveLength(1);

    writeFileSync(path, "{{{{", "utf8");
    expect(new CatalogStore({ path }).get("user-1:")).toBeUndefined();
  });
});
