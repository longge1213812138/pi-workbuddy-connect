import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProbeAttempt, WorkBuddyCredential, WorkBuddyUpstreamModel } from "../src/core.ts";
import { runProbe, type ProbeRuntime } from "../src/probe.ts";
import { ProbeStore, accountKeyOf, fingerprintModel } from "../src/stores.ts";
import { makeCredential, makeReasoning, makeUpstreamModel, tempDir } from "./helpers.ts";

type Effort = string | undefined;

/**
 * Scripted probe sender. Classifies attempts exactly like the upstream shape:
 * `undefined` is the baseline, `probe_sentinel_*` is the sentinel, anything
 * else is a level sweep entry.
 */
function scriptedProbeRuntime(options: {
  models: readonly WorkBuddyUpstreamModel[];
  answer: (effort: Effort) => ProbeAttempt | Promise<ProbeAttempt>;
  region?: "cn" | "global";
  onAttempt?: (effort: Effort) => void;
  credential?: WorkBuddyCredential | undefined;
}): { runtime: ProbeRuntime; store: ProbeStore; calls: Effort[] } {
  const store = new ProbeStore({ path: join(tempDir(), "probe.json"), pluginVersion: "test" });
  const calls: Effort[] = [];
  let account: string | undefined = options.credential === undefined ? undefined : accountKeyOf(options.credential);
  const runtime: ProbeRuntime = {
    variant: { region: options.region ?? "cn" },
    catalog: { current: () => options.models },
    probeStore: store,
    credentials: { current: async () => options.credential },
    client: {
      probeEffort: async (_credential, _model, effort) => {
        calls.push(effort);
        options.onAttempt?.(effort);
        return options.answer(effort);
      },
    },
    account: () => account,
    noteCredential: (credential) => {
      account = credential === undefined ? undefined : accountKeyOf(credential);
    },
  };
  return { runtime, store, calls };
}

const accept = (): ProbeAttempt => ({ status: 200, streamed: true });
const rejectEffort = (errorCode = "invalid_reasoning_effort"): ProbeAttempt => ({
  status: 400,
  streamed: false,
  errorCode,
});

const probeModel = (over: Partial<NonNullable<WorkBuddyUpstreamModel["reasoning"]>> = {}) =>
  makeUpstreamModel({ id: "m1", reasoning: makeReasoning({ supportedEfforts: undefined, ...over }) });

describe("runProbe", () => {
  it("records a validating sweep with the accepted efforts", async () => {
    const { runtime, store, calls } = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: (effort) => {
        if (effort === undefined) return accept();
        if (effort.startsWith("probe_sentinel")) return rejectEffort();
        return effort === "low" || effort === "high" ? accept() : rejectEffort();
      },
    });
    const result = await runProbe(runtime, "m1", true);
    expect(result).toMatchObject({ state: "ok", validation: "validating", efforts: ["low", "high"], requests: 7 });
    expect(calls).toHaveLength(7);

    const info = runtime.catalog.current()[0];
    const record = store.get("m1", fingerprintModel(info), "user-1:");
    expect(record?.validation).toBe("validating");
    expect(record?.efforts).toEqual(["low", "high"]);
  });

  it("records non-validating when the upstream accepts the sentinel", async () => {
    const { runtime, store } = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: () => accept(),
    });
    const result = await runProbe(runtime, "m1", true);
    expect(result).toMatchObject({ state: "ok", validation: "non-validating", requests: 2 });
    expect(store.get("m1", fingerprintModel(runtime.catalog.current()[0]), "user-1:")?.validation).toBe("non-validating");
  });

  it("reads each region's own rejection vocabulary", async () => {
    // `model_param_invalid` is only a recognized effort rejection on `global`.
    const rejecting = (code: string) => (effort: Effort): ProbeAttempt =>
      effort === undefined ? accept() : rejectEffort(code);
    const cn = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: rejecting("model_param_invalid"),
    });
    expect(await runProbe(cn.runtime, "m1", true)).toMatchObject({ state: "unavailable" });

    const global = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      region: "global",
      answer: rejecting("model_param_invalid"),
    });
    expect(await runProbe(global.runtime, "m1", true)).toMatchObject({ state: "ok", validation: "validating" });
  });

  it("degrades to unknown when the baseline itself fails — never a capability claim", async () => {
    const { runtime, store } = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: () => ({ status: 500, streamed: false }),
    });
    const result = await runProbe(runtime, "m1", true);
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") expect(result.reason).toContain("baseline status 500");
    const record = store.get("m1", fingerprintModel(runtime.catalog.current()[0]), "user-1:");
    // The failure is recorded as `unknown` — stored for diagnostics, but it is
    // never a capability claim and contributes no efforts.
    expect(record?.validation).toBe("unknown");
    expect(record?.efforts).toEqual([]);
  });

  it("refuses without explicit consent and skips models that do not need detection", async () => {
    const noConsent = scriptedProbeRuntime({ models: [probeModel()], credential: makeCredential(), answer: () => accept() });
    expect(await runProbe(noConsent.runtime, "m1", false)).toMatchObject({ state: "unavailable" });
    expect(noConsent.calls).toHaveLength(0);

    const unknownModel = scriptedProbeRuntime({ models: [], credential: makeCredential(), answer: () => accept() });
    expect(await runProbe(unknownModel.runtime, "nope", true)).toMatchObject({ state: "unavailable" });

    const noReasoning = scriptedProbeRuntime({
      models: [makeUpstreamModel({ id: "m1" })],
      credential: makeCredential(),
      answer: () => accept(),
    });
    expect(await runProbe(noReasoning.runtime, "m1", true)).toMatchObject({ state: "unavailable" });

    const declared = scriptedProbeRuntime({
      models: [makeUpstreamModel({ id: "m1", reasoning: makeReasoning({ supportedEfforts: ["low"] }) })],
      credential: makeCredential(),
      answer: () => accept(),
    });
    expect(await runProbe(declared.runtime, "m1", true)).toMatchObject({ state: "unavailable" });

    const signedOut = scriptedProbeRuntime({ models: [probeModel()], credential: undefined, answer: () => accept() });
    expect(await runProbe(signedOut.runtime, "m1", true)).toMatchObject({ state: "unavailable" });
  });

  it("discards a result when the account changed mid-sweep", async () => {
    const { runtime, store, calls } = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: () => accept(),
      onAttempt: () => {
        // The user switches accounts while the sweep is in flight.
        runtime.noteCredential(makeCredential({ uid: "user-2" }));
      },
    });
    const result = await runProbe(runtime, "m1", true);
    expect(result).toMatchObject({ state: "unavailable" });
    if (result.state === "unavailable") expect(result.reason).toContain("account changed");
    expect(store.all()).toEqual({});
    expect(calls.length).toBeGreaterThan(0);
  });

  it("keeps one sweep per runtime — concurrent requests share the queue", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { runtime } = scriptedProbeRuntime({
      models: [probeModel()],
      credential: makeCredential(),
      answer: async (effort) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return effort === undefined ? accept() : rejectEffort();
      },
    });
    const first = runProbe(runtime, "m1", true);
    const second = runProbe(runtime, "m1", true);
    await Promise.all([first, second]);
    expect(maxInFlight).toBe(1);
  });
});
